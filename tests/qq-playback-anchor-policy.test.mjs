import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isQqPlaybackAnchorMissing,
  planQqDeferredPlaybackAction,
  planQqAnchorObservation,
  shouldDeferQqQueueHeadUntilAnchor,
  shouldSkipDuplicateQqAnchorInsert,
  shouldSuppressQqQueueHeadPlayNow,
  QQ_PLAYBACK_ANCHOR_MISSING_FAILURE_CODE
} from '../electron/qq-playback-anchor-policy.ts';

const head = 'qqmusic|id:100';

test('QQ without an explicit playback anchor stays deferred', () => {
  assert.equal(shouldDeferQqQueueHeadUntilAnchor({
    playerKey: 'qqmusic',
    playbackAnchorReady: false
  }), true);
  assert.equal(shouldDeferQqQueueHeadUntilAnchor({
    playerKey: 'qqmusic',
    playbackAnchorReady: undefined
  }), true);
  assert.equal(shouldDeferQqQueueHeadUntilAnchor({
    playerKey: 'qqmusic',
    playbackAnchorReady: true
  }), false);
  assert.equal(shouldDeferQqQueueHeadUntilAnchor({
    playerKey: 'netease',
    playbackAnchorReady: false
  }), false);
});

test('only QQ InsertNext reports the cold-start anchor failure', () => {
  assert.equal(isQqPlaybackAnchorMissing({
    playerKey: 'qqmusic',
    command: 'InsertNext',
    failureCode: QQ_PLAYBACK_ANCHOR_MISSING_FAILURE_CODE
  }), true);
  assert.equal(isQqPlaybackAnchorMissing({
    playerKey: 'qqmusic',
    command: 'PlaySelected',
    failureCode: QQ_PLAYBACK_ANCHOR_MISSING_FAILURE_CODE
  }), false);
  assert.equal(isQqPlaybackAnchorMissing({
    playerKey: 'netease',
    command: 'InsertNext',
    failureCode: QQ_PLAYBACK_ANCHOR_MISSING_FAILURE_CODE
  }), false);
});

test('QQ cold-start deferral waits for a real current track', () => {
  const base = {
    playerKey: 'qqmusic',
    deferredIdentity: head,
    queueHeadIdentity: head,
    retryAttempted: false,
    retryInFlight: false
  };
  assert.equal(planQqAnchorObservation({
    ...base,
    playbackAnchorReady: false
  }), 'none');
  assert.equal(planQqAnchorObservation({
    ...base,
    playbackAnchorReady: true
  }), 'retry');
  assert.equal(planQqAnchorObservation({
    ...base,
    playbackAnchorReady: true,
    retryAttempted: true
  }), 'none');
});

test('the first real QQ anchor takes over the deferred head instead of InsertNext', () => {
  const base = {
    playerKey: 'qqmusic',
    deferredIdentity: head,
    queueHeadIdentity: head,
    retryAttempted: false,
    retryInFlight: false
  };
  assert.equal(planQqDeferredPlaybackAction({
    ...base,
    playbackAnchorReady: false
  }), 'none');
  assert.equal(planQqDeferredPlaybackAction({
    ...base,
    playbackAnchorReady: true
  }), 'takeover-now');
  assert.equal(planQqDeferredPlaybackAction({
    ...base,
    playbackAnchorReady: true,
    retryAttempted: true
  }), 'none');
  assert.equal(planQqDeferredPlaybackAction({
    ...base,
    playbackAnchorReady: true,
    retryInFlight: true
  }), 'none');
});

test('a deferred QQ head is cleared when the queue head changes', () => {
  assert.equal(planQqAnchorObservation({
    playerKey: 'qqmusic',
    playbackAnchorReady: true,
    deferredIdentity: head,
    queueHeadIdentity: 'qqmusic|id:200',
    retryAttempted: false,
    retryInFlight: false
  }), 'clear');
});

test('repeated cold-start attempts do not call InsertNext again', () => {
  assert.equal(shouldSkipDuplicateQqAnchorInsert({
    playerKey: 'qqmusic',
    songIdentity: head,
    deferredIdentity: head,
    playbackAnchorReady: false,
    retryAttempted: false,
    retryInFlight: false
  }), true);
  assert.equal(shouldSkipDuplicateQqAnchorInsert({
    playerKey: 'qqmusic',
    songIdentity: head,
    deferredIdentity: head,
    playbackAnchorReady: true,
    retryAttempted: false,
    retryInFlight: false
  }), false);
});

test('first-anchor retry never falls back to PlaySelected', () => {
  const base = {
    playerKey: 'qqmusic',
    queueHeadIdentity: head,
    deferredIdentity: head,
    playbackAnchorReady: true
  };
  assert.equal(shouldSuppressQqQueueHeadPlayNow({
    ...base,
    retryAttempted: true,
    retryInFlight: false
  }), true);
  assert.equal(shouldSuppressQqQueueHeadPlayNow({
    ...base,
    retryAttempted: false,
    retryInFlight: true
  }), true);
  assert.equal(shouldSuppressQqQueueHeadPlayNow({
    ...base,
    playbackAnchorReady: false,
    retryAttempted: false,
    retryInFlight: false
  }), true);
  assert.equal(shouldSuppressQqQueueHeadPlayNow({
    ...base,
    retryAttempted: false,
    retryInFlight: false
  }), false);
});
