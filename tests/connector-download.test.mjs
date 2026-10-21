import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import {
  downloadBufferWithRanges,
  downloadWholeBufferWithRetries
} from '../electron/connector-download.ts';
import {
  ConnectorDownloadError,
  isConnectorDownloadError
} from '../electron/connector-install-policy.ts';

function partialResponse(payload, rangeHeader) {
  const match = String(rangeHeader).match(/^bytes=(\d+)-(\d+)$/);
  assert.ok(match);
  const start = Number(match[1]);
  const end = Number(match[2]);
  return new Response(payload.subarray(start, end + 1), {
    status: 206,
    headers: {
      'Content-Range': `bytes ${start}-${end}/${payload.length}`
    }
  });
}

test('downloads an archive in deterministic byte ranges', async () => {
  const payload = Buffer.from('0123456789');
  const requestedRanges = [];
  const progress = [];
  const archive = await downloadBufferWithRanges({
    url: 'https://example.test/connector.zip',
    expectedSize: payload.length,
    chunkSize: 4,
    fetchImpl: async (_url, init) => {
      requestedRanges.push(init?.headers?.Range);
      return partialResponse(payload, init?.headers?.Range);
    },
    onProgress: item => progress.push(item.percent)
  });

  assert.deepEqual(archive, payload);
  assert.deepEqual(requestedRanges, [
    'bytes=0-3',
    'bytes=4-7',
    'bytes=8-9'
  ]);
  assert.deepEqual(progress, [40, 80, 100]);
});

test('retries the interrupted range without restarting earlier chunks', async () => {
  const payload = Buffer.from('abcdefgh');
  const requestedRanges = [];
  const retries = [];
  let failedSecondRange = false;
  const archive = await downloadBufferWithRanges({
    url: 'https://example.test/connector.zip',
    expectedSize: payload.length,
    chunkSize: 4,
    maxAttempts: 2,
    retryDelayMs: 0,
    fetchImpl: async (_url, init) => {
      const range = init?.headers?.Range;
      requestedRanges.push(range);
      if (range === 'bytes=4-7' && !failedSecondRange) {
        failedSecondRange = true;
        throw new TypeError('connection closed');
      }
      return partialResponse(payload, range);
    },
    onRetry: item => retries.push(item)
  });

  assert.deepEqual(archive, payload);
  assert.deepEqual(requestedRanges, [
    'bytes=0-3',
    'bytes=4-7',
    'bytes=4-7'
  ]);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].start, 4);
  assert.match(retries[0].error, /connection closed/);
});

test('accepts a complete response when a server ignores the first range', async () => {
  const payload = Buffer.from('complete archive');
  const archive = await downloadBufferWithRanges({
    url: 'https://example.test/connector.zip',
    expectedSize: payload.length,
    chunkSize: 4,
    fetchImpl: async () => new Response(payload, { status: 200 })
  });

  assert.deepEqual(archive, payload);
});

test('rejects a mismatched content range', async () => {
  await assert.rejects(
    downloadBufferWithRanges({
      url: 'https://example.test/connector.zip',
      expectedSize: 8,
      chunkSize: 4,
      maxAttempts: 1,
      fetchImpl: async () => new Response(Buffer.from('abcd'), {
        status: 206,
        headers: { 'Content-Range': 'bytes 1-4/8' }
      })
    }),
    /下载分块范围不匹配/
  );
});

test('retries a whole-file download and verifies its exact size', async () => {
  const payload = Buffer.from('small framework-dependent package');
  const retries = [];
  let calls = 0;
  const archive = await downloadWholeBufferWithRetries({
    url: 'https://example.test/framework-dependent.zip',
    expectedSize: payload.length,
    maxAttempts: 2,
    retryDelayMs: 0,
    fetchImpl: async (_url, init) => {
      calls += 1;
      assert.equal(init?.headers, undefined);
      if (calls === 1) return new Response('temporary', { status: 503 });
      return new Response(payload, { status: 200 });
    },
    onRetry: retry => retries.push(retry)
  });

  assert.deepEqual(archive, payload);
  assert.equal(calls, 2);
  assert.equal(retries.length, 1);
  assert.equal(retries[0].start, 0);
  assert.equal(retries[0].end, payload.length - 1);
});

function downloadErrorWith(kind, status, message) {
  return error => {
    assert.equal(error instanceof ConnectorDownloadError, true);
    assert.equal(isConnectorDownloadError(error), true);
    assert.equal(error.kind, kind);
    assert.equal(error.status, status);
    if (message) assert.match(error.message, message);
    return true;
  };
}

for (const status of [403, 404]) {
  test(`HTTP ${status} fails both downloaders after a single request`, async () => {
    for (const download of [downloadBufferWithRanges, downloadWholeBufferWithRetries]) {
      let calls = 0;
      const retries = [];
      await assert.rejects(
        download({
          url: 'https://example.test/missing.zip',
          expectedSize: 8,
          chunkSize: 4,
          retryDelayMs: 0,
          fetchImpl: async () => {
            calls += 1;
            return new Response('missing', { status });
          },
          onRetry: retry => retries.push(retry)
        }),
        downloadErrorWith('http', status, new RegExp(`HTTP ${status}`))
      );
      assert.equal(calls, 1, download.name);
      assert.deepEqual(retries, []);
    }
  });
}

test('ranged downloads keep retrying 503, 429 and 408 responses', async () => {
  const payload = Buffer.from('abcdefgh');
  const failures = [503, 429, 408];
  const retries = [];
  let calls = 0;
  const archive = await downloadBufferWithRanges({
    url: 'https://example.test/connector.zip',
    expectedSize: payload.length,
    chunkSize: 8,
    maxAttempts: 4,
    retryDelayMs: 0,
    fetchImpl: async (_url, init) => {
      calls += 1;
      const status = failures.shift();
      return status
        ? new Response('busy', { status })
        : partialResponse(payload, init?.headers?.Range);
    },
    onRetry: retry => retries.push(retry.error)
  });
  assert.deepEqual(archive, payload);
  assert.equal(calls, 4);
  assert.deepEqual(retries, ['下载 HTTP 503', '下载 HTTP 429', '下载 HTTP 408']);
});

test('exhausted retries report a typed error with the existing message', async () => {
  await assert.rejects(
    downloadBufferWithRanges({
      url: 'https://example.test/connector.zip',
      expectedSize: 8,
      maxAttempts: 2,
      retryDelayMs: 0,
      fetchImpl: async () => new Response('busy', { status: 503 })
    }),
    downloadErrorWith('http', 503, /^下载分块 0-7 失败：下载 HTTP 503$/)
  );
  await assert.rejects(
    downloadWholeBufferWithRetries({
      url: 'https://example.test/connector.zip',
      expectedSize: 8,
      maxAttempts: 2,
      retryDelayMs: 0,
      fetchImpl: async () => { throw new TypeError('fetch failed'); }
    }),
    downloadErrorWith('network', undefined, /^完整下载失败：fetch failed$/)
  );
  await assert.rejects(
    downloadWholeBufferWithRetries({
      url: 'https://example.test/connector.zip',
      expectedSize: 8,
      maxAttempts: 2,
      retryDelayMs: 0,
      fetchImpl: async () => new Response(Buffer.from('short'), { status: 200 })
    }),
    downloadErrorWith('size', undefined, /下载文件大小不匹配：5\/8/)
  );
});
