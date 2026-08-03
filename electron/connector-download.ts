export interface ConnectorDownloadProgress {
  received: number;
  total: number;
  percent: number;
}

export interface ConnectorDownloadRetry {
  attempt: number;
  maxAttempts: number;
  start: number;
  end: number;
  error: string;
}

type ConnectorFetch = (
  input: string,
  init?: RequestInit
) => Promise<Response>;

interface DownloadBufferOptions {
  url: string;
  expectedSize: number;
  chunkSize?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  fetchImpl?: ConnectorFetch;
  onProgress?: (progress: ConnectorDownloadProgress) => void;
  onRetry?: (retry: ConnectorDownloadRetry) => void;
}

interface DownloadWholeBufferOptions {
  url: string;
  expectedSize: number;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  fetchImpl?: ConnectorFetch;
  onProgress?: (progress: ConnectorDownloadProgress) => void;
  onRetry?: (retry: ConnectorDownloadRetry) => void;
}

interface DownloadedRange {
  data: Buffer;
  completeArchive: boolean;
}

const DEFAULT_CHUNK_SIZE = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_DELAY_MS = 500;

export async function downloadBufferWithRanges(
  options: DownloadBufferOptions
): Promise<Buffer> {
  const {
    url,
    expectedSize,
    chunkSize = DEFAULT_CHUNK_SIZE,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    fetchImpl = fetch,
    onProgress,
    onRetry
  } = options;

  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
    throw new Error(`下载文件大小无效：${expectedSize}`);
  }
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(`下载分块大小无效：${chunkSize}`);
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error(`下载重试次数无效：${maxAttempts}`);
  }

  const chunks: Buffer[] = [];
  let received = 0;
  while (received < expectedSize) {
    const end = Math.min(
      received + chunkSize - 1,
      expectedSize - 1
    );
    const range = await downloadRange({
      url,
      expectedSize,
      start: received,
      end,
      timeoutMs,
      maxAttempts,
      retryDelayMs,
      fetchImpl,
      onRetry
    });
    if (range.completeArchive) {
      onProgress?.({
        received: expectedSize,
        total: expectedSize,
        percent: 100
      });
      return range.data;
    }

    chunks.push(range.data);
    received += range.data.length;
    onProgress?.({
      received,
      total: expectedSize,
      percent: Math.min(100, Math.floor(received * 100 / expectedSize))
    });
  }

  return Buffer.concat(chunks, expectedSize);
}

export async function downloadWholeBufferWithRetries(
  options: DownloadWholeBufferOptions
): Promise<Buffer> {
  const {
    url,
    expectedSize,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    fetchImpl = fetch,
    onProgress,
    onRetry
  } = options;

  if (!Number.isSafeInteger(expectedSize) || expectedSize <= 0) {
    throw new Error(`下载文件大小无效：${expectedSize}`);
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
    throw new Error(`下载重试次数无效：${maxAttempts}`);
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`下载 HTTP ${response.status}`);
      }
      const archive = Buffer.from(await response.arrayBuffer());
      if (archive.length !== expectedSize) {
        throw new Error(
          `下载文件大小不匹配：${archive.length}/${expectedSize}`
        );
      }
      onProgress?.({
        received: expectedSize,
        total: expectedSize,
        percent: 100
      });
      return archive;
    } catch (error: unknown) {
      lastError = error;
      if (attempt >= maxAttempts) break;
      onRetry?.({
        attempt,
        maxAttempts,
        start: 0,
        end: expectedSize - 1,
        error: getErrorMessage(error)
      });
      if (retryDelayMs > 0) {
        await delay(retryDelayMs * attempt);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`完整下载失败：${getErrorMessage(lastError)}`);
}

async function downloadRange(options: {
  url: string;
  expectedSize: number;
  start: number;
  end: number;
  timeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
  fetchImpl: ConnectorFetch;
  onRetry?: (retry: ConnectorDownloadRetry) => void;
}): Promise<DownloadedRange> {
  const expectedRangeSize = options.end - options.start + 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await options.fetchImpl(options.url, {
        method: 'GET',
        cache: 'no-store',
        headers: {
          Range: `bytes=${options.start}-${options.end}`
        },
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`下载 HTTP ${response.status}`);
      }

      const data = Buffer.from(await response.arrayBuffer());
      if (
        response.status === 200
        && options.start === 0
        && data.length === options.expectedSize
      ) {
        return { data, completeArchive: true };
      }
      if (response.status !== 206) {
        throw new Error(`下载服务器未返回分块响应：HTTP ${response.status}`);
      }

      const contentRange = parseContentRange(
        response.headers.get('content-range')
      );
      if (
        !contentRange
        || contentRange.start !== options.start
        || contentRange.end !== options.end
        || contentRange.total !== options.expectedSize
      ) {
        throw new Error(
          `下载分块范围不匹配：${response.headers.get('content-range') || '缺失'}`
        );
      }
      if (data.length !== expectedRangeSize) {
        throw new Error(
          `下载分块大小不匹配：${data.length}/${expectedRangeSize}`
        );
      }
      return { data, completeArchive: false };
    } catch (error: unknown) {
      lastError = error;
      if (attempt >= options.maxAttempts) break;
      options.onRetry?.({
        attempt,
        maxAttempts: options.maxAttempts,
        start: options.start,
        end: options.end,
        error: getErrorMessage(error)
      });
      if (options.retryDelayMs > 0) {
        await delay(options.retryDelayMs * attempt);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(
    `下载分块 ${options.start}-${options.end} 失败：${getErrorMessage(lastError)}`
  );
}

function parseContentRange(value: string | null): {
  start: number;
  end: number;
  total: number;
} | null {
  const match = String(value || '').match(
    /^bytes\s+(\d+)-(\d+)\/(\d+)$/i
  );
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: Number(match[3])
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
