// The server keeps the last 500 log lines (100 before 1.2.6). Newer servers number them (Seq) and
// answer /api/logs?after=<seq> with the newer lines only; older servers ignore
// the parameter and return the whole array on every poll. Either way the logs
// panel keeps one client-side buffer whose rows have stable keys, so new lines
// are appended and old ones removed instead of rewriting the rows a paused
// reader is looking at.

export interface LogEntry {
    Seq?: number;
    Time: string;
    Color: string;
    Message: string;
}

export interface KeyedLogEntry extends LogEntry {
    /** Seq when the server sends it, otherwise `${Time}|n` for the n-th line of that second. */
    key: string;
}

export interface MergeLogOptions {
    max?: number;
}

export const LOG_BUFFER_MAX = 500;

function text(value: unknown): string {
    return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function normalizeEntry(value: unknown): LogEntry | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    const entry: LogEntry = { Time: text(record.Time), Color: text(record.Color), Message: text(record.Message) };
    if (typeof record.Seq === 'number' && Number.isFinite(record.Seq)) entry.Seq = record.Seq;
    return entry;
}

/** The Seq of the newest buffered line, or null when the server does not number its lines. */
export function lastLogSeq(buffer: readonly KeyedLogEntry[]): number | null {
    const last = buffer[buffer.length - 1];
    return last && typeof last.Seq === 'number' ? last.Seq : null;
}

function keepNewest<T>(entries: T[], max: number): T[] {
    const limit = Math.max(1, Math.floor(max));
    return entries.length > limit ? entries.slice(entries.length - limit) : entries;
}

/**
 * Lines of an older server only differ by Time, so the n-th line logged within
 * one second keeps its key while the server's ring buffer moves on.
 */
function keyByTime(entries: readonly LogEntry[]): KeyedLogEntry[] {
    const seen = new Map<string, number>();
    return entries.map(entry => {
        const occurrence = seen.get(entry.Time) || 0;
        seen.set(entry.Time, occurrence + 1);
        return { ...entry, key: `${entry.Time}|${occurrence}` };
    });
}

function sameEntries(left: readonly KeyedLogEntry[], right: readonly KeyedLogEntry[]): boolean {
    return left.length === right.length && left.every((entry, index) => {
        const other = right[index];
        return entry.key === other.key && entry.Color === other.Color && entry.Message === other.Message;
    });
}

/**
 * Merges one /api/logs response into the buffer. Numbered lines newer than the
 * buffer are appended; without Seq the response replaces the buffer. An
 * unchanged result returns `prev` itself, so callers can skip the re-render.
 */
export function mergeLogEntries(
    prev: readonly KeyedLogEntry[],
    incoming: unknown,
    { max = LOG_BUFFER_MAX }: MergeLogOptions = {}
): readonly KeyedLogEntry[] {
    if (!Array.isArray(incoming)) return prev;
    const entries = incoming.map(normalizeEntry).filter((entry): entry is LogEntry => entry !== null);
    const lastSeq = lastLogSeq(prev);

    if (entries.length > 0 && entries.every(entry => entry.Seq !== undefined)) {
        const newest = entries[entries.length - 1].Seq as number;
        // A buffer from an older server, or numbering that started over, is replaced.
        let cursor = lastSeq === null || newest < lastSeq ? -Infinity : lastSeq;
        const base = cursor === -Infinity ? [] : prev;
        const appended: KeyedLogEntry[] = [];
        for (const entry of entries) {
            const seq = entry.Seq as number;
            if (seq <= cursor) continue;
            cursor = seq;
            appended.push({ ...entry, key: String(seq) });
        }
        if (appended.length === 0 && base === prev) return prev;
        return keepNewest([...base, ...appended], max);
    }

    // An empty answer to ?after= only means there is nothing new.
    if (entries.length === 0 && lastSeq !== null) return prev;
    const replaced = keyByTime(keepNewest(entries, max));
    return sameEntries(prev, replaced) ? prev : replaced;
}
