interface CoverLookup {
  lookup(title: string, artist: string): Promise<string>;
  getCached(title: string, artist: string): string;
}

interface CoverSong {
  SongName?: unknown;
  ArtistName?: unknown;
  DynamicCoverUrl?: string;
}

export interface DynamicCoverOptions {
  /** false only reads cached results, for snapshots that never render artwork. */
  lookup?: boolean;
}

/** Enrich only the displayed song; never mutate playback or queue objects. */
export function withDynamicCover<T extends CoverSong>(
  song: T | null | undefined,
  enabled: unknown,
  service: CoverLookup,
  { lookup = true }: DynamicCoverOptions = {}
): (T & { DynamicCoverUrl: string }) | null {
  if (!song) return null;
  if (enabled === false) return { ...song, DynamicCoverUrl: '' };

  const title = String(song.SongName || '').trim();
  const artist = String(song.ArtistName || '').trim();
  if (!title || !artist || title === '未知歌曲' || artist === '未知歌手') {
    return { ...song, DynamicCoverUrl: '' };
  }

  // lookup deduplicates in-flight requests and caches misses as well as hits.
  // Each snapshot reads its own key, so a late result cannot replace a new song.
  if (lookup) void service.lookup(title, artist).catch(() => {});
  return { ...song, DynamicCoverUrl: service.getCached(title, artist) };
}

export interface LookupDebouncer {
  shouldLookup(key: string, now: number): boolean;
}

/**
 * Allows a lookup only after one song has stayed current for delayMs, so
 * tracks skipped in quick succession are never sent to Apple Music.
 */
export function createLookupDebouncer(delayMs = 2_000): LookupDebouncer {
  let currentKey = '';
  let currentSince = 0;
  return {
    shouldLookup(key: string, now: number): boolean {
      if (key !== currentKey) {
        currentKey = key;
        currentSince = now;
      }
      return Boolean(key) && now - currentSince >= delayMs;
    }
  };
}
