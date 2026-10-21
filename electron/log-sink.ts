import fs from 'node:fs';
import path from 'node:path';
import { renameWithRetry } from './fs-retry.ts';

/**
 * The persistent diagnostics log and the selection rules for the in-memory
 * log ring served at /api/logs.
 *
 * The sink appends one line per entry to `<dir>/main.log` in the background
 * and rotates it to main.1.log, main.2.log ... when it would exceed maxBytes,
 * so the lines that explain a failed update or a crash survive the restart
 * that follows it. Every message passes through `sanitize` (the feedback
 * sanitizer, which hides cookies and tokens) before it reaches the disk.
 * Nothing here ever throws into the caller: logging must not break the app.
 */

export interface LogSinkEntry {
  message: string;
  color?: string;
  /** Milliseconds since the epoch; now() when omitted. */
  at?: number;
}

export type LogSinkFs = Pick<typeof fs, 'appendFileSync' | 'mkdirSync'> & {
  promises: Pick<typeof fs.promises, 'appendFile' | 'mkdir' | 'rename' | 'rm' | 'stat'>;
};

export interface LogSinkOptions {
  dir: string;
  /** Base name of the current file; rotated copies are `<name>.1.log`, `<name>.2.log` ... */
  name?: string;
  /** The current file is rotated before it would grow beyond this size. */
  maxBytes?: number;
  /** Files kept including the current one. */
  files?: number;
  /** Applied to every message before it is written. */
  sanitize: (message: string) => string;
  fsImpl?: LogSinkFs;
  now?: () => number;
  /** Lines held in memory while the disk is slow or failing; the oldest are dropped first. */
  maxPendingLines?: number;
  /** Wait after a failed write before the queue is written again. */
  retryDelayMs?: number;
  /** Write failures, reported at most once a minute. It must not log back into this sink. */
  onError?: (error: unknown) => void;
}

export interface LogSink {
  readonly filePath: string;
  /** Queues one line. Never throws. */
  write(entry: LogSinkEntry): void;
  /** Resolves once the queued lines are written, or a write has failed. Never rejects. */
  flush(): Promise<void>;
  /**
   * Synchronously appends whatever is still queued, for the moment the app
   * quits, including a batch whose background write has not finished (that
   * batch may then appear twice in the file, but is never lost). Calling it
   * again writes only lines queued since.
   */
  flushSync(): void;
}

export const LOG_SINK_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_SINK_FILES = 3;
const DEFAULT_MAX_PENDING_LINES = 2000;
const DEFAULT_RETRY_DELAY_MS = 5000;
const ROTATION_RETRY_MS = 60_000;
const ERROR_REPORT_INTERVAL_MS = 60_000;
const MAX_BATCH_LINES = 1000;
const MAX_MESSAGE_CHARS = 2000;
const UNSANITIZABLE_MESSAGE = '[日志内容无法安全记录，已省略]';

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** Local ISO 8601 time with its UTC offset, e.g. 2026-10-21T16:30:00.123+08:00. */
export function formatLogTimestamp(milliseconds: number): string {
  const date = new Date(Number.isFinite(milliseconds) ? milliseconds : Date.now());
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const absolute = Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object'
    ? String((error as NodeJS.ErrnoException).code || '')
    : '';
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.floor(value)))
    : fallback;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export function createLogSink(options: LogSinkOptions): LogSink {
  const fsImpl = options.fsImpl || fs;
  const now = options.now || Date.now;
  const name = options.name || 'main';
  const maxBytes = boundedInteger(options.maxBytes, LOG_SINK_MAX_BYTES, 1, Number.MAX_SAFE_INTEGER);
  const fileCount = boundedInteger(options.files, LOG_SINK_FILES, 1, 20);
  const maxPendingLines = boundedInteger(options.maxPendingLines, DEFAULT_MAX_PENDING_LINES, 1, 1_000_000);
  const retryDelayMs = boundedInteger(options.retryDelayMs, DEFAULT_RETRY_DELAY_MS, 0, 3_600_000);
  const filePath = path.join(options.dir, `${name}.log`);
  const rotatedPath = (index: number) => path.join(options.dir, `${name}.${index}.log`);

  const pending: string[] = [];
  let dropped = 0;
  /**
   * The batch drain() took from `pending` and has not finished writing. Once
   * flushSync has written it, drain() neither writes nor requeues it.
   */
  let inFlight: { text: string; writtenSync: boolean } | null = null;
  let draining: Promise<void> | null = null;
  let failures = 0;
  let retryAt = 0;
  let rotationRetryAt = 0;
  let currentSize: number | null = null;
  let directoryReady = false;
  let lastReportAt = Number.NEGATIVE_INFINITY;

  function report(error: unknown): void {
    const at = now();
    if (at - lastReportAt < ERROR_REPORT_INTERVAL_MS) return;
    lastReportAt = at;
    try {
      options.onError?.(error);
    } catch {
      // The error reporter must not break logging either.
    }
  }

  function sanitizeMessage(message: unknown): string {
    try {
      return options.sanitize(String(message ?? '')).slice(0, MAX_MESSAGE_CHARS);
    } catch {
      return UNSANITIZABLE_MESSAGE;
    }
  }

  function formatLine(entry: LogSinkEntry): string {
    const at = typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : now();
    const color = typeof entry.color === 'string' && /^[A-Za-z]{1,20}$/.test(entry.color)
      ? entry.color
      : 'Gray';
    // Continuation lines (stack traces) are indented so every record starts with its time.
    const body = sanitizeMessage(entry.message).replace(/\r\n?/g, '\n').replace(/\n/g, '\n    ');
    return `${formatLogTimestamp(at)} [${color}] ${body}\n`;
  }

  function droppedNotice(count: number): string {
    return count > 0
      ? `${formatLogTimestamp(now())} [Yellow] [日志] 有 ${count} 行日志未能写入日志文件\n`
      : '';
  }

  function trimPending(): void {
    const excess = pending.length - maxPendingLines;
    if (excess > 0) {
      pending.splice(0, excess);
      dropped += excess;
    }
  }

  async function ensureDirectory(): Promise<void> {
    if (directoryReady) return;
    await fsImpl.promises.mkdir(options.dir, { recursive: true });
    directoryReady = true;
  }

  async function readCurrentSize(): Promise<number> {
    try {
      return (await fsImpl.promises.stat(filePath)).size;
    } catch {
      return 0;
    }
  }

  async function renameIfPresent(from: string, to: string): Promise<void> {
    try {
      await renameWithRetry(from, to, { attempts: 3, fsImpl: fsImpl.promises });
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }

  async function rotate(): Promise<void> {
    if (fileCount <= 1) {
      await fsImpl.promises.rm(filePath, { force: true });
      return;
    }
    await fsImpl.promises.rm(rotatedPath(fileCount - 1), { force: true });
    for (let index = fileCount - 2; index >= 1; index -= 1) {
      await renameIfPresent(rotatedPath(index), rotatedPath(index + 1));
    }
    await renameIfPresent(filePath, rotatedPath(1));
  }

  async function rotateIfNeeded(incomingBytes: number): Promise<void> {
    if (currentSize === null) currentSize = await readCurrentSize();
    if (currentSize === 0 || currentSize + incomingBytes <= maxBytes) return;
    // A rotation that failed (a viewer holding the file open) is retried later;
    // until then the current file simply grows.
    if (now() < rotationRetryAt) return;
    try {
      await rotate();
      currentSize = 0;
    } catch (error: unknown) {
      rotationRetryAt = now() + ROTATION_RETRY_MS;
      report(error);
    }
  }

  async function append(text: string): Promise<void> {
    try {
      await fsImpl.promises.appendFile(filePath, text, 'utf8');
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT') throw error;
      // The log folder was removed while the app was running.
      directoryReady = false;
      await ensureDirectory();
      await fsImpl.promises.appendFile(filePath, text, 'utf8');
    }
  }

  /** Writes the queue in batches; returns early, keeping the batch queued, when a write fails. */
  async function drain(): Promise<void> {
    // Lines logged in the same tick are written together.
    await Promise.resolve();
    while (pending.length > 0) {
      const lines = pending.splice(0, MAX_BATCH_LINES);
      const noticed = dropped;
      dropped = 0;
      const text = droppedNotice(noticed) + lines.join('');
      const bytes = Buffer.byteLength(text, 'utf8');
      const batch = { text, writtenSync: false };
      inFlight = batch;
      try {
        await ensureDirectory();
        await rotateIfNeeded(bytes);
        // flushSync may have written the batch while this was waiting.
        if (!batch.writtenSync) {
          await append(text);
          currentSize = (currentSize ?? 0) + bytes;
        }
      } catch (error: unknown) {
        if (!batch.writtenSync) {
          pending.unshift(...lines);
          dropped += noticed;
          trimPending();
        }
        failures += 1;
        retryAt = now() + retryDelayMs;
        report(error);
        return;
      } finally {
        if (inFlight === batch) inFlight = null;
      }
    }
  }

  function kick(): Promise<void> {
    if (draining) return draining;
    if (pending.length === 0) return Promise.resolve();
    const failuresBefore = failures;
    const wait = Math.max(0, retryAt - now());
    draining = (wait > 0 ? delay(wait) : Promise.resolve())
      .then(drain)
      .catch(report)
      .finally(() => {
        draining = null;
        // Lines that arrived during the last write are written next. After a
        // failure the next write() or flush() tries again, after retryDelayMs.
        if (pending.length > 0 && failures === failuresBefore) void kick();
      });
    return draining;
  }

  return {
    filePath,
    write(entry) {
      try {
        pending.push(formatLine(entry));
        trimPending();
        void kick();
      } catch (error: unknown) {
        report(error);
      }
    },
    async flush() {
      try {
        const failuresAtStart = failures;
        while ((draining || pending.length > 0) && failures === failuresAtStart) {
          await kick();
        }
      } catch {
        // kick() never rejects; nothing to do.
      }
    },
    flushSync() {
      // The process may end before an unfinished background write lands, so
      // its batch is written here as well, ahead of the newer lines.
      const batch = inFlight && !inFlight.writtenSync ? inFlight : null;
      if (!batch && pending.length === 0) return;
      try {
        const text = (batch ? batch.text : '') + droppedNotice(dropped) + pending.join('');
        fsImpl.mkdirSync(options.dir, { recursive: true });
        fsImpl.appendFileSync(filePath, text, 'utf8');
        if (batch) batch.writtenSync = true;
        pending.length = 0;
        dropped = 0;
        if (currentSize !== null) currentSize += Buffer.byteLength(text, 'utf8');
      } catch (error: unknown) {
        report(error);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// In-memory log ring
// ---------------------------------------------------------------------------

/** Lines kept in memory for the logs panel; the panel keeps the same number. */
export const LOG_RING_LIMIT = 500;

/** Lines of the general tail attached to a feedback report. */
export const FEEDBACK_LOG_TAIL = 80;
/** Older connector and update lines attached in addition to the tail. */
export const FEEDBACK_LOG_MATCHED = 40;
/**
 * The JSON of the attached lines stays below this many UTF-8 bytes; the
 * feedback service rejects diagnostics larger than 48 KB in total.
 */
export const FEEDBACK_LOG_MAX_BYTES = 32 * 1024;
/** Tags of the lines that explain connector, update and player failures. */
export const FEEDBACK_LOG_PATTERN =
  /\[(连接器|连接器热更新|连接器更新|连接器兼容恢复|连接器重装|更新|Velopack|播放器桥|网易云连接器更新|QQ 画像|动态封面)\]/;

export interface RingLogEntry {
  Seq: number;
  Time: string;
  Color: string;
  Message: string;
}

export interface FeedbackLogEntry {
  time: string;
  color: string;
  message: string;
}

export interface FeedbackLogOptions {
  sanitize: (message: string) => string;
  tail?: number;
  matched?: number;
  pattern?: RegExp;
  maxBytes?: number;
}

/** The `after` query parameter of /api/logs; null when absent or not a log number. */
export function parseLogCursor(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || !/^\d{1,15}$/.test(value.trim())) return null;
  return Number(value.trim());
}

/**
 * The lines a poll should receive. Without a cursor that is the whole ring,
 * as before. A cursor from another process (beyond the newest line) also
 * gets the whole ring, so the panel notices the numbering restarted.
 */
export function selectLogsAfter<T extends { Seq: number }>(logs: readonly T[], after: number | null): T[] {
  if (after === null || logs.length === 0) return logs.slice();
  if (after > logs[logs.length - 1].Seq) return logs.slice();
  let start = logs.length;
  while (start > 0 && logs[start - 1].Seq > after) start -= 1;
  return logs.slice(start);
}

function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * The log lines attached to a feedback report: the newest `tail` lines plus up
 * to `matched` older lines tagged by `pattern`, in log order and without
 * duplicates. When the JSON would exceed `maxBytes`, untagged lines are
 * dropped first, oldest first, then the oldest tagged lines.
 */
export function selectFeedbackLogs(
  logs: readonly Pick<RingLogEntry, 'Time' | 'Color' | 'Message'>[],
  options: FeedbackLogOptions
): FeedbackLogEntry[] {
  const tail = boundedInteger(options.tail, FEEDBACK_LOG_TAIL, 0, LOG_RING_LIMIT * 10);
  const matched = boundedInteger(options.matched, FEEDBACK_LOG_MATCHED, 0, LOG_RING_LIMIT * 10);
  const maxBytes = boundedInteger(options.maxBytes, FEEDBACK_LOG_MAX_BYTES, 2, Number.MAX_SAFE_INTEGER);
  const source = options.pattern || FEEDBACK_LOG_PATTERN;
  const pattern = new RegExp(source.source, source.flags.replace(/[gy]/g, ''));
  const isTagged = (index: number) => pattern.test(String(logs[index].Message ?? ''));

  const tailStart = Math.max(0, logs.length - tail);
  const chosen: number[] = [];
  for (let index = tailStart - 1, found = 0; index >= 0 && found < matched; index -= 1) {
    if (isTagged(index)) {
      chosen.unshift(index);
      found += 1;
    }
  }
  for (let index = tailStart; index < logs.length; index += 1) chosen.push(index);

  const entries = chosen.map(index => {
    const log = logs[index];
    const entry: FeedbackLogEntry = {
      time: String(log.Time ?? ''),
      color: String(log.Color ?? ''),
      message: options.sanitize(String(log.Message ?? ''))
    };
    return { index, entry, tagged: isTagged(index), bytes: utf8Length(JSON.stringify(entry)) };
  });

  // "[" + "]" plus one comma between entries.
  let total = 2 + entries.reduce((sum, item) => sum + item.bytes, 0) + Math.max(0, entries.length - 1);
  const removed = new Set<number>();
  for (const tagged of [false, true]) {
    for (const item of entries) {
      if (total <= maxBytes) break;
      if (item.tagged !== tagged) continue;
      removed.add(item.index);
      total -= item.bytes + 1;
    }
  }
  return entries.filter(item => !removed.has(item.index)).map(item => item.entry);
}

/** The text logged for an uncaught error: its stack when there is one. */
export function describeErrorForLog(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message || String(error);
  if (error && typeof error === 'object') {
    const { stack, message } = error as { stack?: unknown; message?: unknown };
    if (typeof stack === 'string' && stack) return stack;
    if (typeof message === 'string' && message) return message;
  }
  try {
    return String(error);
  } catch {
    return '未知错误';
  }
}
