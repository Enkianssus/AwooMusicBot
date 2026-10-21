import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { internalApiUrl } from './internal-api';
import { AwooMark, UiIcon } from './ui-icons';
import ReleaseNotes from './components/ReleaseNotes';
import {
    DISMISSED_ANNOUNCEMENTS_STORAGE_KEY,
    automaticAnnouncementMode,
    clampPercent,
    countPendingAnnouncements,
    describeConnectorProgress,
    describeDownloadedBytes,
    formatUpdateBytes,
    isCoreProgressVisible,
    isCoreUpdateActive,
    normalizeAnnouncementSnapshot,
    parseDismissedAnnouncementKeys,
    planAnnouncementDismissal,
    selectUpdateActions,
    selectVisibleAnnouncements,
    type AnnouncementSessionState,
    type ConnectorUpdateProgress,
    type CoreUpdateConfirmation,
    type UpdateAnnouncement,
    type UpdateAnnouncementSnapshot,
    type UpdateComponentId,
} from './update-announcement-policy';
import './update-announcements.css';

export type { ConnectorUpdateProgress, CoreUpdateConfirmation, UpdateAnnouncement, UpdateReceipt } from './update-announcement-policy';

export interface CoreUpdateProgressState {
    state: string;
    progress: number | null;
    message: string;
    sizeBytes?: number | null;
    /** The progress has not changed for about two minutes. */
    stalled?: boolean;
}

interface UpdateAnnouncementsProps {
    suspended?: boolean;
    openRequest?: number;
    /** Keeps the dialog open: a running connector update or the final core restart. */
    busy?: boolean;
    coreProgress?: CoreUpdateProgressState | null;
    connectorProgress?: Partial<Record<UpdateComponentId, ConnectorUpdateProgress | null>>;
    /** Set while the core update waits for the user to confirm the restart. */
    coreConfirmation?: CoreUpdateConfirmation | null;
    onCoreConfirmation?: (confirmed: boolean) => void;
    /** Pending updates for the navigation badge. */
    onSnapshot?: (count: number) => void;
    onCheckingChange?: (checking: boolean) => void;
    onCoreUpdate: (item: UpdateAnnouncement) => Promise<void>;
    onConnectorUpdate: (item: UpdateAnnouncement) => Promise<void>;
}

const sessionStorageKey = 'awoo-update-announcements-session';
const emptySession = (): AnnouncementSessionState => ({ updatesDismissed: false, dismissedReceiptIds: [] });

function readSession(sessionId: string): AnnouncementSessionState {
    try {
        // The admin window can be recreated while the backend app session remains alive.
        const stored = JSON.parse(localStorage.getItem(sessionStorageKey) || 'null');
        if (stored?.sessionId === sessionId) return {
            updatesDismissed: stored.updatesDismissed === true,
            dismissedReceiptIds: Array.isArray(stored.dismissedReceiptIds) ? stored.dismissedReceiptIds.filter((id: unknown) => typeof id === 'string') : [],
        };
    } catch { /* The in-memory session still prevents repeated prompts if storage is unavailable. */ }
    return emptySession();
}

function readDismissedKeys(): string[] {
    try {
        return parseDismissedAnnouncementKeys(localStorage.getItem(DISMISSED_ANNOUNCEMENTS_STORAGE_KEY));
    } catch {
        return [];
    }
}

function saveDismissedKeys(keys: string[]) {
    try {
        localStorage.setItem(DISMISSED_ANNOUNCEMENTS_STORAGE_KEY, JSON.stringify(keys));
    } catch { /* The badge keeps the in-memory list while the window is open. */ }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message.slice(0, 1000) : '操作失败，请重试。';
}

function displayVersion(version: string): string {
    return `v${version.replace(/^v/i, '')}`;
}

/** Shows the dialog as a modal unless it already is, and moves focus to its title. */
function presentDialog(dialog: HTMLDialogElement) {
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
}

/** The core update as the server reports it; shared by the dialog and the 版本升级 page. */
export function CoreUpdateProgress({ status, className = '' }: { status?: CoreUpdateProgressState | null; className?: string }) {
    if (!status || !isCoreProgressVisible(status.state)) return null;
    const failed = status.state === 'error';
    // The version check reports 0 without measuring anything, so it shows an indeterminate bar.
    const percent = failed || status.state === 'checking' ? null : clampPercent(status.progress);
    const bytes = status.state === 'downloading' ? describeDownloadedBytes(percent, status.sizeBytes) : null;
    const stallHint = status.stalled && !failed
        ? status.state === 'checking' ? '检查更新似乎停滞，可稍后重试' : '下载似乎停滞，可稍后重试'
        : '';
    return (
        <div className={`update-announcements-progress${failed ? ' is-error' : ''}${stallHint ? ' is-stalled' : ''}${className ? ` ${className}` : ''}`}>
            <div>
                <span role="status">{status.message || (failed ? '点歌机更新失败，请稍后重试' : '正在更新点歌机…')}</span>
                {percent !== null && <strong>{Math.round(percent)}%</strong>}
            </div>
            {!failed && <progress max={100} value={percent ?? undefined} aria-label="点歌机更新进度" />}
            {(bytes || stallHint) && (
                <p className="update-announcements-progress-detail">
                    {bytes && <span>{bytes}</span>}
                    {stallHint && <span role="status" className="update-announcements-stall">{stallHint}</span>}
                </p>
            )}
        </div>
    );
}

export default function UpdateAnnouncements({
    suspended = false,
    openRequest = 0,
    busy = false,
    coreProgress,
    connectorProgress,
    coreConfirmation = null,
    onCoreConfirmation,
    onSnapshot,
    onCheckingChange,
    onCoreUpdate,
    onConnectorUpdate,
}: UpdateAnnouncementsProps) {
    const [snapshot, setSnapshot] = useState<UpdateAnnouncementSnapshot | null>(null);
    const [open, setOpen] = useState(false);
    const [mode, setMode] = useState<'updates' | 'success'>('updates');
    const [checking, setChecking] = useState(false);
    const [requestError, setRequestError] = useState('');
    const [actionError, setActionError] = useState('');
    const [actionId, setActionId] = useState<string | null>(null);
    const [acknowledging, setAcknowledging] = useState(false);
    const [sessionRevision, setSessionRevision] = useState(0);
    const [dismissedKeys, setDismissedKeys] = useState<string[]>(readDismissedKeys);
    const dialogRef = useRef<HTMLDialogElement>(null);
    const confirmRef = useRef<HTMLDivElement>(null);
    const snapshotRef = useRef(snapshot);
    const dismissedKeysRef = useRef(dismissedKeys);
    const onSnapshotRef = useRef(onSnapshot);
    const onCheckingChangeRef = useRef(onCheckingChange);
    const mountedRef = useRef(false);
    const requestRef = useRef<AbortController | null>(null);
    const sessionRef = useRef<{ id: string; state: AnnouncementSessionState } | null>(null);
    const actionLockRef = useRef(false);
    const lastOpenRequestRef = useRef(0);
    const visibleRef = useRef(false);
    const titleId = useId();
    const descriptionId = useId();
    const confirmTitleId = useId();
    snapshotRef.current = snapshot;
    dismissedKeysRef.current = dismissedKeys;
    onSnapshotRef.current = onSnapshot;
    onCheckingChangeRef.current = onCheckingChange;

    const loadSnapshot = useCallback(async (refresh = false) => {
        if (requestRef.current && !refresh) return;
        requestRef.current?.abort();
        const controller = new AbortController();
        requestRef.current = controller;
        const timeout = window.setTimeout(() => controller.abort(), 30000);
        // Background polls keep the current content; only a manual check shows progress.
        if (refresh) setChecking(true);
        try {
            const response = await fetch(internalApiUrl(`/api/updates/announcements${refresh ? '?refresh=1' : ''}`), { cache: 'no-store', signal: controller.signal });
            if (!response.ok) throw new Error('检查更新失败，请稍后重试。');
            const next = normalizeAnnouncementSnapshot(await response.json());
            if (mountedRef.current && requestRef.current === controller) {
                setSnapshot(next);
                setRequestError('');
            }
        } catch (error) {
            if (mountedRef.current && requestRef.current === controller) {
                setRequestError(controller.signal.aborted ? '检查更新超时，请重试。' : errorMessage(error));
            }
        } finally {
            window.clearTimeout(timeout);
            if (requestRef.current === controller) {
                requestRef.current = null;
                if (mountedRef.current) setChecking(false);
            }
        }
    }, []);

    /** A snapshot started before an acknowledgement must not restore the acknowledged receipts. */
    const reloadAfterAcknowledgement = useCallback(() => {
        requestRef.current?.abort();
        requestRef.current = null;
        setChecking(false);
        return loadSnapshot();
    }, [loadSnapshot]);

    useEffect(() => {
        mountedRef.current = true;
        void loadSnapshot();
        const poll = window.setInterval(() => { void loadSnapshot(); }, 15000);
        const changed = (event: Event) => { void loadSnapshot((event as CustomEvent<{ refresh?: boolean } | null>).detail?.refresh === true); };
        window.addEventListener('awoo-updates-changed', changed);
        return () => {
            mountedRef.current = false;
            window.clearInterval(poll);
            window.removeEventListener('awoo-updates-changed', changed);
            requestRef.current?.abort();
            requestRef.current = null;
        };
    }, [loadSnapshot]);

    useEffect(() => {
        onCheckingChangeRef.current?.(checking);
    }, [checking]);

    useEffect(() => {
        if (snapshot) onSnapshotRef.current?.(countPendingAnnouncements(snapshot.items, dismissedKeys));
    }, [snapshot, dismissedKeys]);

    const openManually = useCallback((refresh = false) => {
        setMode(snapshotRef.current?.receipts.length ? 'success' : 'updates');
        setOpen(true);
        setActionError('');
        // When the browser closed the dialog by itself, `open` is still true and
        // setOpen(true) alone would not show it again.
        const dialog = dialogRef.current;
        if (visibleRef.current && dialog && !dialog.open) presentDialog(dialog);
        void loadSnapshot(refresh);
    }, [loadSnapshot]);

    useEffect(() => {
        const openFromEvent = (event: Event) => openManually((event as CustomEvent<{ refresh?: boolean } | null>).detail?.refresh === true);
        window.addEventListener('awoo-updates-open', openFromEvent);
        return () => window.removeEventListener('awoo-updates-open', openFromEvent);
    }, [openManually]);

    useEffect(() => {
        if (openRequest > 0 && openRequest !== lastOpenRequestRef.current) openManually();
        lastOpenRequestRef.current = openRequest;
    }, [openRequest, openManually]);

    useEffect(() => {
        if (!snapshot || suspended) return;
        if (sessionRef.current?.id !== snapshot.sessionId) sessionRef.current = { id: snapshot.sessionId, state: readSession(snapshot.sessionId) };
        const nextMode = automaticAnnouncementMode(snapshot, sessionRef.current.state);
        if (nextMode === 'success' || (nextMode && !open)) { setMode(nextMode); setOpen(true); }
    }, [snapshot, suspended, open, sessionRevision]);

    const saveSession = useCallback((dismissReceipts: boolean) => {
        const current = snapshotRef.current;
        if (!current) return;
        const previous = sessionRef.current?.id === current.sessionId ? sessionRef.current.state : readSession(current.sessionId);
        const next = {
            updatesDismissed: true,
            dismissedReceiptIds: dismissReceipts ? [...new Set([...previous.dismissedReceiptIds, ...current.receipts.map(receipt => receipt.id)])] : previous.dismissedReceiptIds,
        };
        sessionRef.current = { id: current.sessionId, state: next };
        try { localStorage.setItem(sessionStorageKey, JSON.stringify({ sessionId: current.sessionId, ...next })); } catch { /* Keep the in-memory state. */ }
        setSessionRevision(value => value + 1);
    }, []);

    const postAcknowledgement = useCallback(async (ids: string[]) => {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 15000);
        try {
            const response = await fetch(internalApiUrl('/api/updates/ack'), {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }), signal: controller.signal,
            });
            const result = await response.json();
            if (!response.ok || result.success !== true) throw new Error('未能保存确认状态，请重试。');
        } catch (error) {
            throw controller.signal.aborted ? new Error('保存确认状态超时，请点击“知道了”重试。') : error;
        } finally {
            window.clearTimeout(timeout);
        }
    }, []);

    const items = snapshot ? selectVisibleAnnouncements(snapshot.items) : [];
    const actionIds = new Set(selectUpdateActions(items).map(item => item.id));
    const receipts = snapshot?.receipts || [];
    const success = mode === 'success' && receipts.length > 0;
    const coreRunning = isCoreUpdateActive(coreProgress?.state);
    const operationBusy = busy || actionId !== null || acknowledging;
    // A core download continues in the background; starting it (or its confirmation) never keeps the dialog open.
    const dismissBlocked = busy || acknowledging || (actionId !== null && actionId !== 'core');
    const visible = open && !suspended;
    visibleRef.current = visible;
    const confirmationInCard = Boolean(coreConfirmation) && !success && items.some(item => item.id === 'core');

    const dismiss = () => {
        if (dismissBlocked) return;
        if (coreConfirmation) onCoreConfirmation?.(false);
        const plan = planAnnouncementDismissal(success ? 'success' : 'updates', snapshotRef.current, dismissedKeysRef.current);
        if (plan.dismissedKeys !== dismissedKeysRef.current) {
            setDismissedKeys(plan.dismissedKeys);
            saveDismissedKeys(plan.dismissedKeys);
        }
        // Saving the session dismissal first keeps the dialog closed even if the acknowledgement fails.
        saveSession(plan.acknowledgeIds.length > 0);
        setOpen(false);
        setActionError('');
        if (plan.acknowledgeIds.length > 0) {
            void postAcknowledgement(plan.acknowledgeIds).then(
                () => { if (mountedRef.current) void reloadAfterAcknowledgement(); },
                () => { /* Unacknowledged receipts are shown again on the next launch. */ },
            );
        }
    };

    useEffect(() => {
        const dialog = dialogRef.current;
        if (!dialog || !visible) return;
        const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        presentDialog(dialog);
        return () => {
            const focusInDialog = !document.activeElement || document.activeElement === document.body || dialog.contains(document.activeElement);
            if (dialog.open) dialog.close();
            if (focusInDialog && previousFocus?.isConnected) previousFocus.focus();
        };
    }, [visible]);

    useEffect(() => {
        // A hidden dialog cannot be answered, so the update it was asking about does not start.
        if (!visible && coreConfirmation) onCoreConfirmation?.(false);
    }, [visible, coreConfirmation, onCoreConfirmation]);

    useEffect(() => {
        if (!coreConfirmation) return;
        confirmRef.current?.focus();
        const dialog = dialogRef.current;
        return () => {
            // The panel is gone; keep focus inside the open dialog.
            if (dialog?.open && !dialog.contains(document.activeElement)) dialog.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
        };
    }, [coreConfirmation]);

    const update = async (item: UpdateAnnouncement) => {
        if (operationBusy || actionLockRef.current || !item.canUpdate || coreRunning) return;
        actionLockRef.current = true;
        setActionId(item.id);
        setActionError('');
        try {
            if (item.id === 'core') await onCoreUpdate(item);
            else await onConnectorUpdate(item);
        } catch (error) {
            if (mountedRef.current) setActionError(errorMessage(error));
        } finally {
            actionLockRef.current = false;
            if (mountedRef.current) { setActionId(null); await loadSnapshot(); }
        }
    };

    const acknowledge = async () => {
        if (operationBusy || actionLockRef.current || !snapshot) return;
        const ids = snapshot.receipts.map(receipt => receipt.id);
        if (ids.length === 0) { dismiss(); return; }
        actionLockRef.current = true;
        setAcknowledging(true);
        setActionError('');
        try {
            await postAcknowledgement(ids);
            if (!mountedRef.current) return;
            const current = snapshotRef.current || snapshot;
            const remaining = current.receipts.filter(receipt => !ids.includes(receipt.id));
            const visibleItems = selectVisibleAnnouncements(current.items);
            setSnapshot({ ...current, receipts: remaining, items: visibleItems });
            if (!remaining.length) {
                setMode('updates');
                if (!visibleItems.length) { saveSession(false); setOpen(false); }
            }
            await reloadAfterAcknowledgement();
        } catch (error) {
            if (mountedRef.current) setActionError(errorMessage(error));
        } finally {
            actionLockRef.current = false;
            if (mountedRef.current) setAcknowledging(false);
        }
    };

    const renderConfirmation = (confirmation: CoreUpdateConfirmation) => (
        <div className="update-announcements-confirm" ref={confirmRef} tabIndex={-1} role="group" aria-labelledby={confirmTitleId}>
            <strong id={confirmTitleId}>确认更新并重启点歌机？</strong>
            <ul>
                <li>目标版本：{confirmation.version ? displayVersion(confirmation.version) : '最新版本'}{confirmation.sizeBytes ? `，下载约 ${formatUpdateBytes(confirmation.sizeBytes)}` : ''}</li>
                <li className={confirmation.pendingCount === 0 ? '' : 'is-warning'}>
                    {confirmation.pendingCount === null
                        ? '暂时无法读取待播队列；重启后待播歌曲将被清空'
                        : confirmation.pendingCount > 0
                            ? `重启后待播的 ${confirmation.pendingCount} 首歌曲将被清空`
                            : '当前没有待播歌曲'}
                </li>
                <li>下载在后台进行，可以关闭此窗口；下载完成后点歌机会自动重启，并重新连接直播间。</li>
            </ul>
            <div className="update-announcements-confirm-actions">
                <button type="button" className="update-announcements-button update-announcements-secondary" onClick={() => onCoreConfirmation?.(false)}>取消</button>
                <button type="button" className="update-announcements-button update-announcements-primary" onClick={() => onCoreConfirmation?.(true)}>立即更新并重启</button>
            </div>
        </div>
    );

    const initialLoading = snapshot === null && !requestError;
    const incomplete = Boolean(requestError || snapshot?.errors.length);

    return <dialog className="update-announcements" ref={dialogRef} aria-labelledby={titleId} aria-describedby={descriptionId} aria-modal="true" onCancel={event => {
        event.preventDefault();
        // Escape first steps back from the restart confirmation.
        if (coreConfirmation) onCoreConfirmation?.(false);
        else dismiss();
    }} onClose={event => {
        // Chromium lets onCancel keep the dialog open only once per user interaction;
        // a repeated Escape closes it while `open` stays true. Reopen it while it
        // must stay open, otherwise follow the browser so it can be opened again.
        const dialog = event.currentTarget;
        if (dialog.open || !visible) return;
        if (dismissBlocked) presentDialog(dialog);
        else setOpen(false);
    }} onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]')].filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement as HTMLElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !focusable.includes(document.activeElement as HTMLElement))) { event.preventDefault(); first.focus(); }
    }}>
        <div className="update-announcements-shell">
            <header className="update-announcements-header">
                <span className="update-announcements-mark">{success ? <UiIcon name="check" /> : <AwooMark />}</span>
                <div className="update-announcements-heading">
                    <h2 id={titleId} tabIndex={-1} data-initial-focus>{success ? '更新成功' : '更新与公告'}</h2>
                    <p id={descriptionId}>{success ? '以下版本已安装完成' : items.length ? `发现 ${items.length} 项更新，查看说明后选择更新` : '查看点歌机和连接器的最新版本'}</p>
                </div>
                <button type="button" className="update-announcements-close" onClick={dismiss} disabled={dismissBlocked} aria-label="关闭更新公告"><UiIcon name="close" /></button>
            </header>
            <div className="update-announcements-body custom-scrollbar">
                {coreConfirmation && !confirmationInCard && renderConfirmation(coreConfirmation)}
                {success ? <div className="update-announcements-receipts">
                    {receipts.map(receipt => <article className="update-announcements-receipt" key={receipt.id}>
                        <span className="update-announcements-receipt-icon"><UiIcon name="check" /></span>
                        <div><h3>{receipt.name}</h3><p>{receipt.previousVersion && <><span>{displayVersion(receipt.previousVersion)}</span><span aria-label="更新到"> → </span></>}<strong>{displayVersion(receipt.version)}</strong></p></div>
                        <span className="update-announcements-badge">已更新</span>
                    </article>)}
                    {items.length > 0 && <p className="update-announcements-next">另有 {items.length} 项更新可用，确认后继续查看。</p>}
                </div> : <>
                    {items.map(item => {
                        const progress = item.id === 'core' ? null : describeConnectorProgress(connectorProgress?.[item.id]);
                        const updating = actionId === item.id || (item.id === 'core' && coreRunning);
                        return <article className="update-announcements-card" key={item.id}>
                            <div className="update-announcements-card-heading"><div><h3>{item.name}</h3><p className="update-announcements-version"><span>{item.currentVersion ? displayVersion(item.currentVersion) : '当前版本未知'}</span><UiIcon name="arrow" /><strong>{displayVersion(item.version)}</strong></p></div><span className="update-announcements-badge">{item.id === 'core' ? '点歌机' : '连接器'}</span></div>
                            <ReleaseNotes notes={item.notes} fallback="此版本暂未提供更新说明。" className="update-announcements-notes" />
                            {/* A rolled-back version is a retry, not a player-branch decision; its notes explain it. */}
                            {item.manualUpdate && !item.quarantined && <p className="update-announcements-compatibility"><UiIcon name="music" /><span>{item.supportedPlayerVersion ? `适配播放器 ${item.supportedPlayerVersion}，请确认本机播放器版本后再更新。` : '此更新涉及播放器版本分支，请确认本机播放器版本后再更新。'}</span></p>}
                            {!item.canUpdate && <p className="update-announcements-compatibility">{item.blockedReason || '当前环境暂不能直接更新，请到播放器设置查看详情。'}</p>}
                            {progress && <div className="update-announcements-progress">
                                <div><span role="status">正在{progress.label}</span>{progress.percent !== null && <strong>{progress.percent}%</strong>}</div>
                                <progress max={100} value={progress.percent ?? undefined} aria-label={`${item.name}更新进度`} />
                            </div>}
                            {item.id === 'core' && coreConfirmation && confirmationInCard ? renderConfirmation(coreConfirmation) : <div className="update-announcements-card-actions">
                                {item.notesUrl && <a href={item.notesUrl} target="_blank" rel="noopener noreferrer" tabIndex={operationBusy ? -1 : 0} aria-disabled={operationBusy} onClick={event => { if (operationBusy) event.preventDefault(); }}>完整更新说明 <UiIcon name="external" /></a>}
                                {actionIds.has(item.id) && <button type="button" className="update-announcements-button update-announcements-primary" disabled={operationBusy || checking || coreRunning} onClick={() => { void update(item); }}><UiIcon name="update" className={updating ? 'update-announcements-spinning' : ''} />{updating ? '正在更新…' : item.id === 'core' ? '更新点歌机' : `更新${item.name.replace(/连接器$/, '').trim()}`}</button>}
                            </div>}
                        </article>;
                    })}
                    {!items.length && !coreConfirmation && <div className="update-announcements-empty"><UiIcon name={initialLoading ? 'update' : incomplete ? 'radio' : 'check'} className={initialLoading ? 'update-announcements-spinning' : ''} /><strong>{initialLoading ? '正在读取更新信息' : incomplete ? '暂未获取到完整更新信息' : '当前没有可用更新'}</strong><p>{initialLoading ? '请稍候…' : incomplete ? '请检查网络后重新检查。' : '点歌机与已安装的连接器均无需更新。'}</p></div>}
                </>}
                <CoreUpdateProgress status={coreProgress} />
                {incomplete && <div className="update-announcements-error" role="status">{requestError && <p>{requestError}</p>}{snapshot?.errors.map((error, index) => <p key={index}>{error}</p>)}</div>}
                {actionError && <div className="update-announcements-error" role="alert">{actionError}</div>}
            </div>
            <footer className="update-announcements-footer">
                <button type="button" className="update-announcements-button update-announcements-secondary" disabled={operationBusy || checking} onClick={() => { void loadSnapshot(true); }}><UiIcon name="update" className={checking ? 'update-announcements-spinning' : ''} />{checking ? '正在检查…' : '检查更新'}</button>
                {success ? <button type="button" className="update-announcements-button update-announcements-primary" disabled={operationBusy} onClick={() => { void acknowledge(); }}>{acknowledging ? '正在确认…' : '知道了'}</button> : <button type="button" className="update-announcements-button update-announcements-secondary" disabled={dismissBlocked} onClick={dismiss}>{items.length ? '稍后再说' : '关闭'}</button>}
            </footer>
        </div>
    </dialog>;
}
