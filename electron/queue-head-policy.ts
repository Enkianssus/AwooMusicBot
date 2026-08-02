export interface QueueSongLike {
  Id?: unknown;
  SongName?: unknown;
  ArtistName?: unknown;
  PlayerKey?: unknown;
  id?: unknown;
  title?: unknown;
  artist?: unknown;
}

export type QueueHeadMutationAction =
  | 'none'
  | 'insert'
  | 'arm-only'
  | 'cancel-native';

export type NextObservation =
  | 'legacy'
  | 'unknown'
  | 'track'
  | 'empty';

export type ObservedNextAction = 'none' | 'arm-only' | 'insert';

export type ImmediatePlaybackMode = 'play-now' | 'interrupt';

export type ImmediatePlaybackCommand =
  | 'PlaySelected'
  | 'InterruptSelected';

export function queueSongIdentity(
  song: QueueSongLike | null | undefined,
  fallbackPlayerKey: string
): string {
  if (!song) return '';
  const playerKey = String(song.PlayerKey || fallbackPlayerKey);
  const id = String(song.Id || '').trim();
  if (id) return `${playerKey}|id:${id}`;
  return `${playerKey}|title:${String(song.SongName || '').trim()}`;
}

function readTrackField(
  song: QueueSongLike,
  primary: keyof QueueSongLike,
  secondary: keyof QueueSongLike
): string {
  return String(song[primary] || song[secondary] || '').trim();
}

function normalizeTrackText(value: unknown): string {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[、，,;&；·•]+/g, '/')
    .replace(/\s+/g, '')
    .replace(/\/+$/g, '');
}

/**
 * Matches a queue item with an observed player track. Some native players
 * temporarily report title/artist-derived IDs while metadata caches catch up,
 * so an ID mismatch must not prevent a song that is already playing from
 * leaving the request queue.
 */
export function tracksRepresentSameSong(
  expected: QueueSongLike | null | undefined,
  observed: QueueSongLike | null | undefined
): boolean {
  if (!expected || !observed) return false;

  const expectedId = readTrackField(expected, 'Id', 'id');
  const observedId = readTrackField(observed, 'Id', 'id');
  if (expectedId && observedId && expectedId === observedId) return true;
  if (
    isStableTrackId(expectedId)
    && isStableTrackId(observedId)
    && expectedId !== observedId
  ) {
    return false;
  }

  const expectedTitle = normalizeTrackText(
    readTrackField(expected, 'SongName', 'title')
  );
  const observedTitle = normalizeTrackText(
    readTrackField(observed, 'SongName', 'title')
  );
  if (!expectedTitle || expectedTitle !== observedTitle) return false;

  const expectedArtist = normalizeTrackText(
    readTrackField(expected, 'ArtistName', 'artist')
  );
  const observedArtist = normalizeTrackText(
    readTrackField(observed, 'ArtistName', 'artist')
  );
  return !expectedArtist
    || !observedArtist
    || expectedArtist === observedArtist;
}

function isStableTrackId(value: string): boolean {
  return Boolean(value)
    && value.length <= 128
    && !value.includes('|');
}

/**
 * A title-derived fallback key contains a pipe and may later be replaced by a
 * real platform ID without representing a track transition. Two different
 * stable platform IDs, however, are an authoritative transition even when the
 * title and artist happen to be identical. This matters for queue advancement:
 * treating that transition as a metadata-only update can leave the played
 * request at the queue head and make it play repeatedly.
 */
export function tracksHaveDifferentStableIds(
  previous: QueueSongLike | null | undefined,
  next: QueueSongLike | null | undefined
): boolean {
  if (!previous || !next) return false;
  const previousId = readTrackField(previous, 'Id', 'id');
  const nextId = readTrackField(next, 'Id', 'id');
  return isStableTrackId(previousId)
    && isStableTrackId(nextId)
    && previousId !== nextId;
}

/**
 * Connectors may expose the player's real sequential next item. Repair the
 * native queue only when a local head exists and that observation is missing
 * or different. Metadata fallback handles short-lived title-derived IDs.
 */
export function shouldRepairObservedNext(
  expected: QueueSongLike | null | undefined,
  observedNext: QueueSongLike | null | undefined,
  nextObservation: NextObservation = 'legacy'
): boolean {
  if (!expected) return false;
  if (observedNext) {
    return !tracksRepresentSameSong(expected, observedNext);
  }

  // QQ Music currently cannot enumerate its native play queue. Treating that
  // absence as a confirmed mismatch causes the same logical request to be
  // submitted through AddSongs repeatedly. Legacy connectors keep the former
  // repair behavior until they explicitly report the observation as unknown.
  return nextObservation !== 'unknown';
}

export function planObservedNextAction(options: {
  expected: QueueSongLike | null | undefined;
  observedNext: QueueSongLike | null | undefined;
  nextObservation: NextObservation;
  preserveInsertedHead: boolean;
  expectedAlreadyGuarded: boolean;
}): ObservedNextAction {
  if (!options.expected) return 'none';
  if (options.preserveInsertedHead) return 'arm-only';
  if (
    options.nextObservation === 'unknown'
    && !options.observedNext
  ) {
    return options.expectedAlreadyGuarded ? 'none' : 'insert';
  }
  return shouldRepairObservedNext(
    options.expected,
    options.observedNext,
    options.nextObservation
  )
    ? 'insert'
    : 'none';
}

/**
 * QQ Music needs a different interrupt transaction from ordinary immediate
 * play. It first moves to the previous native item, inserts the requested
 * song there, and advances into it so the displaced current song remains
 * directly behind the interrupt target.
 */
export function planImmediatePlaybackCommand(options: {
  playerKey: string;
  mode: ImmediatePlaybackMode;
  hasCurrentSong: boolean;
}): ImmediatePlaybackCommand {
  return options.playerKey === 'qqmusic'
    && options.mode === 'interrupt'
    && options.hasCurrentSong
    ? 'InterruptSelected'
    : 'PlaySelected';
}

/**
 * Track changes produced inside a managed player transaction are intermediate
 * implementation details. Only the transaction's final target is allowed to
 * drive queue advancement; an unrelated observation is reconciled after the
 * transaction expires or fails.
 */
export function shouldDeferManagedTrackObservation(
  target: QueueSongLike | null | undefined,
  observed: QueueSongLike | null | undefined
): boolean {
  return Boolean(target)
    && Boolean(observed)
    && !tracksRepresentSameSong(target, observed);
}

export function shouldPreserveGuardAfterImmediate(options: {
  command: ImmediatePlaybackCommand;
  hadRegisteredGuard: boolean;
  hasDisplacedCurrentSong: boolean;
}): boolean {
  if (options.command === 'InterruptSelected') {
    return options.hasDisplacedCurrentSong;
  }
  return options.hadRegisteredGuard;
}

export function planQueueHeadMutation(options: {
  previousHeadIdentity: string;
  nextHeadIdentity: string;
  hadRegisteredNext: boolean;
  isPlaying: boolean;
}): QueueHeadMutationAction {
  const {
    previousHeadIdentity,
    nextHeadIdentity,
    hadRegisteredNext,
    isPlaying
  } = options;

  if (previousHeadIdentity === nextHeadIdentity) {
    return 'none';
  }
  if (!isPlaying) {
    if (!hadRegisteredNext) return 'none';
    return nextHeadIdentity ? 'arm-only' : 'cancel-native';
  }
  if (!hadRegisteredNext) {
    return nextHeadIdentity ? 'insert' : 'none';
  }
  return nextHeadIdentity ? 'arm-only' : 'cancel-native';
}
