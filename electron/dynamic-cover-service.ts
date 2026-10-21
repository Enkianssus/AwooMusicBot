export type DynamicCoverDiagnosticKind = 'no-candidates' | 'http' | 'timeout' | 'parse' | 'hit' | 'miss';

/** Outcome of one finished lookup. An 'http' diagnostic without status is a network error. */
export interface DynamicCoverDiagnostic {
  kind: DynamicCoverDiagnosticKind;
  status?: number;
}

export interface DynamicCoverServiceOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  successTtlMs?: number;
  /** Definitive answers: no matching song, or no video for the matches. */
  failureTtlMs?: number;
  /** Timeouts, HTTP 429/5xx and network errors; never longer than failureTtlMs. */
  transientFailureTtlMs?: number;
  maxCacheEntries?: number;
  maxConcurrent?: number;
  onDiagnostic?: (diagnostic: DynamicCoverDiagnostic) => void;
}

interface SongIdentity {
  title: string;
  artist: string;
  key: string;
}

interface CacheEntry {
  url: string;
  expiresAt: number;
}

interface LookupJob extends SongIdentity {
  generation: number;
  promise: Promise<string>;
  resolve: (url: string) => void;
}

interface LookupOutcome {
  url: string;
  diagnostic: DynamicCoverDiagnostic;
  transient: boolean;
}

type LookupFailure = Omit<LookupOutcome, 'url'>;

const MEDIA_HOSTS = new Set([
  'mvod.itunes.apple.com',
  'video-ssl.itunes.apple.com',
  'vod-ak.itunes.apple.com',
]);
const MAX_QUEUE_LENGTH = 32;
const MAX_CANDIDATES = 5;

function bounded(value: number | undefined, fallback: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.min(Math.floor(value), maximum)) : fallback;
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2010-\u2015]/g, '-')
    .replace(/\s+/g, ' ').trim();
}

function songIdentity(title: string, artist: string): SongIdentity | undefined {
  if (typeof title !== 'string' || typeof artist !== 'string'
    || title.length > 512 || artist.length > 512) return;
  title = title.trim();
  artist = artist.trim();
  if (!title || !artist) return;
  return { title, artist, key: JSON.stringify([normalized(title), normalized(artist)]) };
}

function artistsMatch(requested: string, candidates: string[]): boolean {
  const actual = [...new Set(candidates.map(normalized).filter(Boolean))].sort();
  if (!actual.length) return false;
  const wanted = normalized(requested);
  // Preserve names such as AC/DC or Earth, Wind & Fire when they are a single artist.
  if (actual.length === 1 && wanted === actual[0]) return true;
  const parts = [...new Set(wanted.split(/\s*(?:\/|;|,|&|、|\band\b|\b(?:feat|ft)\.?(?=\s|$))\s*/)
    .map(part => part.trim()).filter(Boolean))].sort();
  return parts.length === actual.length && parts.every((part, index) => part === actual[index]);
}

function applePageUrl(value: string, kind: 'search' | 'album', base?: string): URL | undefined {
  try {
    const url = new URL(value, base);
    const path = kind === 'search' ? /^\/[a-z]{2}\/search\/?$/ : /^\/[a-z]{2}\/album\//;
    if (url.protocol === 'https:' && url.hostname === 'music.apple.com'
      && !url.port && !url.username && !url.password && path.test(url.pathname)) return url;
  } catch { /* Invalid URLs cannot be requested. */ }
}

function mediaUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && MEDIA_HOSTS.has(url.hostname)
      && !url.port && !url.username && !url.password && /\.(?:m3u8|mp4)$/i.test(url.pathname)) {
      return url.href;
    }
  } catch { /* Missing or unsupported videos use the original artwork. */ }
  return '';
}

function lookupError(message: string, diagnostic: DynamicCoverDiagnostic, transient = false): Error {
  return Object.assign(new Error(message), { lookupFailure: { diagnostic, transient } });
}

function httpError(status: number): Error {
  return lookupError('Unsupported dynamic cover page', { kind: 'http', status },
    status === 429 || status >= 500);
}

/** Timeouts, HTTP 429/5xx and network errors are transient and retried soon. */
function classifyFailure(error: unknown, timedOut: boolean): LookupFailure {
  if (timedOut) return { diagnostic: { kind: 'timeout' }, transient: true };
  const failure = (error as { lookupFailure?: LookupFailure } | null)?.lookupFailure;
  // fetch() rejects without a status for DNS, TLS, proxy and connection failures.
  return failure ?? { diagnostic: { kind: 'http' }, transient: true };
}

/** Also bounds injected fetch implementations or streams that do not honor AbortSignal. */
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => {});
    throw new Error('Dynamic cover lookup cancelled');
  }
  let onAbort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('Dynamic cover lookup cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/** Optional artwork enrichment; failures never affect the underlying playback state. */
export class DynamicCoverService {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly successTtlMs: number;
  private readonly failureTtlMs: number;
  private readonly transientFailureTtlMs: number;
  private readonly maxCacheEntries: number;
  private readonly maxConcurrent: number;
  private readonly onDiagnostic?: (diagnostic: DynamicCoverDiagnostic) => void;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<string>>();
  private readonly controllers = new Set<AbortController>();
  private queue: LookupJob[] = [];
  private active = 0;
  private generation = 0;
  private disposed = false;

  constructor(options: DynamicCoverServiceOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = bounded(options.timeoutMs, 10_000, 30_000);
    this.maxResponseBytes = bounded(options.maxResponseBytes, 2 * 1024 * 1024, 4 * 1024 * 1024);
    this.successTtlMs = bounded(options.successTtlMs, 6 * 60 * 60_000, 24 * 60 * 60_000);
    this.failureTtlMs = bounded(options.failureTtlMs, 10 * 60_000, 60 * 60_000);
    this.transientFailureTtlMs = Math.min(
      bounded(options.transientFailureTtlMs, 60_000, 10 * 60_000),
      this.failureTtlMs
    );
    this.maxCacheEntries = bounded(options.maxCacheEntries, 128, 128);
    this.maxConcurrent = bounded(options.maxConcurrent, 2, 2);
    this.onDiagnostic = options.onDiagnostic;
  }

  getCached(title: string, artist: string): string {
    const song = songIdentity(title, artist);
    return song ? this.cachedEntry(song.key)?.url ?? '' : '';
  }

  lookup(title: string, artist: string): Promise<string> {
    const song = songIdentity(title, artist);
    if (!song || this.disposed) return Promise.resolve('');
    const cached = this.cachedEntry(song.key);
    if (cached) return Promise.resolve(cached.url);
    const pending = this.pending.get(song.key);
    if (pending) return pending;
    if (this.queue.length >= MAX_QUEUE_LENGTH) return Promise.resolve('');

    let resolve!: (url: string) => void;
    const promise = new Promise<string>(done => { resolve = done; });
    this.pending.set(song.key, promise);
    this.queue.push({ ...song, generation: this.generation, promise, resolve });
    this.drain();
    return promise;
  }

  /** Cancels both running and queued requests; late responses cannot refill the cache. */
  clear(): void {
    this.generation++;
    this.cache.clear();
    this.pending.clear();
    for (const controller of this.controllers) controller.abort();
    for (const job of this.queue) job.resolve('');
    this.queue = [];
  }

  dispose(): void {
    this.disposed = true;
    this.clear();
  }

  private cachedEntry(key: string): CacheEntry | undefined {
    const entry = this.cache.get(key);
    if (!entry) return;
    this.cache.delete(key);
    if (entry.expiresAt <= this.now()) return;
    this.cache.set(key, entry);
    return entry;
  }

  private drain(): void {
    while (!this.disposed && this.active < this.maxConcurrent && this.queue.length) {
      const job = this.queue.shift()!;
      const controller = new AbortController();
      this.controllers.add(controller);
      this.active++;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.timeoutMs);
      void this.findVideo(job, controller.signal).catch((error): LookupOutcome => ({
        url: '', ...classifyFailure(error, timedOut),
      })).then(({ url, diagnostic, transient }) => {
        if (job.generation !== this.generation || this.disposed) {
          job.resolve('');
          return;
        }
        this.cache.set(job.key, {
          url,
          expiresAt: this.now() + (url ? this.successTtlMs
            : transient ? this.transientFailureTtlMs : this.failureTtlMs),
        });
        while (this.cache.size > this.maxCacheEntries) {
          this.cache.delete(this.cache.keys().next().value!);
        }
        this.report(diagnostic);
        job.resolve(url);
      }).finally(() => {
        clearTimeout(timer);
        this.controllers.delete(controller);
        if (this.pending.get(job.key) === job.promise) this.pending.delete(job.key);
        this.active--;
        this.drain();
      });
    }
  }

  private report(diagnostic: DynamicCoverDiagnostic): void {
    try {
      this.onDiagnostic?.(diagnostic);
    } catch { /* Diagnostics must never affect artwork. */ }
  }

  private async findVideo(song: SongIdentity, signal: AbortSignal): Promise<LookupOutcome> {
    const search = new URL('https://music.apple.com/cn/search');
    search.searchParams.set('term', `${song.title} - ${song.artist}`);
    const html = await this.fetchHtml(search, 'search', signal);
    // Loaded on first use. The htmlparser2-only entry keeps undici, parse5
    // and encoding-sniffer out of the main process startup path.
    const { load } = await import('cheerio/slim').catch(() => {
      throw lookupError('Dynamic cover parser unavailable', { kind: 'parse' });
    });
    const $ = load(html);
    const candidates = $('div[aria-label="歌曲"] li[data-index]').slice(0, MAX_CANDIDATES);
    // HTTP 200 without result rows: no such song, or Apple changed its markup.
    if (!candidates.length) return { url: '', diagnostic: { kind: 'no-candidates' }, transient: false };
    const visited = new Set<string>();
    let albumFailure: LookupFailure | undefined;
    for (const candidate of candidates.toArray()) {
      const row = $(candidate);
      const title = row.find('li.track-lockup__title a[href]').first();
      if (normalized(title.text()) !== normalized(song.title)) continue;
      const artists = row.find('li.track-lockup__subtitle a[href*="/artist/"]')
        .toArray().map(element => $(element).text());
      if (!artistsMatch(song.artist, artists)) continue;
      const url = applePageUrl(title.attr('href') ?? '', 'album', search.href);
      if (!url || visited.has(url.href)) continue;
      visited.add(url.href);
      try {
        const album = load(await this.fetchHtml(url, 'album', signal));
        const video = mediaUrl(album('amp-ambient-video').first().attr('src') ?? '');
        if (video) return { url: video, diagnostic: { kind: 'hit' }, transient: false };
      } catch (error) {
        // A failed edition must not hide another exact match, but cancellation is final.
        if (signal.aborted) throw error;
        const failure = classifyFailure(error, false);
        if (!albumFailure || failure.transient) albumFailure = failure;
      }
    }
    // An edition that failed transiently makes "no video" provisional.
    return { url: '', ...(albumFailure ?? { diagnostic: { kind: 'miss' }, transient: false }) };
  }

  private async fetchHtml(initial: URL, kind: 'search' | 'album', signal: AbortSignal): Promise<string> {
    let url = initial;
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (signal.aborted) throw new Error('Dynamic cover lookup cancelled');
      const response = await abortable(this.fetchImpl(url.href, {
        method: 'GET', credentials: 'omit', redirect: 'manual', signal,
        headers: { Accept: 'text/html', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7' },
      }), signal);
      const cancel = () => { void response.body?.cancel().catch(() => {}); };
      if (response.redirected || (response.url && !applePageUrl(response.url, kind))) {
        cancel();
        throw lookupError('Unexpected dynamic cover response location', { kind: 'http', status: response.status });
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = applePageUrl(response.headers.get('location') ?? '', kind, url.href);
        cancel();
        if (!next || redirects === 3) {
          throw lookupError('Unsupported dynamic cover redirect', { kind: 'http', status: response.status });
        }
        url = next;
        continue;
      }
      if (!response.ok) {
        cancel();
        throw httpError(response.status);
      }
      const length = Number(response.headers.get('content-length') || 0);
      const contentType = response.headers.get('content-type') || '';
      if (length > this.maxResponseBytes
        || (contentType && !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(contentType))) {
        cancel();
        throw lookupError('Unsupported dynamic cover page', { kind: 'parse' });
      }
      if (!response.body) return '';
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const pieces: string[] = [];
      let bytes = 0;
      try {
        let chunk = await abortable(reader.read(), signal);
        while (!chunk.done) {
          bytes += chunk.value.byteLength;
          if (bytes > this.maxResponseBytes) {
            throw lookupError('Dynamic cover page too large', { kind: 'parse' });
          }
          pieces.push(decoder.decode(chunk.value, { stream: true }));
          chunk = await abortable(reader.read(), signal);
        }
        pieces.push(decoder.decode());
        return pieces.join('');
      } catch (error) {
        void reader.cancel().catch(() => {});
        throw error;
      } finally {
        reader.releaseLock();
      }
    }
    return '';
  }
}
