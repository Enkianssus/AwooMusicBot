import assert from 'node:assert/strict';
import test from 'node:test';
import {
  planQueueHeadMutation,
  queueSongIdentity
} from '../electron/queue-head-policy.ts';

const song = id => queueSongIdentity(
  { Id: id, SongName: `Song ${id}`, PlayerKey: 'netease' },
  'netease'
);

test('first local queue head is inserted exactly once', () => {
  assert.equal(planQueueHeadMutation({
    previousHeadIdentity: '',
    nextHeadIdentity: song('A'),
    hadRegisteredNext: false,
    isPlaying: true
  }), 'insert');
});

test('appending later songs does not touch the native queue head', () => {
  assert.equal(planQueueHeadMutation({
    previousHeadIdentity: song('A'),
    nextHeadIdentity: song('A'),
    hadRegisteredNext: true,
    isPlaying: true
  }), 'none');
});

test('changing a registered head only replaces the fallback guard', () => {
  assert.equal(planQueueHeadMutation({
    previousHeadIdentity: song('A'),
    nextHeadIdentity: song('B'),
    hadRegisteredNext: true,
    isPlaying: true
  }), 'arm-only');
});

test('removing the final registered head marks its native copy for skipping', () => {
  assert.equal(planQueueHeadMutation({
    previousHeadIdentity: song('A'),
    nextHeadIdentity: '',
    hadRegisteredNext: true,
    isPlaying: true
  }), 'cancel-native');
});

test('paused ordering never inserts into a player queue', () => {
  assert.equal(planQueueHeadMutation({
    previousHeadIdentity: '',
    nextHeadIdentity: song('A'),
    hadRegisteredNext: false,
    isPlaying: false
  }), 'none');
});

test('changing an already inserted head while paused only retargets its guard', () => {
  assert.equal(planQueueHeadMutation({
    previousHeadIdentity: song('A'),
    nextHeadIdentity: song('B'),
    hadRegisteredNext: true,
    isPlaying: false
  }), 'arm-only');
});
