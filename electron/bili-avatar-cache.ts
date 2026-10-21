const PLACEHOLDER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
  + '<rect width="64" height="64" rx="32" fill="#64748b"/>'
  + '<g fill="#fff"><path d="M26 20l18-5v6l-18 5z"/>'
  + '<rect x="26" y="20" width="3" height="23"/><rect x="41" y="15" width="3" height="23"/>'
  + '<ellipse cx="23" cy="43" rx="6" ry="4.5"/><ellipse cx="38" cy="38" rx="6" ry="4.5"/></g></svg>';

/** Local music-note avatar; viewer UIDs are never sent to a third-party image service. */
export const AVATAR_PLACEHOLDER = `data:image/svg+xml,${encodeURIComponent(PLACEHOLDER_SVG)}`;

export interface AvatarCacheOptions {
  /** Resolves the avatar URL, or '' when the account has none or lookup fails. */
  fetchAvatar(uid: string): Promise<string>;
  maxEntries?: number;
  ttlMs?: number;
  /** Failed lookups are retried sooner than successful ones expire. */
  failureTtlMs?: number;
  now?: () => number;
}

export interface AvatarCache {
  get(uid: string): Promise<string>;
  peek(uid: string): string | undefined;
}

interface AvatarEntry {
  url: string;
  expiresAt: number;
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value) : fallback;
}

function cacheKey(uid: unknown): string {
  const key = String(uid ?? '').trim();
  return key === '0' ? '' : key;
}

/**
 * Bounded LRU of viewer avatars with in-flight deduplication. Danmaku bursts
 * from one viewer share a single lookup instead of one request per command.
 */
export function createAvatarCache(options: AvatarCacheOptions): AvatarCache {
  const maxEntries = positive(options.maxEntries, 512);
  const ttlMs = positive(options.ttlMs, 60 * 60_000);
  const failureTtlMs = Math.min(positive(options.failureTtlMs, 60_000), ttlMs);
  const now = options.now ?? Date.now;
  const entries = new Map<string, AvatarEntry>();
  const pending = new Map<string, Promise<string>>();

  function remember(key: string, url: string): void {
    entries.delete(key);
    entries.set(key, {
      url: url || AVATAR_PLACEHOLDER,
      expiresAt: now() + (url ? ttlMs : failureTtlMs)
    });
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (typeof oldest !== 'string') break;
      entries.delete(oldest);
    }
  }

  function peek(uid: string): string | undefined {
    const key = cacheKey(uid);
    if (!key) return AVATAR_PLACEHOLDER;
    const entry = entries.get(key);
    if (!entry) return undefined;
    entries.delete(key);
    if (entry.expiresAt <= now()) return undefined;
    entries.set(key, entry);
    return entry.url;
  }

  function get(uid: string): Promise<string> {
    const key = cacheKey(uid);
    const cached = peek(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const inFlight = pending.get(key);
    if (inFlight) return inFlight;

    const lookup = (async () => {
      let url = '';
      try {
        const value = await options.fetchAvatar(key);
        url = typeof value === 'string' ? value.trim() : '';
      } catch { /* A missing avatar must never fail the request it decorates. */ }
      remember(key, url);
      return url || AVATAR_PLACEHOLDER;
    })();
    pending.set(key, lookup);
    void lookup.finally(() => {
      if (pending.get(key) === lookup) pending.delete(key);
    });
    return lookup;
  }

  return { get, peek };
}
