import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as policy from '../electron/qq-web-autoplay-policy.ts';
import { isSuccessfulPlayerResult } from '../electron/players/types.ts';

test('autoplay suspension and stale generations apply only to the QQ logical owner', () => {
  for (const ownsLogicalNext of [true, false]) {
    for (const playbackEnabled of [true, false]) {
      for (const operationGeneration of [1, 2]) {
        assert.equal(policy.shouldSuspendQqAutoplay(ownsLogicalNext, playbackEnabled), ownsLogicalNext && !playbackEnabled);
        assert.equal(policy.shouldDiscardQqGuardOperation({ ownsLogicalNext, playbackEnabled, generation: 2, operationGeneration }),
          ownsLogicalNext && (!playbackEnabled || operationGeneration !== 2));
      }
    }
  }
});

test('cancel acknowledgement must be applied/verified, never accepted or indeterminate', () => {
  for (const outcome of ['applied', 'verified', 'Applied', 'Verified'])
    assert.equal(policy.isQqAutoplayCancellationConfirmed({ outcome }), true);
  for (const result of [null, undefined, {}, { outcome: 'accepted' }, { outcome: 'indeterminate' }, { outcome: 'rejected' }])
    assert.equal(policy.isQqAutoplayCancellationConfirmed(result), false);
});

const main = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true);
const names = ['isQqAutoplaySuspended', 'discardQqGuardOperation', 'isAutoplayPauseConfirmed',
  'clearQqAutoplayOwnership', 'setQueuePlaybackEnabled', 'serializeNextGuardOperation',
  'guardNextSong', 'armNextGuardOnly', 'syncTrackChangeLogic'];
const source = names.map(name => {
  const declaration = parsed.statements.find(value => ts.isFunctionDeclaration(value) && value.name?.text === name);
  assert.ok(declaration, name);
  return declaration.getText(parsed);
}).join('\n');
const javascript = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }
}).outputText;
const songA = { Id: 'A', SongName: 'A', PlayerKey: 'qqmusic' };
const songB = { Id: 'B', SongName: 'B', PlayerKey: 'qqmusic' };

function deferred() {
  let resolve;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
}

function fixture({ web = true, dispatch = async () => ({ outcome: 'applied' }) } = {}) {
  const commands = [];
  const statuses = [];
  const context = vm.createContext({
    ...policy, isSuccessfulPlayerResult,
    isPlaying: true, isAccepting: false, requestedQueuePlaybackEnabled: true,
    qqAutoplayGeneration: 0, qqAutoplayPauseConfirmed: true,
    nextGuardOperationTail: Promise.resolve(),
    targetQueue: [songA], currentPlayingSong: songB,
    activeManagedPlayerAction: { target: songB },
    registeredNextGuardKey: '', registeredNextGuardSongIdentity: '', registeredNextGuardId: 0,
    queueHeadNeedsGuardOnlyAfterCurrentChange: false, cancelledNativeNextSongs: new Map([['B', songB]]),
    deferredQqInsertIdentity: '', qqDeferredInsertRetryAttempted: false, qqDeferredInsertRetryInFlight: false,
    activePlayerSnapshot: { requiresPlaybackAnchor: false, playbackAnchorReady: true },
    connectorOwnsQqLogicalNext: () => web,
    getSelectedPlayerKey: () => web ? 'qqmusic' : 'netease',
    getQueueSongIdentity: song => song?.Id || '', getNextGuardKey: song => song.Id,
    getResultNextGuardId: () => 123,
    planQqAnchorObservation: () => 'none', shouldSkipDuplicateQqAnchorInsert: () => false,
    shouldDeferQqQueueHeadForMissingAnchor: () => false, isQqPlaybackAnchorMissing: () => false,
    replaceRecentQqGuardedCompletionForNewGuard() {},
    clearRegisteredNextGuard() {
      context.registeredNextGuardKey = ''; context.registeredNextGuardSongIdentity = ''; context.registeredNextGuardId = 0;
    },
    clearDeferredQqInsert() { context.deferredQqInsertIdentity = ''; },
    clearRecentQqGuardedCompletion() { context.recentQqGuardedCompletion = null; },
    clearSkipForcePlayOnce() { context.skipForcePlayOnce = false; },
    executePlayerCommand(command, song) { commands.push({ command, song }); return dispatch(command, song); },
    updatePlayerCurrentTrack(id, title, artist, cover) { context.observed = { id, title, artist, cover }; },
    writeLog() {}, setGlobalStatus(message) { statuses.push(message); },
    adoptObservedNextGuardId() { throw new Error('paused Web observation must not adopt/recover'); },
    requestPlayerNext() { throw new Error('paused Web observation must not send Next'); }
  });
  new vm.Script(javascript).runInContext(context);
  return { context, commands, statuses };
}

test('pause cancels only logical guard, preserves queue and intake, never Pause/Next', async () => {
  const f = fixture();
  const result = await f.context.setQueuePlaybackEnabled(false);
  assert.equal(result.success, true);
  assert.equal(result.playing, false);
  assert.equal(result.autoplayPauseConfirmed, true);
  assert.deepEqual(f.commands, [{ command: 'ArmNextGuard', song: undefined }]);
  assert.equal(f.context.targetQueue[0], songA);
  assert.equal(f.context.targetQueue.length, 1);
  assert.equal(f.context.isAccepting, false);
  assert.equal(f.context.currentPlayingSong, null);
  assert.equal(f.context.activeManagedPlayerAction, null);
  assert.equal(f.context.cancelledNativeNextSongs.size, 0);
});

test('paused guard and arm do not send or register anything', async () => {
  const f = fixture();
  await f.context.setQueuePlaybackEnabled(false);
  assert.equal(await f.context.guardNextSong(songA), false);
  assert.equal(await f.context.armNextGuardOnly(songB), false);
  assert.equal(f.commands.length, 1);
  assert.equal(f.context.registeredNextGuardKey, '');
});

test('paused current observation accepts free QQ selection without queue consumption or skip', async () => {
  const f = fixture();
  await f.context.setQueuePlaybackEnabled(false);
  await f.context.syncTrackChangeLogic('A', 'A', null, 'unknown', 'artist', 'cover');
  assert.equal(f.context.observed.id, 'A');
  assert.equal(f.context.targetQueue[0], songA);
  assert.equal(f.context.targetQueue.length, 1);
  assert.equal(f.commands.length, 1);
  assert.equal(f.context.currentPlayingSong, null);
});

test('resume registers the current head, not the pre-pause head', async () => {
  const f = fixture();
  await f.context.setQueuePlaybackEnabled(false);
  f.context.targetQueue[0] = songB;
  const result = await f.context.setQueuePlaybackEnabled(true);
  assert.equal(result.success, true);
  assert.equal(result.playing, true);
  assert.deepEqual(f.commands, [{ command: 'ArmNextGuard', song: undefined }, { command: 'InsertNext', song: songB }]);
});

test('in-flight old insertion cannot restore registration after pause; cancel follows it', async () => {
  const insertion = deferred();
  const f = fixture({ dispatch: (command, song) => song ? insertion.promise : Promise.resolve({ outcome: 'applied' }) });
  const old = f.context.guardNextSong(songA);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.commands.length, 1);
  const pause = f.context.setQueuePlaybackEnabled(false);
  assert.equal(f.context.isPlaying, false);
  assert.equal(f.context.qqAutoplayPauseConfirmed, false);
  insertion.resolve({ outcome: 'applied' });
  assert.equal(await old, false);
  assert.equal((await pause).success, true);
  assert.deepEqual(f.commands.map(value => value.command), ['InsertNext', 'ArmNextGuard']);
  assert.equal(f.context.registeredNextGuardKey, '');
});

test('queued pre-pause arm is discarded even when a later resume enables playback', async () => {
  const barrier = deferred();
  const f = fixture();
  f.context.nextGuardOperationTail = barrier.promise;
  const oldArm = f.context.armNextGuardOnly(songB);
  const pause = f.context.setQueuePlaybackEnabled(false);
  const resume = f.context.setQueuePlaybackEnabled(true);
  barrier.resolve();
  assert.equal(await oldArm, false);
  await pause;
  assert.equal((await resume).success, true);
  assert.deepEqual(f.commands, [{ command: 'ArmNextGuard', song: undefined }, { command: 'InsertNext', song: songA }]);
});

test('rapid pause/resume waits for confirmed cancellation before arming', async () => {
  const cancellation = deferred();
  const f = fixture({ dispatch: (command, song) => song ? Promise.resolve({ outcome: 'applied' }) : cancellation.promise });
  const pause = f.context.setQueuePlaybackEnabled(false);
  await new Promise(resolve => setImmediate(resolve));
  const resume = f.context.setQueuePlaybackEnabled(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.context.isPlaying, false);
  assert.equal(f.commands.length, 1);
  cancellation.resolve({ outcome: 'applied' });
  await pause;
  assert.equal((await resume).success, true);
  assert.deepEqual(f.commands.map(value => value.command), ['ArmNextGuard', 'InsertNext']);
});

test('latest pause wins a rapid pause/resume/pause sequence', async () => {
  const barrier = deferred();
  const f = fixture();
  f.context.nextGuardOperationTail = barrier.promise;
  const firstPause = f.context.setQueuePlaybackEnabled(false);
  const resume = f.context.setQueuePlaybackEnabled(true);
  const finalPause = f.context.setQueuePlaybackEnabled(false);
  barrier.resolve();
  await Promise.all([firstPause, resume, finalPause]);
  assert.equal(f.context.isPlaying, false);
  assert.equal(f.commands.every(value => value.command === 'ArmNextGuard' && !value.song), true);
  assert.equal(f.context.registeredNextGuardKey, '');
});

for (const outcome of ['rejected', 'accepted', 'indeterminate']) {
  test(`cancel ${outcome} does not claim safe pause or allow new automatic work`, async () => {
    const f = fixture({ dispatch: async () => ({ outcome }) });
    const result = await f.context.setQueuePlaybackEnabled(false);
    assert.equal(result.success, false);
    assert.equal(result.autoplayPauseConfirmed, false);
    assert.equal(f.context.isPlaying, false);
    assert.match(result.message, /尚未确认/);
    assert.equal(await f.context.guardNextSong(songA), false);
    assert.equal(f.context.targetQueue[0], songA);
    const resumed = await f.context.setQueuePlaybackEnabled(true);
    assert.equal(resumed.success, false);
    assert.equal(f.commands.every(value => !value.song), true);
  });
}

test('cancel exception stays blocked and an explicit later resume may confirm then register', async () => {
  let attempt = 0;
  const f = fixture({ dispatch: async (command, song) => {
    if (!song && ++attempt === 1) throw new Error('fake cancellation failure');
    return { outcome: 'applied' };
  } });
  assert.equal((await f.context.setQueuePlaybackEnabled(false)).success, false);
  assert.equal((await f.context.setQueuePlaybackEnabled(true)).success, true);
  assert.deepEqual(f.commands.map(value => value.command), ['ArmNextGuard', 'ArmNextGuard', 'InsertNext']);
});

test('legacy players retain existing toggle/guard behavior', async () => {
  const f = fixture({ web: false });
  assert.equal((await f.context.setQueuePlaybackEnabled(false)).success, true);
  assert.equal(f.commands.length, 0);
  assert.equal(f.context.currentPlayingSong, songB);
  assert.equal(await f.context.armNextGuardOnly(songA), true);
  assert.equal(f.context.registeredNextGuardKey, 'A');
  assert.equal(f.context.isAccepting, false);
});

test('same-track observation and both UI toggles enforce the confirmation boundary', () => {
  const updated = main.slice(main.indexOf('onTrackUpdated: async'), main.indexOf('const userCooldowns'));
  assert.ok(updated.indexOf('if (isQqAutoplaySuspended())') < updated.indexOf('adoptObservedNextGuardId('));
  assert.match(updated, /if \(isQqAutoplaySuspended\(\)\) \{\s*clearQqAutoplayOwnership\(\);\s*return;/);
  const ui = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const toggles = [...ui.matchAll(/const togglePlaying = async[\s\S]*?\n    };/g)].map(value => value[0]);
  assert.equal(toggles.length, 2);
  for (const toggle of toggles) {
    assert.match(toggle, /await response\.json\(\)/);
    assert.match(toggle, /!response\.ok \|\| !result\.success/);
    assert.match(toggle, /autoplayPauseConfirmed/);
    assert.doesNotMatch(toggle, /setPlaying\(!playing\)|playing: !prev\.playing/);
  }
  assert.match(ui, /暂停待确认/);
  assert.match(main, /autoplayPauseConfirmed: isAutoplayPauseConfirmed\(\)/);
});
