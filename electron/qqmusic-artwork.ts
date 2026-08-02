export interface QqArtworkTrackLike {
  title?: unknown;
  artist?: unknown;
  album?: unknown;
  coverUrl?: unknown;
}

function normalizeTitle(value: unknown): string {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
}

function normalizeArtists(value: unknown): string[] {
  return String(value || '')
    .normalize('NFKC')
    .split(/[\u3001\uFF0C,/&;\uFF1B]+/u)
    .map(artist => artist.trim().toLowerCase().replace(/\s+/g, ' '))
    .filter(Boolean)
    .sort();
}

function representsSameSong(
  expected: QqArtworkTrackLike,
  candidate: QqArtworkTrackLike
): boolean {
  const expectedTitle = normalizeTitle(expected.title);
  const candidateTitle = normalizeTitle(candidate.title);
  if (!expectedTitle || expectedTitle !== candidateTitle) return false;

  const expectedArtists = normalizeArtists(expected.artist);
  const candidateArtists = normalizeArtists(candidate.artist);
  return expectedArtists.length > 0
    && expectedArtists.length === candidateArtists.length
    && expectedArtists.every(
      (artist, index) => artist === candidateArtists[index]
    );
}

export function selectQqArtworkCover(
  track: QqArtworkTrackLike,
  candidates: QqArtworkTrackLike[]
): string {
  const existing = String(track.coverUrl || '').trim();
  if (existing) return existing;

  const title = normalizeTitle(track.title);
  return candidates
    .filter(candidate =>
      Boolean(String(candidate.coverUrl || '').trim())
      && representsSameSong(track, candidate))
    .sort((left, right) => {
      const leftAlbumMatches = normalizeTitle(left.album) === title;
      const rightAlbumMatches = normalizeTitle(right.album) === title;
      return Number(rightAlbumMatches) - Number(leftAlbumMatches);
    })
    .map(candidate => String(candidate.coverUrl || '').trim())
    .find(Boolean) || '';
}
