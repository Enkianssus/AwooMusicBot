import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { internalApiUrl } from './internal-api';
import { AwooMark, UiIcon } from './ui-icons';
import {
    automaticAnnouncementMode,
    normalizeAnnouncementSnapshot,
    selectUpdateActions,
    selectVisibleAnnouncements,
    type AnnouncementSessionState,
    type UpdateAnnouncement,
    type UpdateAnnouncementSnapshot,
} from './update-announcement-policy';
import './update-announcements.css';

export type { UpdateAnnouncement, UpdateReceipt } from './update-announcement-policy';

interface UpdateAnnouncementsProps {
    suspended?: boolean;
    openRequest?: number;
    busy?: boolean;
    coreProgress?: { state: string; progress: number | null; message: string } | null;
    onCoreUpdate: () => Promise<void>;
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

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message.slice(0, 1000) : '操作失败，请重试。';
}

export default function UpdateAnnouncements({ suspended = false, openRequest = 0, busy = false, coreProgress, onCoreUpdate, onConnectorUpdate }: UpdateAnnouncementsProps) {
    const [snapshot, setSnapshot] = useState<UpdateAnnouncementSnapshot | null>(null);
    const [open, setOpen] = useState(false);
    const [mode, setMode] = useState<'updates' | 'success'>('updates');
    const [checking, setChecking] = useState(false);
    const [loading, setLoading] = useState(false);
    const [requestError, setRequestError] = useState('');
    const [actionError, setActionError] = useState('');
    const [actionId, setActionId] = useState<string | null>(null);
    const [acknowledging, setAcknowledging] = useState(false);
    const [sessionRevision, setSessionRevision] = useState(0);
    const dialogRef = useRef<HTMLDialogElement>(null);
    const snapshotRef = useRef(snapshot);
    const mountedRef = useRef(false);
    const requestRef = useRef<AbortController | null>(null);
    const sessionRef = useRef<{ id: string; state: AnnouncementSessionState } | null>(null);
    const actionLockRef = useRef(false);
    const lastOpenRequestRef = useRef(0);
    const titleId = useId();
    const descriptionId = useId();
    snapshotRef.current = snapshot;

    const loadSnapshot = useCallback(async (refresh = false) => {
        if (requestRef.current && !refresh) return;
        requestRef.current?.abort();
        const controller = new AbortController();
        requestRef.current = controller;
        const timeout = window.setTimeout(() => controller.abort(), 30000);
        setLoading(true);
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
                if (mountedRef.current) { setLoading(false); setChecking(false); }
            }
        }
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        void loadSnapshot();
        const poll = window.setInterval(() => { void loadSnapshot(); }, 15000);
        const changed = () => { void loadSnapshot(); };
        window.addEventListener('awoo-updates-changed', changed);
        return () => {
            mountedRef.current = false;
            window.clearInterval(poll);
            window.removeEventListener('awoo-updates-changed', changed);
            requestRef.current?.abort();
            requestRef.current = null;
        };
    }, [loadSnapshot]);

    const openManually = useCallback(() => {
        setMode(snapshotRef.current?.receipts.length ? 'success' : 'updates');
        setOpen(true);
        setActionError('');
        void loadSnapshot();
    }, [loadSnapshot]);

    useEffect(() => {
        window.addEventListener('awoo-updates-open', openManually);
        return () => window.removeEventListener('awoo-updates-open', openManually);
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

    const operationBusy = busy || actionId !== null || acknowledging;
    const dismiss = useCallback(() => {
        if (operationBusy) return;
        saveSession(mode === 'success');
        setOpen(false);
        setActionError('');
    }, [operationBusy, saveSession, mode]);
    const visible = open && !suspended;

    useEffect(() => {
        const dialog = dialogRef.current;
        if (!dialog || !visible) return;
        const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        if (!dialog.open) dialog.showModal();
        dialog.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
        return () => {
            const focusInDialog = !document.activeElement || document.activeElement === document.body || dialog.contains(document.activeElement);
            if (dialog.open) dialog.close();
            if (focusInDialog && previousFocus?.isConnected) previousFocus.focus();
        };
    }, [visible]);

    const update = async (item: UpdateAnnouncement) => {
        if (operationBusy || actionLockRef.current || !item.canUpdate) return;
        actionLockRef.current = true;
        setActionId(item.id);
        setActionError('');
        try {
            if (item.id === 'core') await onCoreUpdate();
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
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 15000);
        try {
            const response = await fetch(internalApiUrl('/api/updates/ack'), {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }), signal: controller.signal,
            });
            const result = await response.json();
            if (!response.ok || result.success !== true) throw new Error('未能保存确认状态，请重试。');
            if (!mountedRef.current) return;
            // A snapshot started before acknowledgement must not restore acknowledged receipts.
            requestRef.current?.abort();
            requestRef.current = null;
            setLoading(false);
            setChecking(false);
            const current = snapshotRef.current || snapshot;
            const remaining = current.receipts.filter(receipt => !ids.includes(receipt.id));
            const items = selectVisibleAnnouncements(current.items);
            setSnapshot({ ...current, receipts: remaining, items });
            if (!remaining.length) {
                setMode('updates');
                if (!items.length) { saveSession(false); setOpen(false); }
            }
            await loadSnapshot();
        } catch (error) {
            if (mountedRef.current) setActionError(controller.signal.aborted ? '保存确认状态超时，请点击“知道了”重试。' : errorMessage(error));
        } finally {
            window.clearTimeout(timeout);
            actionLockRef.current = false;
            if (mountedRef.current) setAcknowledging(false);
        }
    };

    const items = snapshot ? selectVisibleAnnouncements(snapshot.items) : [];
    const actionIds = new Set(selectUpdateActions(items).map(item => item.id));
    const receipts = snapshot?.receipts || [];
    const success = mode === 'success' && receipts.length > 0;
    const progressVisible = coreProgress && ['checking', 'downloading', 'applying', 'error'].includes(coreProgress.state);
    const progress = coreProgress?.progress !== null && Number.isFinite(coreProgress?.progress) ? Math.max(0, Math.min(100, coreProgress!.progress!)) : null;

    return <dialog className="update-announcements" ref={dialogRef} aria-labelledby={titleId} aria-describedby={descriptionId} aria-modal="true" onCancel={event => { event.preventDefault(); dismiss(); }} onKeyDown={event => {
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
                <button type="button" className="update-announcements-close" onClick={dismiss} disabled={operationBusy} aria-label="关闭更新公告"><UiIcon name="close" /></button>
            </header>
            <div className="update-announcements-body custom-scrollbar">
                {success ? <div className="update-announcements-receipts">
                    {receipts.map(receipt => <article className="update-announcements-receipt" key={receipt.id}>
                        <span className="update-announcements-receipt-icon"><UiIcon name="check" /></span>
                        <div><h3>{receipt.name}</h3><p>{receipt.previousVersion && <><span>v{receipt.previousVersion.replace(/^v/i, '')}</span><span aria-label="更新到"> → </span></>}<strong>v{receipt.version.replace(/^v/i, '')}</strong></p></div>
                        <span className="update-announcements-badge">已更新</span>
                    </article>)}
                    {items.length > 0 && <p className="update-announcements-next">另有 {items.length} 项更新可用，确认后继续查看。</p>}
                </div> : <>
                    {items.map(item => <article className="update-announcements-card" key={item.id}>
                        <div className="update-announcements-card-heading"><div><h3>{item.name}</h3><p className="update-announcements-version"><span>{item.currentVersion ? `v${item.currentVersion.replace(/^v/i, '')}` : '当前版本未知'}</span><UiIcon name="arrow" /><strong>v{item.version.replace(/^v/i, '')}</strong></p></div><span className="update-announcements-badge">{item.id === 'core' ? '点歌机' : '连接器'}</span></div>
                        <div className="update-announcements-notes">{item.notes || '此版本暂未提供更新说明。'}</div>
                        {item.manualUpdate && <p className="update-announcements-compatibility"><UiIcon name="music" /><span>{item.supportedPlayerVersion ? `适配播放器 ${item.supportedPlayerVersion}，请确认本机播放器版本后再更新。` : '此更新涉及播放器版本分支，请确认本机播放器版本后再更新。'}</span></p>}
                        {!item.canUpdate && <p className="update-announcements-compatibility">{item.blockedReason || '当前环境暂不能直接更新，请到播放器设置查看详情。'}</p>}
                        <div className="update-announcements-card-actions">
                            {item.notesUrl && <a href={item.notesUrl} target="_blank" rel="noopener noreferrer" tabIndex={operationBusy ? -1 : 0} aria-disabled={operationBusy} onClick={event => { if (operationBusy) event.preventDefault(); }}>完整更新说明 <UiIcon name="external" /></a>}
                            {actionIds.has(item.id) && <button type="button" className="update-announcements-button update-announcements-primary" disabled={operationBusy || checking} onClick={() => { void update(item); }}><UiIcon name="update" className={actionId === item.id ? 'update-announcements-spinning' : ''} />{actionId === item.id ? '正在更新…' : item.id === 'core' ? '更新点歌机' : `更新${item.name.replace(/连接器$/, '').trim()}`}</button>}
                        </div>
                    </article>)}
                    {!items.length && <div className="update-announcements-empty"><UiIcon name={loading ? 'update' : requestError || snapshot?.errors.length ? 'radio' : 'check'} className={loading ? 'update-announcements-spinning' : ''} /><strong>{loading ? '正在读取更新信息' : requestError || snapshot?.errors.length ? '暂未获取到完整更新信息' : '当前没有可用更新'}</strong><p>{loading ? '请稍候…' : requestError || snapshot?.errors.length ? '请检查网络后重新检查。' : '点歌机与已安装的连接器均无需更新。'}</p></div>}
                </>}
                {progressVisible && <div className={`update-announcements-progress${coreProgress.state === 'error' ? ' is-error' : ''}`} role="status" aria-live="polite"><div><span>{coreProgress.message || '正在更新点歌机…'}</span>{progress !== null && coreProgress.state !== 'error' && <strong>{Math.round(progress)}%</strong>}</div>{coreProgress.state !== 'error' && <progress max={100} value={progress === null ? undefined : progress} aria-label="点歌机更新进度" />}</div>}
                {(requestError || Boolean(snapshot?.errors.length)) && <div className="update-announcements-error" role="status">{requestError && <p>{requestError}</p>}{snapshot?.errors.map((error, index) => <p key={index}>{error}</p>)}</div>}
                {actionError && <div className="update-announcements-error" role="alert">{actionError}</div>}
            </div>
            <footer className="update-announcements-footer">
                <button type="button" className="update-announcements-button update-announcements-secondary" disabled={operationBusy || checking} onClick={() => { void loadSnapshot(true); }}><UiIcon name="update" className={checking ? 'update-announcements-spinning' : ''} />{checking ? '正在检查…' : '检查更新'}</button>
                {success ? <button type="button" className="update-announcements-button update-announcements-primary" disabled={operationBusy} onClick={() => { void acknowledge(); }}>{acknowledging ? '正在确认…' : '知道了'}</button> : <button type="button" className="update-announcements-button update-announcements-secondary" disabled={operationBusy} onClick={dismiss}>{items.length ? '稍后再说' : '关闭'}</button>}
            </footer>
        </div>
    </dialog>;
}
