import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import {
  downloadBufferWithRanges,
  downloadWholeBufferWithRetries
} from '../electron/connector-download.ts';

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
