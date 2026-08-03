export interface ExternalSong {
  id: string;
  title: string;
  artist: string;
  album: string;
  coverUrl: string;
  requestedBy: string;
  requestedByUid: string;
  requestedByAvatar: string;
  guardLevel: number;
}

export interface ExternalPlayerState {
  key: string;
  name: string;
  connected: boolean;
  connecting: boolean;
  processId: number | null;
  version: string;
  status: string;
}

export interface ExternalServiceState {
  requestIntake: {
    enabled: boolean;
    state: 'accepting' | 'paused';
  };
  queuePlayback: {
    enabled: boolean;
    state: 'running' | 'paused';
  };
}

export interface ExternalApiState {
  schemaVersion: 1;
  appVersion: string;
  timestamp: string;
  player: ExternalPlayerState;
  current: ExternalSong | null;
  currentIsRequested: boolean;
  queue: ExternalSong[];
  queueLength: number;
  service: ExternalServiceState;
  /** @deprecated Use service.requestIntake.enabled. */
  accepting: boolean;
  /** @deprecated Use service.queuePlayback.enabled. */
  playing: boolean;
  pausedAfterRequests: boolean;
  commandQueue: {
    pending: number;
    processing: boolean;
  };
}

export interface BuildExternalApiStateInput {
  appVersion: string;
  timestamp?: string;
  player: ExternalPlayerState;
  currentSong: unknown;
  currentIsRequested: boolean;
  queue: unknown[];
  acceptingRequests: boolean;
  queuePlaybackEnabled: boolean;
  pausedAfterRequests: boolean;
  commandQueue: {
    pending: number;
    processing: boolean;
  };
}

type SongRecord = Record<string, unknown>;

function textField(song: SongRecord, field: string): string {
  const value = song[field];
  return value === null || value === undefined ? '' : String(value);
}

export function sanitizeExternalSong(song: unknown): ExternalSong | null {
  if (!song || typeof song !== 'object') return null;
  const source = song as SongRecord;
  const guardLevel = Number(source.GuardLevel);
  return {
    id: textField(source, 'Id'),
    title: textField(source, 'SongName'),
    artist: textField(source, 'ArtistName'),
    album: textField(source, 'Album'),
    coverUrl: textField(source, 'CoverUrl'),
    requestedBy: textField(source, 'OrderedBy'),
    requestedByUid: textField(source, 'OrderedByUid'),
    requestedByAvatar: textField(source, 'OrderedByAvatar'),
    guardLevel: Number.isFinite(guardLevel) ? guardLevel : 0
  };
}

export function buildExternalApiState(
  input: BuildExternalApiStateInput
): ExternalApiState {
  const queue = input.queue
    .map(sanitizeExternalSong)
    .filter((song): song is ExternalSong => song !== null);
  const service: ExternalServiceState = {
    requestIntake: {
      enabled: input.acceptingRequests,
      state: input.acceptingRequests ? 'accepting' : 'paused'
    },
    queuePlayback: {
      enabled: input.queuePlaybackEnabled,
      state: input.queuePlaybackEnabled ? 'running' : 'paused'
    }
  };

  return {
    schemaVersion: 1,
    appVersion: input.appVersion,
    timestamp: input.timestamp || new Date().toISOString(),
    player: input.player,
    current: sanitizeExternalSong(input.currentSong),
    currentIsRequested: input.currentIsRequested,
    queue,
    queueLength: queue.length,
    service,
    accepting: service.requestIntake.enabled,
    playing: service.queuePlayback.enabled,
    pausedAfterRequests: input.pausedAfterRequests,
    commandQueue: input.commandQueue
  };
}
