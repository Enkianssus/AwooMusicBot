// Streamer queue actions are sent from a snapshot that can be a second old.
// Songs ending, 置顶 and 插队 shift positions in the meantime, so an index alone
// could act on another viewer's request. Clients that also send the identity
// they saw get that exact request; older index-only clients keep working.

export interface QueueActionExpectation {
  requestId?: unknown;
  id?: unknown;
  orderedByUid?: unknown;
}

export interface CurrentSongExpectation {
  requestId?: unknown;
  id?: unknown;
}

export type QueueActionTarget =
  | { ok: true; index: number }
  | { ok: false; message: string };

export const QUEUE_ITEM_MISSING_MESSAGE = '队列项不存在，请刷新后重试';
export const QUEUE_CHANGED_MESSAGE = '队列已变化，请刷新后重试';

interface RequestIdentity {
  requestId: string;
  id: string;
  orderedByUid: string;
}

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function fields(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function queuedIdentity(song: unknown): RequestIdentity {
  const source = fields(song);
  return {
    requestId: text(source.RequestId),
    id: text(source.Id),
    orderedByUid: text(source.OrderedByUid)
  };
}

function expectedIdentity(expected: unknown): RequestIdentity {
  const source = fields(expected);
  return {
    requestId: text(source.requestId),
    id: text(source.id),
    orderedByUid: text(source.orderedByUid)
  };
}

/** A request ID is exact; songs without one fall back to song and viewer. */
function isSameRequest(song: RequestIdentity, expected: RequestIdentity): boolean {
  if (song.requestId && expected.requestId) return song.requestId === expected.requestId;
  return Boolean(expected.id)
    && song.id === expected.id
    && song.orderedByUid === expected.orderedByUid;
}

/** Rejects strings such as '0' and fractions, which splice would coerce. */
export function isQueueIndex(value: unknown, length: number): value is number {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= 0 && value < length;
}

export function resolveQueueActionTarget(
  queue: readonly unknown[],
  index: unknown,
  expected?: unknown
): QueueActionTarget {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    return { ok: false, message: QUEUE_ITEM_MISSING_MESSAGE };
  }
  if (expected === undefined || expected === null) {
    return isQueueIndex(index, queue.length)
      ? { ok: true, index }
      : { ok: false, message: QUEUE_ITEM_MISSING_MESSAGE };
  }

  const wanted = expectedIdentity(expected);
  if (isQueueIndex(index, queue.length)
      && isSameRequest(queuedIdentity(queue[index]), wanted)) {
    return { ok: true, index };
  }
  // The request moved (or the queue shrank below the old index): find it again.
  if (wanted.requestId) {
    const exact = queue.findIndex(song => queuedIdentity(song).requestId === wanted.requestId);
    if (exact !== -1) return { ok: true, index: exact };
  }
  let nearest = -1;
  queue.forEach((song, candidate) => {
    if (!isSameRequest(queuedIdentity(song), wanted)) return;
    if (nearest === -1 || Math.abs(candidate - index) < Math.abs(nearest - index)) {
      nearest = candidate;
    }
  });
  return nearest === -1
    ? { ok: false, message: QUEUE_CHANGED_MESSAGE }
    : { ok: true, index: nearest };
}

export function matchesCurrentSong(current: unknown, expectedCurrent: unknown): boolean {
  const song = queuedIdentity(current);
  const wanted = expectedIdentity(expectedCurrent);
  if (song.requestId && wanted.requestId) return song.requestId === wanted.requestId;
  return Boolean(wanted.id) && song.id === wanted.id;
}
