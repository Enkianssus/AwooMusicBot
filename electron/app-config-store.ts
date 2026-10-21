import fs from 'node:fs';
import path from 'node:path';
import { isTransientFsLockError, renameSyncWithRetry } from './fs-retry.ts';

/**
 * Persistence for bili_bot_config.json, which holds the login cookie, the
 * room and every setting.
 *
 * - A save writes `<file>.tmp` and renames it over the file, so a crash in the
 *   middle of a save leaves the previous file intact.
 * - Frequent saves (an overlay being dragged, gift capture) are coalesced by
 *   scheduleSave; user actions that must not be lost use saveNow, and quitting
 *   calls flushSync.
 * - A file that loads is copied to `<file>.bak`. A file that cannot be parsed
 *   is moved aside to `<file>.corrupt-<time>` (never deleted) and the backup
 *   is tried instead.
 * - While a damaged file could not be preserved, or the file exists but could
 *   not be read, saving is refused for the rest of the run: writing defaults
 *   over it would destroy the user's only copy.
 */

export type AppConfigLoadStatus =
  | 'missing'
  | 'ok'
  | 'recovered-from-backup'
  | 'corrupt-reset'
  | 'unreadable';

export interface AppConfigLoadResult {
  status: AppConfigLoadStatus;
  /** The parsed settings object, or null when the defaults should be used. */
  config: Record<string, unknown> | null;
  /** Where the damaged file was preserved, when it was. */
  quarantinePath: string | null;
  /** Why the file itself could not be used ('' when it could). */
  error: string;
}

export type AppConfigStoreFs = Pick<
  typeof fs,
  'existsSync' | 'mkdirSync' | 'readFileSync' | 'renameSync' | 'unlinkSync' | 'writeFileSync'
>;

export type AppConfigStoreLog = (message: string, color: string) => void;

export interface AppConfigStoreOptions {
  filePath: string;
  fsImpl?: AppConfigStoreFs;
  now?: () => number;
  /** Quiet period of scheduleSave before the file is written. */
  debounceMs?: number;
  /** A burst of scheduleSave calls still writes at least this often. */
  maxWaitMs?: number;
  /** Rename attempts before a save falls back to writing the file directly. */
  renameAttempts?: number;
  /** Read attempts for a file that is briefly locked, e.g. by antivirus software. */
  readAttempts?: number;
  /** Blocks for the given time between read attempts. */
  sleepSync?: (milliseconds: number) => void;
  log?: AppConfigStoreLog;
}

export interface AppConfigStore {
  readonly filePath: string;
  readonly backupPath: string;
  /** Reads the file once at startup; see AppConfigLoadStatus. */
  load(): AppConfigLoadResult;
  /** Coalesces saves; `serialize` runs when the file is actually written. */
  scheduleSave(serialize: () => string): void;
  /** Writes immediately and drops any scheduled save. Returns whether the file was written. */
  saveNow(serialize: () => string): boolean;
  /** Writes a scheduled save now. Returns whether a file was written. */
  flushSync(): boolean;
  /** Whether a scheduled save is waiting. */
  readonly pending: boolean;
  /** False after load() found a file that must not be overwritten. */
  readonly writable: boolean;
}

const DEFAULT_DEBOUNCE_MS = 300;
const DEFAULT_MAX_WAIT_MS = 2000;
const QUARANTINE_NAME_ATTEMPTS = 10;
const READ_RETRY_DELAYS_MS = [25, 50, 100, 200];

type ReadOutcome =
  | { kind: 'missing' }
  | { kind: 'read'; bytes: Buffer }
  | { kind: 'failed'; error: unknown };

function errorCode(error: unknown): string {
  return error && typeof error === 'object'
    ? String((error as NodeJS.ErrnoException).code || '')
    : '';
}

/** File system errors are reported by code only: their messages contain paths with the Windows user name. */
function describeError(error: unknown): string {
  const code = errorCode(error);
  if (code) return code;
  return error instanceof Error ? error.message : String(error);
}

/** A short blocking wait, used only between the few read retries of a locked file at startup. */
function blockingSleep(milliseconds: number): void {
  if (!(milliseconds > 0)) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  } catch {
    // Waiting is not allowed on this thread; retry immediately instead.
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const BYTE_ORDER_MARK = 0xfeff;

/** A settings file is one JSON object; a leading BOM from a text editor is tolerated. */
function parseConfigObject(bytes: Buffer): Record<string, unknown> {
  const decoded = bytes.toString('utf8');
  const text = decoded.charCodeAt(0) === BYTE_ORDER_MARK ? decoded.slice(1) : decoded;
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('配置文件内容不是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

/** `2026-10-21T08-30-00-000Z`: sortable and valid in Windows file names. */
function quarantineStamp(milliseconds: number): string {
  const date = new Date(Number.isFinite(milliseconds) ? milliseconds : Date.now());
  return date.toISOString().replace(/[:.]/g, '-');
}

export function createAppConfigStore(options: AppConfigStoreOptions): AppConfigStore {
  const filePath = options.filePath;
  const fsImpl = options.fsImpl || fs;
  const now = options.now || Date.now;
  const debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  const maxWaitMs = Math.max(debounceMs, options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
  const renameAttempts = positiveInteger(options.renameAttempts, 5);
  const readAttempts = positiveInteger(options.readAttempts, READ_RETRY_DELAYS_MS.length + 1);
  const sleepSync = options.sleepSync || blockingSleep;
  const log: AppConfigStoreLog = (message, color) => {
    try {
      options.log?.(message, color);
    } catch {
      // Logging must never break loading or saving the settings.
    }
  };
  const backupPath = `${filePath}.bak`;
  const temporaryPath = `${filePath}.tmp`;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingSerialize: (() => string) | null = null;
  let burstStartedAt = 0;
  let writeBlockedReason = '';
  let writeBlockedLogged = false;

  function removeQuietly(target: string): void {
    try {
      fsImpl.unlinkSync(target);
    } catch {
      // Already gone, or locked; a later save overwrites it.
    }
  }

  function readFile(target: string, attempts: number): ReadOutcome {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return { kind: 'read', bytes: fsImpl.readFileSync(target) };
      } catch (error: unknown) {
        if (errorCode(error) === 'ENOENT') return { kind: 'missing' };
        if (attempt >= attempts || !isTransientFsLockError(error)) return { kind: 'failed', error };
        sleepSync(READ_RETRY_DELAYS_MS[Math.min(attempt, READ_RETRY_DELAYS_MS.length) - 1]);
      }
    }
  }

  function readBackup(): Record<string, unknown> | null {
    const outcome = readFile(backupPath, 1);
    if (outcome.kind !== 'read') return null;
    try {
      return parseConfigObject(outcome.bytes);
    } catch {
      return null;
    }
  }

  /** Replaces the backup atomically, so it can never be half written. */
  function refreshBackup(bytes: Buffer): void {
    const temporaryBackup = `${backupPath}.tmp`;
    try {
      fsImpl.writeFileSync(temporaryBackup, bytes);
      renameSyncWithRetry(temporaryBackup, backupPath, { attempts: renameAttempts, fsImpl });
    } catch (error: unknown) {
      removeQuietly(temporaryBackup);
      log(`[配置] 无法更新配置备份：${describeError(error)}`, 'Yellow');
    }
  }

  /**
   * Moves the damaged file aside. If it cannot be moved, the bytes already
   * read are written to the quarantine name instead. Returns null when the
   * damaged content could not be preserved at all.
   */
  function quarantine(bytes: Buffer): string | null {
    const base = `${filePath}.corrupt-${quarantineStamp(now())}`;
    for (let attempt = 0; attempt < QUARANTINE_NAME_ATTEMPTS; attempt += 1) {
      const target = attempt ? `${base}-${attempt}` : base;
      if (fsImpl.existsSync(target)) continue;
      try {
        renameSyncWithRetry(filePath, target, { attempts: renameAttempts, fsImpl });
        return target;
      } catch {
        try {
          fsImpl.writeFileSync(target, bytes, { flag: 'wx' });
          return target;
        } catch (copyError: unknown) {
          if (errorCode(copyError) === 'EEXIST') continue;
          return null;
        }
      }
    }
    return null;
  }

  function blockWrites(reason: string): void {
    writeBlockedReason = reason;
    writeBlockedLogged = false;
  }

  function load(): AppConfigLoadResult {
    writeBlockedReason = '';
    const outcome = readFile(filePath, readAttempts);
    if (outcome.kind === 'missing') {
      return { status: 'missing', config: null, quarantinePath: null, error: '' };
    }
    if (outcome.kind === 'failed') {
      const error = describeError(outcome.error);
      blockWrites(`配置文件无法读取（${error}）`);
      return { status: 'unreadable', config: readBackup(), quarantinePath: null, error };
    }

    try {
      const config = parseConfigObject(outcome.bytes);
      refreshBackup(outcome.bytes);
      return { status: 'ok', config, quarantinePath: null, error: '' };
    } catch (parseError: unknown) {
      const error = describeError(parseError);
      const quarantinePath = quarantine(outcome.bytes);
      if (!quarantinePath) blockWrites('损坏的配置文件无法另存');
      const backup = readBackup();
      return backup
        ? { status: 'recovered-from-backup', config: backup, quarantinePath, error }
        : { status: 'corrupt-reset', config: null, quarantinePath, error };
    }
  }

  function writeTemporary(text: string): void {
    try {
      fsImpl.writeFileSync(temporaryPath, text, 'utf8');
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') throw error;
      fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
      fsImpl.writeFileSync(temporaryPath, text, 'utf8');
    }
  }

  function write(serialize: () => string): boolean {
    if (writeBlockedReason) {
      if (!writeBlockedLogged) {
        writeBlockedLogged = true;
        log(`[配置] ${writeBlockedReason}，本次运行不会保存设置，以免覆盖原文件`, 'Red');
      }
      return false;
    }
    let text: string;
    try {
      text = serialize();
      writeTemporary(text);
    } catch (error: unknown) {
      removeQuietly(temporaryPath);
      log(`保存配置失败：${describeError(error)}`, 'Red');
      return false;
    }
    try {
      renameSyncWithRetry(temporaryPath, filePath, { attempts: renameAttempts, fsImpl });
      return true;
    } catch (renameError: unknown) {
      try {
        fsImpl.writeFileSync(filePath, text, 'utf8');
        log(`[配置] 无法替换配置文件（${describeError(renameError)}），已改为直接写入`, 'Yellow');
        return true;
      } catch (error: unknown) {
        log(`保存配置失败：${describeError(error)}`, 'Red');
        return false;
      } finally {
        removeQuietly(temporaryPath);
      }
    }
  }

  function cancelScheduled(): (() => string) | null {
    if (timer) clearTimeout(timer);
    timer = null;
    const serialize = pendingSerialize;
    pendingSerialize = null;
    return serialize;
  }

  function fire(): void {
    timer = null;
    const serialize = pendingSerialize;
    pendingSerialize = null;
    if (serialize) write(serialize);
  }

  return {
    filePath,
    backupPath,
    load,
    scheduleSave(serialize) {
      const at = now();
      if (timer) clearTimeout(timer);
      else burstStartedAt = at;
      pendingSerialize = serialize;
      const remaining = maxWaitMs - Math.max(0, at - burstStartedAt);
      timer = setTimeout(fire, Math.max(0, Math.min(debounceMs, remaining)));
    },
    saveNow(serialize) {
      cancelScheduled();
      return write(serialize);
    },
    flushSync() {
      const serialize = cancelScheduled();
      return serialize ? write(serialize) : false;
    },
    get pending() {
      return pendingSerialize !== null;
    },
    get writable() {
      return !writeBlockedReason;
    }
  };
}
