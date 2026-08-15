import test from 'node:test';
import assert from 'node:assert/strict';
import { getFeedbackStatus } from '../electron/feedback-service.ts';

test('queries the public feedback endpoint without requiring a success field', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = async url => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({
      id: 'FB-20260809-ABCDEF12',
      createdAt: '2026-08-09T10:00:00.000Z',
      updatedAt: '2026-08-09T10:05:00.000Z',
      category: 'bug',
      status: 'working',
      title: '播放器没有响应',
      reply: '正在排查。'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  try {
    const result = await getFeedbackStatus(' fb-20260809-abcdef12 ');
    assert.equal(
      requestedUrl,
      'https://app.enkianss.us/api/v1/feedback/FB-20260809-ABCDEF12'
    );
    assert.equal(result.reply, '正在排查。');
    assert.equal(result.status, 'working');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects an invalid feedback id before requesting the network', async () => {
  const originalFetch = globalThis.fetch;
  let requested = false;
  globalThis.fetch = async () => {
    requested = true;
    return new Response('{}');
  };
  try {
    await assert.rejects(
      () => getFeedbackStatus('../private'),
      /问题编号格式无效/
    );
    assert.equal(requested, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
