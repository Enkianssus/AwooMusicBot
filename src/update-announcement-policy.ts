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
    supportedPlayerVersion?: string;
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

const componentIds: UpdateComponentId[] = ['core', 'netease', 'kugou', 'qqmusic', 'folia'];
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

export function automaticAnnouncementMode(snapshot: UpdateAnnouncementSnapshot, session: AnnouncementSessionState): 'success' | 'updates' | null {
    if (snapshot.receipts.some(receipt => !session.dismissedReceiptIds.includes(receipt.id))) return 'success';
    if (!session.updatesDismissed && selectVisibleAnnouncements(snapshot.items).length > 0) return 'updates';
    return null;
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
        items.push({
            id, name, version,
            currentVersion: text(item.currentVersion, 100) || null,
            notes: text(item.notes, 20000),
            notesUrl: safeReleaseNotesUrl(item.notesUrl),
            canUpdate: item.canUpdate === true,
            blockedReason: text(item.blockedReason, 1000) || undefined,
            manualUpdate: item.manualUpdate === true,
            supportedPlayerVersion: text(item.supportedPlayerVersion, 100) || undefined,
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
