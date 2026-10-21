// Queue buttons act on a /data snapshot that can be a second old. Songs ending,
// 置顶 and 插队 shift positions meanwhile, so each action also names the request
// the streamer saw. The server acts on that exact request, finds it again if it
// moved, or refuses when it is gone; older servers simply ignore the identity.

export interface QueueSongIdentity {
    RequestId?: unknown;
    Id: unknown;
    OrderedByUid: unknown;
}

export type QueueIndexAction = 'delete' | 'top' | 'play_now';
export type CurrentSongAction = 'skip_current' | 'push_current_to_queue';

export interface ExpectedQueueSong {
    requestId?: string;
    id: string;
    orderedByUid: string;
}

export interface ExpectedCurrentSong {
    requestId?: string;
    id: string;
}

export interface QueueIndexActionBody {
    action: QueueIndexAction;
    index: number;
    expected: ExpectedQueueSong;
}

export interface QueueReorderBody {
    action: 'reorder';
    from: number;
    to: number;
    expected: ExpectedQueueSong;
}

export interface CurrentSongActionBody {
    action: CurrentSongAction;
    expectedCurrent: ExpectedCurrentSong;
}

export type QueueActionBody = QueueIndexActionBody | QueueReorderBody | CurrentSongActionBody;

function requestIdOf(song: { RequestId?: unknown }): string {
    const value = song.RequestId;
    if (typeof value === 'string') return value;
    return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

export function expectedQueueSong(song: QueueSongIdentity): ExpectedQueueSong {
    const requestId = requestIdOf(song);
    const identity = { id: String(song.Id), orderedByUid: String(song.OrderedByUid) };
    return requestId ? { requestId, ...identity } : identity;
}

export function buildQueueActionBody(
    action: QueueIndexAction,
    index: number,
    song: QueueSongIdentity
): QueueIndexActionBody {
    return { action, index, expected: expectedQueueSong(song) };
}

export function buildReorderBody(
    from: number,
    to: number,
    song: QueueSongIdentity
): QueueReorderBody {
    return { action: 'reorder', from, to, expected: expectedQueueSong(song) };
}

export function buildCurrentActionBody(
    action: CurrentSongAction,
    current: Pick<QueueSongIdentity, 'RequestId' | 'Id'>
): CurrentSongActionBody {
    const requestId = requestIdOf(current);
    const id = String(current.Id);
    return { action, expectedCurrent: requestId ? { requestId, id } : { id } };
}

/**
 * React keys that follow each request through reorders: the RequestId when the
 * server sends one, otherwise song, viewer and how often that pair occurred
 * earlier in the queue, so the same song requested twice stays unique.
 */
export function queueRowKeys(queue: readonly QueueSongIdentity[]): string[] {
    const occurrences = new Map<string, number>();
    return queue.map(song => {
        const requestId = requestIdOf(song);
        const base = requestId || `${String(song.Id)}|${String(song.OrderedByUid)}`;
        const occurrence = occurrences.get(base) || 0;
        occurrences.set(base, occurrence + 1);
        if (!requestId) return `${base}|${occurrence}`;
        // RequestIds are unique; the suffix only guards against a duplicated entry.
        return occurrence === 0 ? requestId : `${requestId}|${occurrence}`;
    });
}
