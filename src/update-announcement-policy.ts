export type UpdateComponentId = 'core' | 'netease' | 'kugou' | 'qqmusic' | 'folia';

export interface UpdateAnnouncement {
    id: UpdateComponentId;
    name: string;
    currentVersion: string | null;
    version: string;
    notes: string;
    notesUrl: string | null;
    canUpdate: boolean;
    blockedReason?: string;
    manualUpdate: boolean;
    /**
     * This connector version failed to connect on this computer and was rolled
     * back. It is offered only as a manual retry; its notes explain why.
     */
    quarantined?: boolean;
    supportedPlayerVersion?: string;
    /** Package size, when the server reports it; shown before the core update starts. */
    sizeBytes?: number;
}

export interface UpdateReceipt {
    id: string;
    componentId?: UpdateComponentId;
    name: string;
    version: string;
    previousVersion: string | null;
    completedAt: string;
}

export interface UpdateAnnouncementSnapshot {
    sessionId: string;
    items: UpdateAnnouncement[];
    receipts: UpdateReceipt[];
    errors: string[];
}

export interface AnnouncementSessionState {
    updatesDismissed: boolean;
    dismissedReceiptIds: string[];
}

export type ConnectorProgressPhase = 'runtime' | 'download' | 'verify' | 'install' | 'restart';

export interface ConnectorUpdateProgress {
    phase: ConnectorProgressPhase;
    percent: number | null;
    updatedAt?: string;
}

/** What the in-dialog confirmation shows before the core update restarts the app. */
export interface CoreUpdateConfirmation {
    version: string | null;
    sizeBytes: number | null;
    /** Pending requests in the queue; null when the queue could not be read. */
    pendingCount: number | null;
}

/** When the core progress last changed, for the stall hint. */
export interface CoreProgressMark {
    state: string;
    progress: number | null;
    changedAt: number;
}

export const DISMISSED_ANNOUNCEMENTS_STORAGE_KEY = 'awoo-update-announcements-dismissed';
export const CORE_UPDATE_STALL_MS = 120_000;

const MAX_DISMISSED_ANNOUNCEMENTS = 40;
const componentIds: UpdateComponentId[] = ['core', 'netease', 'kugou', 'qqmusic', 'folia'];
const coreActiveStates = ['checking', 'downloading', 'applying'];
const coreProgressStates = [...coreActiveStates, 'error'];
const connectorPhaseLabels: Record<ConnectorProgressPhase, string> = {
    runtime: '准备运行环境',
    download: '下载',
    verify: '校验',
    install: '安装',
    restart: '重启连接器',
};
const text = (value: unknown, limit: number) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const versionKey = (value: string | null) => (value || '').trim().replace(/^v/i, '');

function compareVersions(left: string, right: string): number | null {
    if (!/^\d+(\.\d+)*$/.test(left) || !/^\d+(\.\d+)*$/.test(right)) return null;
    const a = left.split('.').map(Number);
    const b = right.split('.').map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0) ? 1 : -1;
    }
    return 0;
}

export function safeReleaseNotesUrl(value: unknown): string | null {
    try {
        const url = new URL(text(value, 2048));
        return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
    } catch {
        return null;
    }
}

/** The backend decides compatibility. The renderer also removes stale/same-version candidates. */
export function selectVisibleAnnouncements(items: UpdateAnnouncement[]): UpdateAnnouncement[] {
    const selected = new Map<UpdateComponentId, UpdateAnnouncement>();
    for (const item of items) {
        const next = versionKey(item.version);
        const current = versionKey(item.currentVersion);
        const comparison = compareVersions(next, current);
        if (!next || next === current || (current && comparison !== null && comparison <= 0)) continue;
        const previous = selected.get(item.id);
        if (!previous || compareVersions(next, versionKey(previous.version)) === 1) selected.set(item.id, item);
    }
    return [...selected.values()].sort((a, b) => componentIds.indexOf(a.id) - componentIds.indexOf(b.id));
}

export function selectUpdateActions(items: UpdateAnnouncement[]): UpdateAnnouncement[] {
    return selectVisibleAnnouncements(items).filter(item => item.canUpdate);
}

/** Only an update that installs without a player-branch decision opens the dialog on its own. */
export function opensAutomatically(item: UpdateAnnouncement): boolean {
    return item.canUpdate && !item.manualUpdate;
}

/** Manual player-branch and blocked items wait for the user; dismissing one version lasts across launches. */
export function needsPersistentDismissal(item: UpdateAnnouncement): boolean {
    return !item.canUpdate || item.manualUpdate;
}

export function automaticAnnouncementMode(snapshot: UpdateAnnouncementSnapshot, session: AnnouncementSessionState): 'success' | 'updates' | null {
    if (snapshot.receipts.some(receipt => !session.dismissedReceiptIds.includes(receipt.id))) return 'success';
    if (!session.updatesDismissed && selectVisibleAnnouncements(snapshot.items).some(opensAutomatically)) return 'updates';
    return null;
}

export function announcementDismissalKey(item: Pick<UpdateAnnouncement, 'id' | 'version'>): string {
    return `${item.id}@${versionKey(item.version)}`;
}

export function parseDismissedAnnouncementKeys(raw: string | null): string[] {
    try {
        const stored: unknown = JSON.parse(raw || '[]');
        if (!Array.isArray(stored)) return [];
        const keys = stored.filter((key): key is string => typeof key === 'string' && /^[a-z]+@\S{1,100}$/.test(key));
        return [...new Set(keys)].slice(-MAX_DISMISSED_ANNOUNCEMENTS);
    } catch {
        return [];
    }
}

/** Adds the visible manual and blocked versions; the newest dismissals are kept. */
export function rememberDismissedAnnouncements(previous: string[], items: UpdateAnnouncement[]): string[] {
    const keys = selectVisibleAnnouncements(items).filter(needsPersistentDismissal).map(announcementDismissalKey);
    if (keys.every(key => previous.includes(key))) return previous;
    return [...previous.filter(key => !keys.includes(key)), ...keys].slice(-MAX_DISMISSED_ANNOUNCEMENTS);
}

/** The badge counts installable updates, plus manual and blocked ones until that version is dismissed. */
export function countPendingAnnouncements(items: UpdateAnnouncement[], dismissedKeys: string[]): number {
    return selectVisibleAnnouncements(items)
        .filter(item => opensAutomatically(item) || !dismissedKeys.includes(announcementDismissalKey(item)))
        .length;
}

export interface AnnouncementDismissalPlan {
    /** Receipts the close button acknowledges, exactly as “知道了” does. */
    acknowledgeIds: string[];
    dismissedKeys: string[];
}

/** Closing the success view acknowledges its receipts; closing the update list remembers manual and blocked versions. */
export function planAnnouncementDismissal(view: 'updates' | 'success', snapshot: UpdateAnnouncementSnapshot | null, dismissedKeys: string[]): AnnouncementDismissalPlan {
    if (!snapshot) return { acknowledgeIds: [], dismissedKeys };
    if (view === 'success') return { acknowledgeIds: snapshot.receipts.map(receipt => receipt.id), dismissedKeys };
    return { acknowledgeIds: [], dismissedKeys: rememberDismissedAnnouncements(dismissedKeys, snapshot.items) };
}

export function isCoreUpdateActive(state: unknown): boolean {
    return typeof state === 'string' && coreActiveStates.includes(state);
}

/** Progress, including a failure, is shown until the next attempt; idle and no-update states show nothing. */
export function isCoreProgressVisible(state: unknown): boolean {
    return typeof state === 'string' && coreProgressStates.includes(state);
}

export function clampPercent(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

/** Formats in the unit of `unitOf`, so a downloaded amount reads in the same unit as the total. */
export function formatUpdateBytes(bytes: number, unitOf = bytes): string {
    const value = Math.max(0, bytes);
    if (unitOf >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
    if (unitOf >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
    return `${Math.round(value / 1024)} KB`;
}

/** “已下载 52.3 MB / 160.4 MB” when the package size is known. */
export function describeDownloadedBytes(progress: unknown, sizeBytes: unknown): string | null {
    const size = typeof sizeBytes === 'number' ? sizeBytes : Number.NaN;
    const percent = clampPercent(progress);
    if (!Number.isFinite(size) || size <= 0 || percent === null) return null;
    return `已下载 ${formatUpdateBytes(size * percent / 100, size)} / ${formatUpdateBytes(size)}`;
}

/** Keeps the time of the last change; repeated polls with the same value do not reset it. */
export function trackCoreUpdateProgress(previous: CoreProgressMark | null, status: { state: string; progress: unknown }, now: number): CoreProgressMark {
    const progress = clampPercent(status.progress);
    if (previous && previous.state === status.state && previous.progress === progress) return previous;
    return { state: status.state, progress, changedAt: now };
}

export function isCoreUpdateStalled(mark: CoreProgressMark | null, now: number, limitMs = CORE_UPDATE_STALL_MS): boolean {
    return Boolean(mark && (mark.state === 'checking' || mark.state === 'downloading') && now - mark.changedAt >= limitMs);
}

export function normalizeConnectorProgress(value: unknown): ConnectorUpdateProgress | null {
    if (!value || typeof value !== 'object') return null;
    const source = value as Record<string, unknown>;
    const phase = source.phase as ConnectorProgressPhase;
    if (!Object.prototype.hasOwnProperty.call(connectorPhaseLabels, phase)) return null;
    const percent = clampPercent(source.percent);
    return {
        phase,
        percent: percent === null ? null : Math.round(percent),
        ...(typeof source.updatedAt === 'string' ? { updatedAt: source.updatedAt } : {}),
    };
}

/** “下载 45%”, or the phase alone while its share is unknown. */
export function describeConnectorProgress(value: unknown): { label: string; percent: number | null; text: string } | null {
    const progress = normalizeConnectorProgress(value);
    if (!progress) return null;
    const label = connectorPhaseLabels[progress.phase];
    return { label, percent: progress.percent, text: progress.percent === null ? label : `${label} ${progress.percent}%` };
}

export function normalizeAnnouncementSnapshot(value: unknown): UpdateAnnouncementSnapshot {
    const source = value as Record<string, unknown> | null;
    if (!source || source.success !== true || !text(source.sessionId, 200) || !Array.isArray(source.items) || !Array.isArray(source.receipts)) {
        throw new Error('暂时无法读取更新信息，请重试。');
    }
    const items: UpdateAnnouncement[] = [];
    for (const entry of source.items.slice(0, 30)) {
        if (!entry || typeof entry !== 'object') continue;
        const item = entry as Record<string, unknown>;
        const id = item.id as UpdateComponentId;
        const version = text(item.version, 100);
        const name = text(item.name, 100);
        if (!componentIds.includes(id) || !version || !name) continue;
        const sizeBytes = typeof item.sizeBytes === 'number' && Number.isFinite(item.sizeBytes) && item.sizeBytes > 0 ? item.sizeBytes : undefined;
        items.push({
            id, name, version,
            currentVersion: text(item.currentVersion, 100) || null,
            notes: text(item.notes, 20000),
            notesUrl: safeReleaseNotesUrl(item.notesUrl),
            canUpdate: item.canUpdate === true,
            blockedReason: text(item.blockedReason, 1000) || undefined,
            manualUpdate: item.manualUpdate === true,
            ...(item.quarantined === true ? { quarantined: true } : {}),
            supportedPlayerVersion: text(item.supportedPlayerVersion, 100) || undefined,
            ...(sizeBytes ? { sizeBytes } : {}),
        });
    }
    const receipts = new Map<string, UpdateReceipt>();
    for (const entry of source.receipts.slice(0, 100)) {
        if (!entry || typeof entry !== 'object') continue;
        const receipt = entry as Record<string, unknown>;
        const id = text(receipt.id, 200);
        const name = text(receipt.name, 100);
        const version = text(receipt.version, 100);
        if (!id || !name || !version) continue;
        receipts.set(id, {
            id, name, version,
            componentId: componentIds.includes(receipt.componentId as UpdateComponentId) ? receipt.componentId as UpdateComponentId : undefined,
            previousVersion: text(receipt.previousVersion, 100) || null,
            completedAt: text(receipt.completedAt, 100),
        });
    }
    return {
        sessionId: text(source.sessionId, 200), items, receipts: [...receipts.values()],
        errors: Array.isArray(source.errors) ? source.errors.map(error => text(error, 1000)).filter(Boolean).slice(0, 8) : [],
    };
}
