import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { AVATAR_PLACEHOLDER, createAvatarCache } from '../electron/bili-avatar-cache.ts';

function lookupSpy(respond = uid => `https://i0.hdslb.com/face/${uid}.jpg`) {
  const calls = [];
  return { calls, fetchAvatar: async uid => { calls.push(uid); return respond(uid); } };
}

test('concurrent lookups for one viewer share a single request', async () => {
  let finish;
  const calls = [];
  const cache = createAvatarCache({
    fetchAvatar: uid => { calls.push(uid); return new Promise(resolve => { finish = resolve; }); }
  });
  const first = cache.get('42');
  const second = cache.get('42');
  assert.equal(first, second);
  assert.equal(cache.peek('42'), undefined);
  finish('https://face/42.jpg');
  assert.deepEqual(await Promise.all([first, second]), ['https://face/42.jpg', 'https://face/42.jpg']);
  assert.equal(await cache.get('42'), 'https://face/42.jpg');
  assert.equal(cache.peek('42'), 'https://face/42.jpg');
  assert.deepEqual(calls, ['42']);
});

test('avatars expire after the TTL and are fetched again', async () => {
  let now = 0;
  const spy = lookupSpy();
  const cache = createAvatarCache({ ...spy, ttlMs: 1_000, now: () => now });
  await cache.get('1');
  now = 999;
  assert.equal(cache.peek('1'), 'https://i0.hdslb.com/face/1.jpg');
  await cache.get('1');
  assert.equal(spy.calls.length, 1);
  now = 1_000;
  assert.equal(cache.peek('1'), undefined);
  await cache.get('1');
  assert.equal(spy.calls.length, 2);
});

test('the least recently used viewer is evicted at capacity', async () => {
  const spy = lookupSpy();
  const cache = createAvatarCache({ ...spy, maxEntries: 2 });
  await cache.get('1');
  await cache.get('2');
  cache.peek('1');
  await cache.get('3');
  assert.equal(cache.peek('2'), undefined);
  assert.notEqual(cache.peek('1'), undefined);
  assert.notEqual(cache.peek('3'), undefined);
  await cache.get('2');
  assert.deepEqual(spy.calls, ['1', '2', '3', '2']);
});

test('anonymous viewers resolve to the local placeholder without any request', async () => {
  const spy = lookupSpy();
  const cache = createAvatarCache(spy);
  for (const uid of ['0', '', ' 0 ', undefined, null]) {
    assert.equal(await cache.get(uid), AVATAR_PLACEHOLDER);
    assert.equal(cache.peek(uid), AVATAR_PLACEHOLDER);
  }
  assert.deepEqual(spy.calls, []);
});

test('failed lookups fall back to the placeholder and retry after a short time', async () => {
  let now = 0;
  let attempt = 0;
  const cache = createAvatarCache({
    now: () => now,
    fetchAvatar: async () => {
      attempt++;
      if (attempt === 1) throw new Error('HTTP 412');
      return attempt === 2 ? '' : 'https://face/7.jpg';
    }
  });
  assert.equal(await cache.get('7'), AVATAR_PLACEHOLDER);
  assert.equal(cache.peek('7'), AVATAR_PLACEHOLDER);
  now = 59_999;
  assert.equal(await cache.get('7'), AVATAR_PLACEHOLDER);
  assert.equal(attempt, 1);
  now = 60_000;
  assert.equal(await cache.get('7'), AVATAR_PLACEHOLDER);
  now = 120_000;
  assert.equal(await cache.get('7'), 'https://face/7.jpg');
  assert.equal(attempt, 3);
});

test('the placeholder is a local image and main never sends UIDs to a third-party avatar service', () => {
  assert.match(AVATAR_PLACEHOLDER, /^data:image\/svg\+xml,/);
  assert.match(decodeURIComponent(AVATAR_PLACEHOLDER.slice('data:image/svg+xml,'.length)), /^<svg[\s\S]*<\/svg>$/);
  const main = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(main, /dicebear/);
  assert.match(main, /createAvatarCache\(\{ fetchAvatar: fetchBiliAvatar \}\)/);
});
