import type {
  PlayerOperationResult,
  PlayerSnapshot,
  PlayerTrack
} from '../player-bridge-client';
import type { NextObservation } from '../queue-head-policy';

export type PlayerKey = 'netease' | 'kugou' | 'qqmusic' | 'folia';

export type PlayerCommand =
  | 'Previous'
  | 'Pause'
  | 'Resume'
  | 'Next'
  | 'InsertNext'
  | 'ArmNextGuard'
  | 'InterruptSelected'
  | 'PlaySelected';

export interface PlayerSongInput {
  Id?: string | number;
  SongName?: string;
  ArtistName?: string;
  Album?: string;
  NativeData?: string;
  CoverUrl?: string;
}

export interface PlayerBackend {
  readonly key: PlayerKey;
  readonly label: string;
  readonly usesNativeBridge: boolean;

  activate(): Promise<PlayerSnapshot>;
  deactivate(): void;
  probe(): Promise<PlayerSnapshot>;
  search(query: string): Promise<PlayerTrack[]>;
  execute(
    command: PlayerCommand,
    track?: PlayerTrack
  ): Promise<PlayerOperationResult>;
}

export interface PlayerConnectionState {
  connected: boolean;
  connecting: boolean;
  snapshot: PlayerSnapshot | null;
}

export interface PlayerTrackObservation {
  track: PlayerTrack | null;
  nextTrack?: PlayerTrack | null;
  nextObservation: NextObservation;
  coverUrl?: string;
  nextDescription: string;
}

export const PLAYER_LABELS: Record<PlayerKey, string> = {
  netease: '网易云音乐',
  kugou: '酷狗音乐',
  qqmusic: 'QQ 音乐',
  folia: 'Folia'
};

export function playerKeyFromConfig(playerType: unknown): PlayerKey {
  switch (playerType) {
    case 'Kugou': return 'kugou';
    case 'QQMusic': return 'qqmusic';
    case 'Folia': return 'folia';
    default: return 'netease';
  }
}

export function toPlayerTrack(song: PlayerSongInput): PlayerTrack {
  return {
    id: String(song?.Id || ''),
    title: song?.SongName || '',
    artist: song?.ArtistName || '',
    album: song?.Album || '',
    nativeData: song?.NativeData || '',
    coverUrl: song?.CoverUrl || ''
  };
}

export function isSuccessfulPlayerResult(
  result: PlayerOperationResult | null | undefined
): boolean {
  return Boolean(
    result
    && ['accepted', 'applied', 'verified', 'indeterminate'].includes(
      String(result.outcome).toLowerCase()
    )
  );
}

export type {
  PlayerOperationResult,
  PlayerSnapshot,
  PlayerTrack
};
