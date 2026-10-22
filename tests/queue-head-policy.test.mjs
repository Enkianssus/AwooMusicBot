import assert from 'node:assert/strict';
import test from 'node:test';
import {
  planImmediatePlaybackCommand,
  planGuardedQqMismatchAction,
  planManagedActionTimeout,
  planQqGuardTerminalRecovery,
  planQqGuardedCompletionRecovery,
  planObservedNextAction,
  planQueueHeadCorrection,
  planQueueHeadMutation,
  QQ_GUARDED_COMPLETION_RECOVERY_WINDOW_MS,
  QUEUE_HEAD_CORRECTION_MAX_ATTEMPTS,
  QUEUE_HEAD_CORRECTION_WINDOW_MS,
  ownsQqGuardedCompletion,
  queueSongIdentity,
  shouldRecordQqGuardedCompletion,
  shouldRetainQqGuardedCompletionAttempt,
  shouldDeferManagedTrackObservation,
  shouldPreserveGuardAfterImmediate,
  shouldRepairObservedNext,
  tracksHaveDifferentStableIds,
  tracksRepresentSameSong
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

test('observed fallback ID still matches the numeric queue item metadata', () => {
  assert.equal(tracksRepresentSameSong(
    {
      Id: '3404096928',
      SongName: 'WannaCry',
      ArtistName: 'Ninajirachi / Porter Robinson'
    },
    {
      id: 'WannaCry|Ninajirachi、Porter Robinson',
      title: 'WannaCry',
      artist: 'Ninajirachi、Porter Robinson'
    }
  ), true);
});

test('instrumental aliases match only the same singer', () => {
  const expected = {
    Id: '395562465',
    SongName: 'September (纯音乐)',
    ArtistName: 'Sparky Deathcap',
    PlayerKey: 'qqmusic'
  };
  assert.equal(tracksRepresentSameSong(expected, {
    id: 'September (Instrumental)|Sparky Deathcap',
    title: 'September (Instrumental)',
    artist: 'Sparky Deathcap'
  }), true);
  assert.equal(tracksRepresentSameSong(expected, {
    id: 'September|Sparky Deathcap',
    title: 'September',
    artist: 'Sparky Deathcap'
  }), false);
  assert.equal(tracksRepresentSameSong(expected, {
    id: 'September (Live)|Sparky Deathcap',
    title: 'September (Live)',
    artist: 'Sparky Deathcap'
  }), false);
  assert.equal(tracksRepresentSameSong(expected, {
    id: 'September (Remix)|Sparky Deathcap',
    title: 'September (Remix)',
    artist: 'Sparky Deathcap'
  }), false);
  assert.equal(tracksRepresentSameSong(expected, {
    id: 'September (Inst.)|Other Artist',
    title: 'September (Inst.)',
    artist: 'Other Artist'
  }), false);
  assert.equal(tracksRepresentSameSong({
    ...expected,
    PlayerKey: 'netease'
  }, {
    id: 'September (Inst.)|Sparky Deathcap',
    title: 'September (Inst.)',
    artist: 'Sparky Deathcap'
  }), false);
});

test('different stable IDs are an authoritative track transition', () => {
  assert.equal(tracksHaveDifferentStableIds(
    { id: '1839140774', title: 'Musician', artist: 'Porter Robinson' },
    { id: '3404096928', title: 'Musician', artist: 'Porter Robinson' }
  ), true);
});

test('title fallback becoming a stable ID is metadata enrichment, not a transition', () => {
  assert.equal(tracksHaveDifferentStableIds(
    { id: 'Musician|Porter Robinson', title: 'Musician', artist: 'Porter Robinson' },
    { id: '1839140774', title: 'Musician', artist: 'Porter Robinson' }
  ), false);
});

test('same title from a different artist is not treated as the queue head', () => {
  assert.equal(tracksRepresentSameSong(
    { Id: '1', SongName: 'Home', ArtistName: 'Artist A' },
    { id: 'Home|Artist B', title: 'Home', artist: 'Artist B' }
  ), false);
});

test('different stable IDs stay different even when metadata is identical', () => {
  assert.equal(tracksRepresentSameSong(
    { Id: '111', SongName: 'Same', ArtistName: 'Artist' },
    { id: '222', title: 'Same', artist: 'Artist' }
  ), false);
});

// FB-20261021-CDCE7CDE: KuGou played the request under another numeric ID.
const kugouRequest = {
  Id: '303222240',
  SongName: '青藏高原',
  ArtistName: '李娜',
  PlayerKey: 'kugou'
};

test('KuGou pairs different numeric IDs by the same title and artist', () => {
  assert.equal(tracksRepresentSameSong(kugouRequest, {
    id: '317243695', title: '青藏高原', artist: '李娜'
  }), true);
  // The shape main.ts stores for the player's current track.
  assert.equal(tracksRepresentSameSong(kugouRequest, {
    Id: '317243695', SongName: '青藏高原 ', ArtistName: ' 李娜'
  }), true);
  assert.equal(tracksRepresentSameSong(
    { ...kugouRequest, ArtistName: '李娜、腾格尔' },
    { id: '317243695', title: '青藏高原', artist: '李娜 / 腾格尔' }
  ), true);
});

test('KuGou keeps different IDs apart without the same title and known artist', () => {
  for (const observed of [
    { id: '548045966', title: '夜夜夜夜', artist: '李娜' },
    { id: '317243695', title: '青藏高原', artist: '韩红' },
    { id: '317243695', title: '青藏高原 (Live)', artist: '李娜' },
    { id: '317243695', title: '青藏高原', artist: '' },
    { Id: '317243695', SongName: '青藏高原', ArtistName: '未知歌手' }
  ]) {
    assert.equal(tracksRepresentSameSong(kugouRequest, observed), false, JSON.stringify(observed));
  }
  // Two unknown artists are a title-only match, which is not enough.
  assert.equal(tracksRepresentSameSong(
    { ...kugouRequest, ArtistName: '未知歌手' },
    { Id: '317243695', SongName: '青藏高原', ArtistName: '未知歌手' }
  ), false);
});

test('other players keep different stable IDs apart despite identical metadata', () => {
  for (const PlayerKey of ['netease', 'qqmusic', 'folia', undefined]) {
    assert.equal(tracksRepresentSameSong({ ...kugouRequest, PlayerKey }, {
      id: '317243695', title: '青藏高原', artist: '李娜'
    }), false, String(PlayerKey));
  }
});

test('a KuGou request under another ID confirms its action and native next', () => {
  const nowPlaying = { id: '317243695', title: '青藏高原', artist: '李娜' };
  assert.equal(shouldDeferManagedTrackObservation(kugouRequest, nowPlaying), false);
  assert.equal(shouldRepairObservedNext(kugouRequest, nowPlaying, 'track'), false);
  // Track-change detection compares player tracks, which carry no player
  // key, so a new KuGou ID is still a transition there.
  assert.equal(tracksRepresentSameSong(
    { id: '303222240', title: '青藏高原', artist: '李娜' },
    nowPlaying
  ), false);
  assert.equal(tracksHaveDifferentStableIds(kugouRequest, nowPlaying), true);
});

test('exact platform ID remains authoritative when metadata is incomplete', () => {
  assert.equal(tracksRepresentSameSong(
    { Id: '218338', SongName: '开不了口', ArtistName: '周杰伦' },
    { id: '218338', title: '', artist: '' }
  ), true);
});

test('same stable ID remains authoritative despite a title variant', () => {
  assert.equal(tracksRepresentSameSong(
    { Id: '395562465', SongName: 'September (纯音乐)', ArtistName: 'Sparky Deathcap' },
    { id: '395562465', title: 'September (Live)', artist: 'Other Artist' }
  ), true);
});

test('QQ guarded queue head releases the host current song to connector recovery', () => {
  assert.equal(planGuardedQqMismatchAction({
    playerKey: 'qqmusic',
    currentSongMismatched: true,
    queueHeadObserved: false,
    queueHeadAlreadyGuarded: true
  }), 'release-to-guard');
});

test('QQ unguarded mismatch keeps the immediate-play fallback', () => {
  assert.equal(planGuardedQqMismatchAction({
    playerKey: 'qqmusic',
    currentSongMismatched: true,
    queueHeadObserved: false,
    queueHeadAlreadyGuarded: false
  }), 'play-now');
});

test('non-QQ and already-observed heads keep the existing mismatch path', () => {
  assert.equal(planGuardedQqMismatchAction({
    playerKey: 'netease',
    currentSongMismatched: true,
    queueHeadObserved: false,
    queueHeadAlreadyGuarded: true
  }), 'play-now');
  assert.equal(planGuardedQqMismatchAction({
    playerKey: 'qqmusic',
    currentSongMismatched: true,
    queueHeadObserved: true,
    queueHeadAlreadyGuarded: true
  }), 'play-now');
  assert.equal(planGuardedQqMismatchAction({
    playerKey: 'qqmusic',
    currentSongMismatched: false,
    queueHeadObserved: false,
    queueHeadAlreadyGuarded: true
  }), 'play-now');
});

test('only a strictly observed QQ guarded head is eligible for completion memory', () => {
  assert.equal(shouldRecordQqGuardedCompletion({
    playerKey: 'qqmusic',
    queueHeadObserved: true,
    queueHeadAlreadyGuarded: true
  }), true);
  assert.equal(shouldRecordQqGuardedCompletion({
    playerKey: 'qqmusic',
    queueHeadObserved: false,
    queueHeadAlreadyGuarded: true
  }), false);
  assert.equal(shouldRecordQqGuardedCompletion({
    playerKey: 'qqmusic',
    queueHeadObserved: true,
    queueHeadAlreadyGuarded: false
  }), false);
  assert.equal(shouldRecordQqGuardedCompletion({
    playerKey: 'netease',
    queueHeadObserved: true,
    queueHeadAlreadyGuarded: true
  }), false);
});

test('QQ guarded completion recovers once within the 8 second window', () => {
  assert.equal(QQ_GUARDED_COMPLETION_RECOVERY_WINDOW_MS, 8_000);
  assert.equal(planQqGuardedCompletionRecovery({
    playerKey: 'qqmusic',
    markerMatchesCurrent: true,
    currentSongMismatched: true,
    ageMs: 6_000,
    rescueAttempted: false
  }), 'recover-once');
});

test('terminal QQ guard recovers once only for the still-registered queue head', () => {
  assert.equal(planQqGuardTerminalRecovery({
    playerKey: 'qqmusic',
    guardState: 'terminalFailure',
    guardId: 7,
    queueHeadIdentity: 'qqmusic|id:shelter',
    registeredGuardIdentity: 'qqmusic|id:shelter',
    registeredGuardId: 7,
    ownershipIdentity: '',
    recoveryAttempted: false
  }), 'recover-once');
  assert.equal(planQqGuardTerminalRecovery({
    playerKey: 'qqmusic',
    guardState: 'terminalFailure',
    guardId: 7,
    queueHeadIdentity: 'qqmusic|id:shelter',
    registeredGuardIdentity: 'qqmusic|id:shelter',
    registeredGuardId: 7,
    ownershipIdentity: 'qqmusic|id:shelter',
    recoveryAttempted: true
  }), 'stop');
  assert.equal(planQqGuardTerminalRecovery({
    playerKey: 'qqmusic',
    guardState: 'terminalFailure',
    guardId: 7,
    queueHeadIdentity: 'qqmusic|id:shelter',
    registeredGuardIdentity: 'qqmusic|id:shelter',
    registeredGuardId: 8,
    ownershipIdentity: '',
    recoveryAttempted: false
  }), 'none');
  assert.equal(planQqGuardTerminalRecovery({
    playerKey: 'qqmusic',
    guardState: 'terminalFailure',
    guardId: 6,
    queueHeadIdentity: 'qqmusic|id:mirror',
    registeredGuardIdentity: 'qqmusic|id:shelter',
    registeredGuardId: 6,
    ownershipIdentity: '',
    recoveryAttempted: false
  }), 'none');
  assert.equal(planQqGuardTerminalRecovery({
    playerKey: 'netease',
    guardState: 'terminalFailure',
    guardId: 7,
    queueHeadIdentity: 'qqmusic|id:shelter',
    registeredGuardIdentity: 'qqmusic|id:shelter',
    registeredGuardId: 7,
    ownershipIdentity: '',
    recoveryAttempted: false
  }), 'none');
});

test('a new request object with the same song does not inherit recovery attempt state', () => {
  const previousRequest = {
    Id: 'same-song',
    SongName: 'Same Song',
    PlayerKey: 'qqmusic'
  };
  const newRequest = {
    Id: 'same-song',
    SongName: 'Same Song',
    PlayerKey: 'qqmusic'
  };

  assert.equal(
    shouldRetainQqGuardedCompletionAttempt(previousRequest, previousRequest),
    true
  );
  assert.equal(
    shouldRetainQqGuardedCompletionAttempt(previousRequest, newRequest),
    false
  );
});

test('QQ completion ownership requires the exact marker reference', () => {
  const marker = {};
  assert.equal(ownsQqGuardedCompletion({
    playerKey: 'qqmusic',
    marker,
    expectedMarker: marker
  }), true);
  assert.equal(ownsQqGuardedCompletion({
    playerKey: 'qqmusic',
    marker: {},
    expectedMarker: marker
  }), false);
  assert.equal(ownsQqGuardedCompletion({
    playerKey: 'netease',
    marker,
    expectedMarker: marker
  }), false);
});

test('QQ guarded completion gives manual control at the 8 second boundary', () => {
  assert.equal(planQqGuardedCompletionRecovery({
    playerKey: 'qqmusic',
    markerMatchesCurrent: true,
    currentSongMismatched: true,
    ageMs: QQ_GUARDED_COMPLETION_RECOVERY_WINDOW_MS,
    rescueAttempted: false
  }), 'manual-wins');
  assert.equal(planQqGuardedCompletionRecovery({
    playerKey: 'qqmusic',
    markerMatchesCurrent: true,
    currentSongMismatched: true,
    ageMs: 20_000,
    rescueAttempted: false
  }), 'manual-wins');
});

test('already attempted QQ recovery stops without another automatic takeover', () => {
  assert.equal(planQqGuardedCompletionRecovery({
    playerKey: 'qqmusic',
    markerMatchesCurrent: true,
    currentSongMismatched: true,
    ageMs: 6_000,
    rescueAttempted: true
  }), 'stop');
});

test('QQ recovery marker mismatch and non-QQ keep the manual path unchanged', () => {
  assert.equal(planQqGuardedCompletionRecovery({
    playerKey: 'qqmusic',
    markerMatchesCurrent: false,
    currentSongMismatched: true,
    ageMs: 1_000,
    rescueAttempted: false
  }), 'none');
  assert.equal(planQqGuardedCompletionRecovery({
    playerKey: 'netease',
    markerMatchesCurrent: true,
    currentSongMismatched: true,
    ageMs: 1_000,
    rescueAttempted: false
  }), 'none');
  assert.equal(planImmediatePlaybackCommand({
    playerKey: 'qqmusic',
    mode: 'interrupt',
    hasCurrentSong: true
  }), 'InterruptSelected');
});

test('unconfirmed managed action restores observed playback after timeout', () => {
  assert.equal(planManagedActionTimeout({
    targetObserved: false,
    targetStillCurrent: true,
    previousCurrentObserved: true
  }), 'restore-previous');
  assert.equal(planManagedActionTimeout({
    targetObserved: false,
    targetStillCurrent: true,
    previousCurrentObserved: false
  }), 'clear-requested');
  assert.equal(planManagedActionTimeout({
    targetObserved: true,
    targetStillCurrent: true,
    previousCurrentObserved: false
  }), 'keep-requested');
  assert.equal(planManagedActionTimeout({
    targetObserved: false,
    targetStillCurrent: false,
    previousCurrentObserved: true
  }), 'keep-requested');
});

test('real next-track observation suppresses duplicate insertion', () => {
  const expected = {
    Id: '3404096928',
    SongName: 'WannaCry',
    ArtistName: 'Ninajirachi/Porter Robinson'
  };
  assert.equal(shouldRepairObservedNext(expected, {
    id: '3404096928',
    title: 'WannaCry',
    artist: 'Ninajirachi/Porter Robinson'
  }), false);
});

test('missing or mismatched next-track observation requests repair', () => {
  const expected = {
    Id: '3404096928',
    SongName: 'WannaCry',
    ArtistName: 'Ninajirachi/Porter Robinson'
  };
  assert.equal(shouldRepairObservedNext(expected, null), true);
  assert.equal(shouldRepairObservedNext(expected, {
    id: 'other',
    title: 'Shelter',
    artist: 'Porter Robinson/Madeon'
  }), true);
});

test('unknown QQ next-track state never requests a speculative reinsert', () => {
  const expected = {
    Id: '3404096928',
    SongName: 'WannaCry',
    ArtistName: 'Ninajirachi/Porter Robinson'
  };

  assert.equal(
    shouldRepairObservedNext(expected, null, 'unknown'),
    false
  );
  assert.equal(
    shouldRepairObservedNext(expected, null, 'empty'),
    true
  );
});

test('normal A followed by immediate B only rearms preserved A', () => {
  const shelter = {
    Id: '201423402',
    SongName: 'Shelter',
    ArtistName: 'Porter Robinson/Madeon'
  };

  assert.equal(planObservedNextAction({
    expected: shelter,
    observedNext: null,
    nextObservation: 'unknown',
    preserveInsertedHead: true,
    expectedAlreadyGuarded: false
  }), 'arm-only');
});

test('unknown QQ next does not reinsert an already guarded queue head', () => {
  const shelter = {
    Id: '201423402',
    SongName: 'Shelter',
    ArtistName: 'Porter Robinson/Madeon'
  };

  assert.equal(planObservedNextAction({
    expected: shelter,
    observedNext: null,
    nextObservation: 'unknown',
    preserveInsertedHead: false,
    expectedAlreadyGuarded: true
  }), 'none');
});

test('unknown QQ next inserts a newly advanced unguarded queue head once', () => {
  assert.equal(planObservedNextAction({
    expected: {
      Id: 'next-b',
      SongName: 'Next B',
      ArtistName: 'Artist'
    },
    observedNext: null,
    nextObservation: 'unknown',
    preserveInsertedHead: false,
    expectedAlreadyGuarded: false
  }), 'insert');
});

test('confirmed mismatched next still requests native repair', () => {
  assert.equal(planObservedNextAction({
    expected: {
      Id: '201423402',
      SongName: 'Shelter',
      ArtistName: 'Porter Robinson/Madeon'
    },
    observedNext: {
      id: '80605719',
      title: 'Mirror',
      artist: 'Porter Robinson'
    },
    nextObservation: 'track',
    preserveInsertedHead: false,
    expectedAlreadyGuarded: false
  }), 'insert');
});

test('QQ interrupt uses the preserve-current native transaction', () => {
  assert.equal(planImmediatePlaybackCommand({
    playerKey: 'qqmusic',
    mode: 'interrupt',
    hasCurrentSong: true
  }), 'InterruptSelected');
  assert.equal(planImmediatePlaybackCommand({
    playerKey: 'qqmusic',
    mode: 'play-now',
    hasCurrentSong: true
  }), 'PlaySelected');
  assert.equal(planImmediatePlaybackCommand({
    playerKey: 'kugou',
    mode: 'interrupt',
    hasCurrentSong: true
  }), 'PlaySelected');
});

test('managed previous-track transition is deferred until the final target', () => {
  const mirror = {
    Id: '80605719',
    SongName: 'Mirror',
    ArtistName: 'Porter Robinson'
  };
  assert.equal(shouldDeferManagedTrackObservation(mirror, {
    id: 'previous-native-song',
    title: 'Previous native song',
    artist: 'Artist'
  }), true);
  assert.equal(shouldDeferManagedTrackObservation(mirror, {
    id: '80605719',
    title: 'Mirror',
    artist: 'Porter Robinson'
  }), false);
});

test('QQ interrupt always preserves the displaced current song as guard', () => {
  assert.equal(shouldPreserveGuardAfterImmediate({
    command: 'InterruptSelected',
    hadRegisteredGuard: false,
    hasDisplacedCurrentSong: true
  }), true);
  assert.equal(shouldPreserveGuardAfterImmediate({
    command: 'PlaySelected',
    hadRegisteredGuard: false,
    hasDisplacedCurrentSong: true
  }), false);
});

const correctionHead = { Id: '303222240', SongName: '青藏高原', PlayerKey: 'kugou' };
const planCorrection = (state, now, queueHead = correctionHead) =>
  planQueueHeadCorrection({
    state,
    queueHead,
    queueHeadIdentity: queueSongIdentity(queueHead, 'kugou'),
    now
  });

test('a queue head gets two corrections, then one stop and only holds', () => {
  assert.equal(QUEUE_HEAD_CORRECTION_MAX_ATTEMPTS, 2);
  const first = planCorrection(null, 1_000);
  assert.deepEqual(first, {
    action: 'correct',
    state: {
      song: correctionHead,
      identity: 'kugou|id:303222240',
      attempts: 1,
      lastAttemptAt: 1_000,
      stopped: false
    }
  });
  const second = planCorrection(first.state, 9_500);
  assert.equal(second.action, 'correct');
  assert.equal(second.state.attempts, 2);
  const third = planCorrection(second.state, 18_000);
  assert.equal(third.action, 'stop');
  assert.equal(third.state.stopped, true);
  assert.equal(third.state.attempts, 2);
  // The hold does not expire on its own; only a cleared state lifts it.
  for (const now of [26_500, 18_000 + QUEUE_HEAD_CORRECTION_WINDOW_MS, 3_600_000]) {
    const held = planCorrection(third.state, now);
    assert.equal(held.action, 'hold');
    assert.equal(held.state, third.state);
  }
});

test('a new head or a new request for the same song starts over', () => {
  const stopped = planCorrection(
    planCorrection(planCorrection(null, 1_000).state, 2_000).state,
    3_000
  ).state;
  assert.equal(stopped.stopped, true);
  const nextHead = { Id: '548045966', SongName: '夜夜夜夜', PlayerKey: 'kugou' };
  for (const queueHead of [nextHead, { ...correctionHead }]) {
    const plan = planCorrection(stopped, 4_000, queueHead);
    assert.equal(plan.action, 'correct');
    assert.equal(plan.state.song, queueHead);
    assert.equal(plan.state.attempts, 1);
    assert.equal(plan.state.stopped, false);
  }
  // A changed identity on the same object, e.g. a newly resolved ID, too.
  assert.equal(planQueueHeadCorrection({
    state: stopped,
    queueHead: correctionHead,
    queueHeadIdentity: 'kugou|id:317243695',
    now: 4_000
  }).action, 'correct');
});

test('a correction continues the row only within the window of the previous one', () => {
  const second = planCorrection(planCorrection(null, 0).state, 50_000).state;
  assert.equal(second.attempts, 2);
  assert.equal(
    planCorrection(second, 50_000 + QUEUE_HEAD_CORRECTION_WINDOW_MS - 1).action,
    'stop'
  );
  const restarted = planCorrection(second, 50_000 + QUEUE_HEAD_CORRECTION_WINDOW_MS);
  assert.equal(restarted.action, 'correct');
  assert.equal(restarted.state.attempts, 1);
  // A clock that went backwards starts a new row rather than stopping.
  assert.equal(planCorrection(second, 40_000).state.attempts, 1);
});
