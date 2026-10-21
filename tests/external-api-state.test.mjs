import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildExternalApiState,
  sanitizeExternalSong
} from '../electron/external-api-state.ts';

const player = {
  key: 'netease',
  name: '网易云音乐',
  connected: true,
  connecting: false,
  processId: 1234,
  version: '3.1.37',
  status: 'ready'
};

test('publishes explicit request intake and queue playback states', () => {
  const state = buildExternalApiState({
    appVersion: '1.1.3',
    timestamp: '2026-08-03T00:00:00.000Z',
    player,
    currentSong: {
      Id: 1403356922,
      SongName: 'Test Song',
      ArtistName: 'Test Artist',
      CoverUrl: 'https://example.com/album.jpg',
      DynamicCoverUrl: 'https://mvod.itunes.apple.com/cover.m3u8',
      OrderedByAvatar: 'https://example.com/avatar.jpg'
    },
    currentIsRequested: true,
    queue: [{ Id: 'next', SongName: 'Next Song', OrderedBy: 'viewer' }],
    acceptingRequests: false,
    queuePlaybackEnabled: true,
    pausedAfterRequests: false,
    commandQueue: { pending: 0, processing: false }
  });

  assert.equal(state.schemaVersion, 1);
  assert.equal(state.timestamp, '2026-08-03T00:00:00.000Z');
  assert.equal(state.current?.id, '1403356922');
  assert.equal(state.current?.coverUrl, 'https://example.com/album.jpg');
  assert.equal(state.current?.dynamicCoverUrl, 'https://mvod.itunes.apple.com/cover.m3u8');
  assert.equal(
    state.current?.requestedByAvatar,
    'https://example.com/avatar.jpg'
  );
  assert.equal(state.queueLength, 1);
  assert.deepEqual(state.service, {
    requestIntake: { enabled: false, state: 'paused' },
    queuePlayback: { enabled: true, state: 'running' }
  });
  assert.equal(state.accepting, false);
  assert.equal(state.playing, true);
  assert.deepEqual(state.requestNotifications, []);
});

test('sanitizes malformed optional song fields without leaking native data', () => {
  const song = sanitizeExternalSong({
    Id: 0,
    SongName: null,
    ArtistName: 'Artist',
    GuardLevel: 'not-a-number',
    NativeData: 'private-player-payload',
    unexpected: 'ignored'
  });

  assert.deepEqual(song, {
    id: '0',
    title: '',
    artist: 'Artist',
    album: '',
    coverUrl: '',
    dynamicCoverUrl: '',
    requestedBy: '',
    requestedByUid: '',
    requestedByAvatar: '',
    guardLevel: 0
  });
  assert.equal(Object.hasOwn(song || {}, 'NativeData'), false);
  assert.equal(Object.hasOwn(song || {}, 'unexpected'), false);
});

test('drops non-object queue entries and reports the sanitized queue length', () => {
  const state = buildExternalApiState({
    appVersion: '1.1.3',
    player,
    currentSong: null,
    currentIsRequested: false,
    queue: [null, 'invalid', { Id: 'valid', SongName: 'Valid' }],
    acceptingRequests: true,
    queuePlaybackEnabled: false,
    pausedAfterRequests: true,
    commandQueue: { pending: 2, processing: true }
  });

  assert.equal(state.current, null);
  assert.equal(state.queueLength, 1);
  assert.equal(state.queue[0]?.id, 'valid');
  assert.deepEqual(state.service.queuePlayback, {
    enabled: false,
    state: 'paused'
  });
});

test('publishes bounded public request feedback without native or credential data', () => {
  const now = Date.now();
  const notification = {
    id: 'request-1', kind: 'success', title: '歌名', message: '点歌成功',
    requestedBy: '观众', createdAt: now, expiresAt: now + 6_000
  };
  const state = buildExternalApiState({
    appVersion: '1.2.4', player, currentSong: null, currentIsRequested: false,
    queue: [], acceptingRequests: true, queuePlaybackEnabled: true,
    pausedAfterRequests: false, commandQueue: { pending: 0, processing: false },
    requestNotifications: [
      { ...notification, NativeData: 'secret', cookie: 'secret' },
      { ...notification, id: 'expired', createdAt: now - 10_000, expiresAt: now - 1 }
    ]
  });
  assert.deepEqual(state.requestNotifications, [{ ...notification, action: 'request' }]);
  assert.equal(JSON.stringify(state).includes('secret'), false);
});

test('request notifications name their action, defaulting to a viewer request', () => {
  const now = Date.now();
  const notification = {
    kind: 'cancelled', title: '歌名', message: '主播已将歌曲移出待播队列',
    requestedBy: '主播', createdAt: now, expiresAt: now + 6_000
  };
  const state = buildExternalApiState({
    appVersion: '1.2.6', player, currentSong: null, currentIsRequested: false,
    queue: [], acceptingRequests: true, queuePlaybackEnabled: true,
    pausedAfterRequests: false, commandQueue: { pending: 0, processing: false },
    requestNotifications: [
      { ...notification, id: 'legacy' },
      { ...notification, id: 'withdrawal', action: 'cancel' },
      { ...notification, id: 'removal', action: 'remove' },
      { ...notification, id: 'unknown', action: 'delete-everything' }
    ]
  });
  assert.equal(state.schemaVersion, 1);
  assert.deepEqual(state.requestNotifications.map(item => [item.id, item.action]), [
    ['legacy', 'request'], ['withdrawal', 'cancel'], ['removal', 'remove'], ['unknown', 'request']
  ]);
});

test('queue songs never expose the internal request identity', () => {
  const state = buildExternalApiState({
    appVersion: '1.2.6', player, currentSong: { Id: 'now', RequestId: 'internal-request' },
    currentIsRequested: true, queue: [{ Id: 'next', RequestId: 'internal-request-2' }],
    acceptingRequests: true, queuePlaybackEnabled: true, pausedAfterRequests: false,
    commandQueue: { pending: 0, processing: false }
  });
  assert.equal(JSON.stringify(state).includes('internal-request'), false);
});
