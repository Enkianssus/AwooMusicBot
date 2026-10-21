import fs from 'node:fs';
import path from 'node:path';

/**
 * Windows reports a path that is briefly held by an exiting process, the
 * search indexer or antivirus software with one of these codes. They are
 * worth a short retry; every other error is reported immediately.
 */
const TRANSIENT_FS_LOCK_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY']);

export interface FsRetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  fsImpl?: Pick<typeof fs.promises, 'rename' | 'rm'>;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface FsSyncRetryOptions {
  attempts?: number;
  fsImpl?: Pick<typeof fs, 'renameSync'>;
}

export interface StaleEntrySweepOptions {
  /** Only direct children whose names start with one of these are removed. */
  prefixes: readonly string[];
  /** An entry is removed only when all of its timestamps are older. */
  maxAgeMs: number;
  now?: number;
  attempts?: number;
}

export interface StaleEntrySweepResult {
  removed: string[];
  failed: { name: string; error: unknown }[];
}

export function isTransientFsLockError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = String((error as NodeJS.ErrnoException).code || '').toUpperCase();
  return TRANSIENT_FS_LOCK_CODES.has(code);
}

export function renameWithRetry(
  from: string,
  to: string,
  options: FsRetryOptions = {}
): Promise<void> {
  const fsImpl = options.fsImpl || fs.promises;
  return retryTransientFsLock(() => fsImpl.rename(from, to), options);
}

export function rmWithRetry(
  target: string,
  options: FsRetryOptions = {}
): Promise<void> {
  const fsImpl = options.fsImpl || fs.promises;
  return retryTransientFsLock(
    () => fsImpl.rm(target, { recursive: true, force: true }),
    options
  );
}

/**
 * Synchronous variant for small configuration files. It retries immediately
 * instead of sleeping, so it never blocks the event loop for long.
 */
export function renameSyncWithRetry(
  from: string,
  to: string,
  options: FsSyncRetryOptions = {}
): void {
  const attempts = normalizeAttempts(options.attempts ?? 5);
  const fsImpl = options.fsImpl || fs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      fsImpl.renameSync(from, to);
      return;
    } catch (error: unknown) {
      if (attempt >= attempts || !isTransientFsLockError(error)) throw error;
    }
  }
}

/**
 * Remove leftovers of interrupted installs, such as partial downloads or
 * staging directories. Failures are reported to the caller instead of thrown
 * so one locked entry cannot stop the rest of the sweep.
 */
export async function removeStaleEntries(
  directory: string,
  options: StaleEntrySweepOptions
): Promise<StaleEntrySweepResult> {
  const result: StaleEntrySweepResult = { removed: [], failed: [] };
  let names: string[];
  try {
    names = await fs.promises.readdir(directory);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return result;
    throw error;
  }

  const now = options.now ?? Date.now();
  for (const name of names) {
    if (!options.prefixes.some(prefix => name.startsWith(prefix))) continue;
    const target = path.join(directory, name);
    try {
      const stats = await fs.promises.lstat(target);
      // A rename keeps the modification time of a directory, so a backup
      // that was just moved aside still looks old by mtime alone.
      const newest = Math.max(stats.mtimeMs, stats.ctimeMs, stats.birthtimeMs);
      if (now - newest < options.maxAgeMs) continue;
      await rmWithRetry(target, { attempts: options.attempts ?? 3 });
      result.removed.push(name);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      result.failed.push({ name, error });
    }
  }
  return result;
}

async function retryTransientFsLock(
  operation: () => Promise<void>,
  options: FsRetryOptions
): Promise<void> {
  const attempts = normalizeAttempts(options.attempts ?? 10);
  const baseDelayMs = options.baseDelayMs ?? 100;
  const maxDelayMs = options.maxDelayMs ?? 1000;
  const sleep = options.sleep || delay;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error: unknown) {
      if (attempt >= attempts || !isTransientFsLockError(error)) throw error;
      await sleep(Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
}

function normalizeAttempts(attempts: number): number {
  return Number.isSafeInteger(attempts) && attempts > 0 ? attempts : 1;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
