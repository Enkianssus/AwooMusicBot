import assert from 'node:assert/strict';
import test from 'node:test';
import {
  planImmediatePlaybackCommand,
  planManagedActionTimeout,
  planObservedNextAction,
  planQueueHeadMutation,
  queueSongIdentity,
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
