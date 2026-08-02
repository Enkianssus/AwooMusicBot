export type LocalSongRequestMode =
  | 'normal'
  | 'top'
  | 'interrupt'
  | 'play_now';

export function normalizeLocalSongRequestMode(
  value: unknown
): LocalSongRequestMode | null {
  switch (String(value || 'normal').trim().toLowerCase()) {
    case 'normal':
    case 'queue':
      return 'normal';
    case 'top':
    case 'priority':
      return 'top';
    case 'interrupt':
    case 'insert':
      return 'interrupt';
    case 'play_now':
    case 'play-now':
    case 'immediate':
      return 'play_now';
    default:
      return null;
  }
}

export function normalizeLocalSongKeyword(value: unknown): string | null {
  const keyword = typeof value === 'string' ? value.trim() : '';
  return keyword && keyword.length <= 200 ? keyword : null;
}

export function isLoopbackRemoteAddress(value: unknown): boolean {
  const address = String(value || '').trim().toLowerCase();
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1'
    || /^::ffff:0*7f00:0*1$/.test(address);
}
