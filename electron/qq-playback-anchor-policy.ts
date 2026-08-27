/**
 * QQ Music reports a distinct failure when it has not played a song since
 * launch.  Its native "insert next" operation has no playback cursor in that
 * state and would otherwise place the request at the head of the playlist.
 * Keep this policy independent from Electron so the host state transitions
 * can be tested without starting a player or a window.
 */
export const QQ_PLAYBACK_ANCHOR_MISSING_FAILURE_CODE =
  'qq-playback-anchor-missing';

export interface QqAnchorObservationOptions {
  playerKey: string;
  /** Only the connector can confirm that the native playback cursor exists. */
  playbackAnchorReady: boolean;
  deferredIdentity: string;
  queueHeadIdentity: string;
  retryAttempted: boolean;
  retryInFlight: boolean;
}

export type QqAnchorObservationAction = 'none' | 'clear' | 'retry';

/**
 * Action taken when the first real QQ playback anchor becomes available.
 *
 * The old implementation called this a "retry" because it retried
 * InsertNext.  A cold QQ player has no reliable playlist cursor before that
 * observation, though, so InsertNext can still land at the playlist head.
 * The host must instead take over the deferred request with its interrupt
 * transaction.  Keep the older observation action exported for callers that
 * only need to decide whether the deferred identity is stale; this narrower
 * policy makes the new takeover contract explicit and testable.
 */
export type QqDeferredPlaybackAction = 'none' | 'takeover-now';

export function planQqDeferredPlaybackAction(
  options: QqAnchorObservationOptions
): QqDeferredPlaybackAction {
  return planQqAnchorObservation(options) === 'retry'
    ? 'takeover-now'
    : 'none';
}

/**
 * A normal request must stay local until QQ confirms a real playback cursor.
 * This is intentionally strict: an omitted/unknown field is not proof that
 * the anchor exists, and other players are unaffected.
 */
export function shouldDeferQqQueueHeadUntilAnchor(options: {
  playerKey: string;
  playbackAnchorReady: boolean;
}): boolean {
  return options.playerKey === 'qqmusic'
    && options.playbackAnchorReady !== true;
}

/**
 * Decide what to do when a new current-track observation arrives.
 *
 * A missing anchor is only a QQ-specific, one-shot deferral.  A stale
 * deferred identity must be discarded before it can affect the current queue
 * head, and a retry is allowed only after a real current track is observed.
 */
export function planQqAnchorObservation(
  options: QqAnchorObservationOptions
): QqAnchorObservationAction {
  if (!options.deferredIdentity) return 'none';
  if (
    options.playerKey !== 'qqmusic'
    || options.queueHeadIdentity !== options.deferredIdentity
  ) {
    return 'clear';
  }
  if (
    options.playbackAnchorReady !== true
    || options.retryAttempted
    || options.retryInFlight
  ) {
    return 'none';
  }
  return 'retry';
}

/**
 * While QQ still has no current track, do not repeatedly call InsertNext for
 * the same deferred queue head.  Once a track exists, the observation path
 * owns the single retry instead.
 */
export function shouldSkipDuplicateQqAnchorInsert(options: {
  playerKey: string;
  songIdentity: string;
  deferredIdentity: string;
  playbackAnchorReady: boolean;
  retryAttempted: boolean;
  retryInFlight: boolean;
}): boolean {
  return options.playerKey === 'qqmusic'
    && Boolean(options.songIdentity)
    && options.songIdentity === options.deferredIdentity
    && (
      options.playbackAnchorReady !== true
      || options.retryAttempted
      || options.retryInFlight
    );
}

/**
 * Do not fall back to PlaySelected while the cold-start request is deferred:
 * this applies both before a current track exists and after the one retry has
 * started or failed.  Playing the request immediately is exactly the
 * cold-start path that can consume the wrong native playlist item.
 */
export function shouldSuppressQqQueueHeadPlayNow(options: {
  playerKey: string;
  queueHeadIdentity: string;
  deferredIdentity: string;
  playbackAnchorReady: boolean;
  retryAttempted: boolean;
  retryInFlight: boolean;
}): boolean {
  return options.playerKey === 'qqmusic'
    && Boolean(options.queueHeadIdentity)
    && options.queueHeadIdentity === options.deferredIdentity
    && (
      options.playbackAnchorReady !== true
      || options.retryAttempted
      || options.retryInFlight
    );
}

/**
 * Match only the connector's explicit QQ cold-start failure on InsertNext.
 * Other command failures retain their existing recovery behavior.
 */
export function isQqPlaybackAnchorMissing(options: {
  playerKey: string;
  command: string;
  failureCode?: unknown;
}): boolean {
  return options.playerKey === 'qqmusic'
    && options.command === 'InsertNext'
    && String(options.failureCode || '')
      === QQ_PLAYBACK_ANCHOR_MISSING_FAILURE_CODE;
}
