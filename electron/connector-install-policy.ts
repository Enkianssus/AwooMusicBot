/**
 * Pure decisions for the connector installer. This module has no Electron or
 * file system dependency so the policies can be exercised directly in tests.
 */

export type ConnectorDownloadErrorKind =
  | 'network'
  | 'http'
  | 'size'
  | 'hash'
  | 'signature';

/**
 * A failed or corrupted package download. Only this error type justifies
 * retrying the same signed asset from another source; health-check,
 * extraction and activation failures would fail again with identical bytes.
 */
export class ConnectorDownloadError extends Error {
  readonly kind: ConnectorDownloadErrorKind;
  readonly status?: number;

  constructor(
    kind: ConnectorDownloadErrorKind,
    message: string,
    status?: number
  ) {
    super(message);
    this.name = 'ConnectorDownloadError';
    this.kind = kind;
    this.status = status;
  }
}

/** Checks the name so errors created in another vm realm are recognized. */
export function isConnectorDownloadError(
  error: unknown
): error is ConnectorDownloadError {
  return typeof error === 'object'
    && error !== null
    && (error as { name?: unknown }).name === 'ConnectorDownloadError';
}

/** Timeouts, rate limits and server errors can succeed on a later attempt. */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export interface ReinstallCircuitBreakerOptions {
  /** Minimum time between two automatic reinstalls of the same key. */
  windowMs?: number;
  /** Maximum automatic reinstalls of the same key per process. */
  sessionLimit?: number;
}

export interface ReinstallCircuitBreaker {
  allow(key: string, now: number): boolean;
  record(key: string, now: number): void;
}

/**
 * Caps automatic repairs of one connector version, so an executable that is
 * blocked on every launch cannot cause an endless download loop.
 */
export function createReinstallCircuitBreaker({
  windowMs = 10 * 60 * 1000,
  sessionLimit = 3
}: ReinstallCircuitBreakerOptions = {}): ReinstallCircuitBreaker {
  const attempts = new Map<string, { count: number; lastAt: number }>();
  return {
    allow(key, now) {
      const previous = attempts.get(key);
      if ((previous?.count ?? 0) >= sessionLimit) return false;
      return !previous || now - previous.lastAt >= windowMs;
    },
    record(key, now) {
      const previous = attempts.get(key);
      attempts.set(key, { count: (previous?.count ?? 0) + 1, lastAt: now });
    }
  };
}

export interface FailureMemo<T = Error> {
  get(key: string, now: number): T | null;
  set(key: string, error: T, now: number): void;
  clear(key: string): void;
}

/** Remembers a recent failure so fast retry loops repeat it without new work. */
export function createFailureMemo<T = Error>(ttlMs: number): FailureMemo<T> {
  const failures = new Map<string, { error: T; expiresAt: number }>();
  return {
    get(key, now) {
      const failure = failures.get(key);
      if (!failure) return null;
      if (now >= failure.expiresAt) {
        failures.delete(key);
        return null;
      }
      return failure.error;
    },
    set(key, error, now) {
      failures.set(key, { error, expiresAt: now + ttlMs });
    },
    clear(key) {
      failures.delete(key);
    }
  };
}

export interface AutomaticReinstallStatus {
  error: string | null;
  compatible: boolean;
  manualUpdateAvailable: boolean;
  latestVersion: string | null;
  minimumCoreVersion: string | null;
}

/**
 * An automatic reinstall passes the normal update checks and is refused
 * while the catalog is unavailable, the latest connector needs a newer core
 * or it starts a new player branch. Returns that reason, or null when a
 * reinstall can run.
 */
export function describeAutomaticReinstallBlocker(
  status: AutomaticReinstallStatus | null | undefined
): string | null {
  if (!status) return '未找到连接器更新状态';
  if (status.error) return `更新检查失败：${status.error}`;
  if (!status.compatible) {
    return `连接器 ${status.latestVersion} 要求嗷呜点歌机 `
      + `${status.minimumCoreVersion} 或更高版本`;
  }
  if (status.manualUpdateAvailable) {
    return `连接器 ${status.latestVersion} 属于新的播放器版本分支，`
      + '需在播放器设置中手动确认更新';
  }
  return null;
}

export interface ProgressLogThrottleOptions {
  stepPercent?: number;
  minIntervalMs?: number;
}

/**
 * Decides which download progress updates deserve a log line. A known total
 * is logged at each new 25% step, an unknown total (null percent) at most
 * every 5 s, and completion is always logged once.
 */
export function createProgressLogThrottle({
  stepPercent = 25,
  minIntervalMs = 5000
}: ProgressLogThrottleOptions = {}): (percent: number | null, now: number) => boolean {
  let lastStep = 0;
  let lastUnknownAt: number | null = null;
  let completed = false;
  return (percent, now) => {
    if (completed) return false;
    if (percent !== null && percent >= 100) {
      completed = true;
      return true;
    }
    if (percent !== null) {
      const step = Math.floor(percent / stepPercent);
      if (step <= lastStep) return false;
      lastStep = step;
      return true;
    }
    if (lastUnknownAt !== null && now - lastUnknownAt < minIntervalMs) {
      return false;
    }
    lastUnknownAt = now;
    return true;
  };
}
