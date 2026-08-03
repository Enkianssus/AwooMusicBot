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
      ArtistName: 'Test Artist'
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
  assert.equal(state.queueLength, 1);
  assert.deepEqual(state.service, {
    requestIntake: { enabled: false, state: 'paused' },
    queuePlayback: { enabled: true, state: 'running' }
  });
  assert.equal(state.accepting, false);
  assert.equal(state.playing, true);
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
