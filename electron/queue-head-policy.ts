export interface QueueSongLike {
  Id?: unknown;
  SongName?: unknown;
  PlayerKey?: unknown;
}

export type QueueHeadMutationAction =
  | 'none'
  | 'insert'
  | 'arm-only'
  | 'cancel-native';

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
