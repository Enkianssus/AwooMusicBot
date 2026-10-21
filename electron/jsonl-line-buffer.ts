export type JsonlInvalidReason = 'invalid-json' | 'not-object' | 'handler-error';

export interface JsonlLineBufferOptions {
  /** Longest line kept while waiting for its newline. */
  maxBufferedChars?: number;
  onMessage(value: Record<string, unknown>): void;
  onInvalid(line: string, reason: JsonlInvalidReason): void;
  onOverflow(droppedChars: number): void;
}

export interface JsonlLineBuffer {
  push(chunk: string): void;
  reset(): void;
}

export const JSONL_MAX_BUFFERED_CHARS = 4 * 1024 * 1024;

/**
 * Splits a JSONL text stream into objects. push() never throws: a bad line,
 * an oversized line or a failing handler is reported and the lines after it
 * are still delivered.
 */
export function createJsonlLineBuffer({
  maxBufferedChars = JSONL_MAX_BUFFERED_CHARS,
  onMessage,
  onInvalid,
  onOverflow
}: JsonlLineBufferOptions): JsonlLineBuffer {
  let pending = '';
  // After an overflow the rest of that line is skipped up to its newline.
  let discarding = false;
  let epoch = 0;

  const reportInvalid = (line: string, reason: JsonlInvalidReason) => {
    try {
      onInvalid(line, reason);
    } catch {}
  };
  const reportOverflow = (droppedChars: number) => {
    try {
      onOverflow(droppedChars);
    } catch {}
  };

  const deliver = (raw: string) => {
    if (raw.length > maxBufferedChars) {
      reportOverflow(raw.length);
      return;
    }
    // trim() also drops '\r' from CRLF output and a UTF-8 BOM.
    const line = raw.trim();
    if (!line) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      reportInvalid(line, 'invalid-json');
      return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      reportInvalid(line, 'not-object');
      return;
    }
    try {
      onMessage(value as Record<string, unknown>);
    } catch {
      reportInvalid(line, 'handler-error');
    }
  };

  return {
    push(chunk) {
      const current = epoch;
      let offset = 0;
      if (discarding) {
        const newline = chunk.indexOf('\n');
        if (newline < 0) return;
        discarding = false;
        offset = newline + 1;
      }
      let newline = chunk.indexOf('\n', offset);
      while (newline >= 0) {
        const line = pending + chunk.slice(offset, newline);
        pending = '';
        offset = newline + 1;
        deliver(line);
        // A handler reset the buffer; the rest of this chunk is stale.
        if (current !== epoch) return;
        newline = chunk.indexOf('\n', offset);
      }
      pending += chunk.slice(offset);
      if (pending.length > maxBufferedChars) {
        const droppedChars = pending.length;
        pending = '';
        discarding = true;
        reportOverflow(droppedChars);
      }
    },
    reset() {
      epoch++;
      pending = '';
      discarding = false;
    }
  };
}
