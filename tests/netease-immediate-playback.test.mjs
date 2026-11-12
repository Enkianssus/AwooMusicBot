import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as queue from '../electron/queue-head-policy.ts';
import * as anchor from '../electron/qq-playback-anchor-policy.ts';
import * as compatibility from '../electron/qq-native-compatibility-policy.ts';
import { managedActionExpirationAt } from '../electron/managed-action-lifetime-policy.ts';
import { isSuccessfulPlayerResult } from '../electron/players/types.ts';

// FB-20261102-A721B68F: the target was confirmed, yet every later request
// remained behind the "waiting for immediate playback" latch. Exercise the
// actual host callbacks and command serialization, with only the connector,
// cover fetch and unrelated QQ recovery boundaries made inert. No Electron,
// player process, network request, wall-clock timer or installed data is used.
const main = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true);
const names = [
  'playSongNow', 'syncTrackChangeLogic', 'guardNextSong', 'armNextGuardOnly',
  'serializeNextGuardOperation', 'isObservedSong', 'updatePlayerCurrentTrack',
  'cacheSongCover', 'getQueueSongIdentity', 'getNextGuardKey',
  'clearRegisteredNextGuard', 'getResultNextGuardId', 'clearSkipForcePlayOnce',
  'scheduleManagedActionExpiration', 'expireManagedAction',
  'holdUnsupportedQqQueue', 'claimQueueHeadCorrection'
];
const functions = names.map(name => {
  const declaration = parsed.statements.find(statement =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  assert.ok(declaration, name);
  return declaration.getText(parsed);
}).join('\n');
const manager = parsed.statements
  .flatMap(statement => ts.isVariableStatement(statement)
    ? [...statement.declarationList.declarations] : [])
  .find(declaration => declaration.name.getText(parsed) === 'playerManager');
assert.ok(manager && ts.isNewExpression(manager.initializer), 'playerManager');
const updated = manager.initializer.arguments[0].properties
  .find(property => property.name?.getText(parsed) === 'onTrackUpdated');
assert.ok(updated, 'onTrackUpdated');
const javascript = ts.transpileModule(
  `${functions}\nglobalThis.onTrackUpdated = ${updated.initializer.getText(parsed)};`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
).outputText;

function song(id, title) {
  return { RequestId: `request-${id}`, Id: id, SongName: title,
    ArtistName: '测试歌手', PlayerKey: 'netease', OrderedBy: '观众',
    OrderedByUid: '10001', CoverUrl: '' };
}
const A = song('3404897305', 'ゆーえふおー');
const B = song('200', 'がらくた - JUNK');
const C = song('300', 'アンダーグラウンド');
const X = song('400', '主播歌单原曲');
const track = request => request && ({ id: request.Id, title: request.SongName,
  artist: request.ArtistName });

function fixture({
  initialQueue = [A], initialTrack = X, delayPlay = false,
  playerKey = 'netease', logicalNextOwner = false
} = {}) {
  let now = 1_000;
  let settlePlay;
  let playDispatched;
  const dispatched = new Promise(resolve => { playDispatched = resolve; });
  const commands = [];
  const logs = [];
  const timers = [];
  const context = vm.createContext({
    ...queue, ...anchor, ...compatibility, managedActionExpirationAt,
    isSuccessfulPlayerResult, Date: { now: () => now },
    setTimeout(callback, delay) { timers.push({ callback, due: now + delay }); },
    appConfig: { sysConfig: { PauseAfterRequests: false } },
    activePlayerSnapshot: { connected: true, player: playerKey,
      version: playerKey === 'netease' ? '3.1.42.205594' : '22.61.0',
      current: track(initialTrack), ownsLogicalNext: logicalNextOwner,
      requiresPlaybackAnchor: !logicalNextOwner, playbackAnchorReady: false },
    targetQueue: [...initialQueue], currentPlayingSong: null,
    playerCurrentTrack: initialTrack, playerControlNotice: null,
    playerPausedAfterRequests: false, songCoverCache: new Map(),
    isPlaying: true, qqAutoplayGeneration: 0,
    activeManagedPlayerAction: null, managedPlayerActionSequence: 0,
    queueHeadNeedsGuardOnlyAfterCurrentChange: false, queueHeadCorrection: null,
    registeredNextGuardKey: '', registeredNextGuardSongIdentity: '', registeredNextGuardId: 0,
    nextGuardOperationTail: Promise.resolve(), cancelledNativeNextSongs: new Map(),
    recentQqGuardedCompletion: null, skipForcePlayOnce: false, skipForcePlayOnceSong: null,
    deferredQqInsertIdentity: '', qqDeferredInsertRetryAttempted: false,
    qqDeferredInsertRetryInFlight: false,
    getSelectedPlayerKey: () => playerKey, connectorOwnsQqLogicalNext: () => logicalNextOwner,
    isQqAutoplaySuspended: () => false, discardQqGuardOperation: () => false,
    shouldDeferQqQueueHeadForMissingAnchor: () => false,
    getNcmSongCover: async () => '',
    adoptObservedNextGuardId() {},
    recoverQqGuardTerminalFailureIfNeeded: async () => 'none',
    retryDeferredQqInsertAfterObservation: async () => 'none',
    recoverRecentQqGuardedCompletionIfNeeded: async () => 'none',
    rememberQqGuardedCompletionIfEligible() {},
    replaceRecentQqGuardedCompletionForNewGuard() {},
    clearRecentQqGuardedCompletion() {}, clearQqGuardTerminalRecoveryOwnership() {},
    clearDeferredQqInsert() {},
    requestPlayerNext() { throw new Error('a confirmed request must not be skipped'); },
    pauseActivePlayerAfterRequests() { throw new Error('queue draining is not enabled'); },
    async executePlayerCommand(command, request) {
      commands.push(`${command} ${request?.Id || ''}`);
      if (command === 'PlaySelected') {
        playDispatched();
        if (delayPlay) return await new Promise(resolve => { settlePlay = resolve; });
      }
      return { outcome: 'applied', snapshot: { nextGuardId: commands.length } };
    },
    writeLog(message) { logs.push(message); }, setGlobalStatus() {}
  });
  vm.runInContext(javascript, context);

  async function flushGuardWork() {
    // Callbacks may enqueue guard work without awaiting it. Drain that actual
    // serial tail rather than replacing serialization with a synchronous fake.
    for (let pass = 0; pass < 4; pass++) {
      const tail = context.nextGuardOperationTail;
      await tail;
      await Promise.resolve();
      if (tail === context.nextGuardOperationTail) return;
    }
    throw new Error('guard work did not settle');
  }
  return {
    context, commands, logs, dispatched, flushGuardWork,
    at(time) {
      now = time;
      for (;;) {
        const index = timers.findIndex(timer => timer.due <= now);
        if (index < 0) break;
        timers.splice(index, 1)[0].callback();
      }
    },
    settlePlay(result = { outcome: 'applied' }) {
      assert.ok(settlePlay, 'PlaySelected must have been dispatched');
      settlePlay(result);
    },
    async registeredPlay() {
      await context.guardNextSong(A);
      assert.equal(context.registeredNextGuardSongIdentity, 'netease|id:3404897305');
      assert.equal(await context.playSongNow(A), true);
      assert.equal(context.queueHeadNeedsGuardOnlyAfterCurrentChange, true);
      // This is the queue play_now endpoint's removal after command success;
      // the queued observation callback can run after the item is removed.
      const index = context.targetQueue.indexOf(A);
      if (index !== -1) context.targetQueue.splice(index, 1);
    },
    async observe(request, {
      heartbeat = false, next = null, nextObservation = 'empty', drain = true
    } = {}) {
      now += 100;
      context.activePlayerSnapshot.current = track(request);
      const observation = { nextTrack: track(next), nextObservation,
        nextDescription: next?.SongName || '由下一首守卫管理',
        nextGuardState: 'none', nextGuardId: 0, playbackAnchorReady: false, coverUrl: '' };
      if (heartbeat) {
        await context.onTrackUpdated(track(request), observation);
      } else {
        await context.syncTrackChangeLogic(request.Id, request.SongName,
          next?.Id || null, observation.nextDescription, request.ArtistName, '',
          track(next), nextObservation, false, 'none', 0);
      }
      if (drain) await flushGuardWork();
    }
  };
}

test('confirmed immediate target with an empty queue releases later NetEase insertions', async () => {
  const f = fixture();
  await f.registeredPlay();
  await f.observe(A);
  assert.ok(f.logs.some(message => message.includes('已确认最终目标')));
  assert.equal(f.context.activeManagedPlayerAction, null);
  assert.equal(f.context.queueHeadNeedsGuardOnlyAfterCurrentChange, false);
  f.context.targetQueue.push(B);
  await f.context.guardNextSong(B);
  assert.deepEqual(f.commands, [`InsertNext ${A.Id}`, `PlaySelected ${A.Id}`, `InsertNext ${B.Id}`]);
  assert.ok(!f.logs.some(message => message.includes('正在等待立即播放目标真正开始')));
});

test('same-song heartbeat confirmation releases the latch even with an empty queue', async () => {
  const f = fixture({ initialTrack: A });
  await f.registeredPlay();
  await f.observe(A, { heartbeat: true });
  assert.equal(f.context.activeManagedPlayerAction, null);
  assert.equal(f.context.queueHeadNeedsGuardOnlyAfterCurrentChange, false);
  f.context.targetQueue.push(B);
  await f.context.guardNextSong(B);
  assert.equal(f.commands.at(-1), `InsertNext ${B.Id}`);
});

test('an existing new head is inserted after the target confirms, not only armed', async () => {
  const f = fixture({ initialQueue: [A, B] });
  await f.registeredPlay();
  await f.observe(A);
  assert.equal(f.context.queueHeadNeedsGuardOnlyAfterCurrentChange, false);
  assert.equal(f.context.registeredNextGuardSongIdentity, `netease|id:${B.Id}`);
  assert.deepEqual(f.commands, [`InsertNext ${A.Id}`, `PlaySelected ${A.Id}`, `InsertNext ${B.Id}`]);
});

test('same-song confirmation also inserts an already waiting new head', async () => {
  const f = fixture({ initialQueue: [A, B], initialTrack: A });
  await f.registeredPlay();
  await f.observe(A, { heartbeat: true });
  assert.equal(f.context.queueHeadNeedsGuardOnlyAfterCurrentChange, false);
  assert.equal(f.context.registeredNextGuardSongIdentity, `netease|id:${B.Id}`);
  assert.equal(f.commands.at(-1), `InsertNext ${B.Id}`);
});

test('confirming NetEase playback while autoplay is paused releases the latch without arming B', async () => {
  const f = fixture({ initialQueue: [A, B], initialTrack: A });
  await f.registeredPlay();
  f.context.isPlaying = false;
  await f.observe(A, { heartbeat: true });
  assert.equal(f.context.queueHeadNeedsGuardOnlyAfterCurrentChange, false);
  assert.equal(f.context.activeManagedPlayerAction, null);
  assert.equal(f.context.targetQueue[0], B);
  assert.equal(f.context.registeredNextGuardSongIdentity, '');
  assert.deepEqual(f.commands, [`InsertNext ${A.Id}`, `PlaySelected ${A.Id}`]);
});

test('an ACK without target observation keeps subsequent insertions deferred', async () => {
  const f = fixture({ initialQueue: [A, B] });
  await f.registeredPlay();
  await f.context.guardNextSong(B);
  assert.equal(f.context.queueHeadNeedsGuardOnlyAfterCurrentChange, true);
  assert.equal(f.context.activeManagedPlayerAction.targetObserved, false);
  assert.deepEqual(f.commands, [`InsertNext ${A.Id}`, `PlaySelected ${A.Id}`]);
});

test('intermediate track changes and heartbeats cannot release the target latch', async () => {
  const f = fixture({ initialQueue: [A, B] });
  await f.registeredPlay();
  await f.observe(X);
  await f.observe(X, { heartbeat: true });
  await f.context.guardNextSong(B);
  assert.equal(f.context.queueHeadNeedsGuardOnlyAfterCurrentChange, true);
  assert.equal(f.context.activeManagedPlayerAction.targetObserved, false);
  assert.ok(f.logs.some(message => message.includes('中间切歌')));
  assert.deepEqual(f.commands, [`InsertNext ${A.Id}`, `PlaySelected ${A.Id}`]);
});

test('after B starts naturally, C is inserted without replaying B', async () => {
  const f = fixture({ initialQueue: [A, B, C] });
  await f.registeredPlay();
  await f.observe(A);
  await f.observe(B);
  assert.equal(f.context.currentPlayingSong, B);
  assert.equal(f.context.targetQueue.length, 1);
  assert.equal(f.context.targetQueue[0], C);
  assert.equal(f.context.registeredNextGuardSongIdentity, `netease|id:${C.Id}`);
  assert.deepEqual(f.commands, [`InsertNext ${A.Id}`, `PlaySelected ${A.Id}`,
    `InsertNext ${B.Id}`, `InsertNext ${C.Id}`]);
});

test('repeated target callbacks do not insert the same next request twice', async () => {
  const f = fixture({ initialQueue: [A, B] });
  await f.registeredPlay();
  await f.observe(A);
  await f.observe(A, { heartbeat: true, next: B, nextObservation: 'track' });
  await f.observe(A, { heartbeat: true, next: B, nextObservation: 'track' });
  await f.observe(A, { next: B, nextObservation: 'track' });
  await f.context.guardNextSong(B);
  assert.deepEqual(f.commands, [`InsertNext ${A.Id}`, `PlaySelected ${A.Id}`, `InsertNext ${B.Id}`]);
  assert.equal(f.context.targetQueue[0], B);
});

for (const heartbeat of [false, true]) {
  test(`an observed native next B is only re-armed (${heartbeat ? 'heartbeat' : 'track change'})`, async () => {
    const f = fixture({ initialQueue: [A, B] });
    await f.registeredPlay();
    await f.observe(A, { heartbeat, next: B, nextObservation: 'track' });
    assert.equal(f.context.queueHeadNeedsGuardOnlyAfterCurrentChange, false);
    assert.equal(f.context.registeredNextGuardSongIdentity, `netease|id:${B.Id}`);
    assert.deepEqual(f.commands, [`InsertNext ${A.Id}`, `PlaySelected ${A.Id}`, `ArmNextGuard ${B.Id}`]);
  });
}

test('an observed target at action expiry cannot leave an orphan waiting latch', async () => {
  const f = fixture();
  await f.registeredPlay();
  // Metadata can reach the host immediately before its action-expiry timer;
  // this path must also clear the latch when keeping the requested song.
  f.context.updatePlayerCurrentTrack(A.Id, A.SongName, A.ArtistName);
  f.at(13_051);
  assert.equal(f.context.activeManagedPlayerAction, null);
  assert.equal(f.context.currentPlayingSong, A);
  assert.equal(f.context.queueHeadNeedsGuardOnlyAfterCurrentChange, false);
  f.context.targetQueue.push(B);
  await f.context.guardNextSong(B);
  assert.equal(f.commands.at(-1), `InsertNext ${B.Id}`);
});

test('target observation before PlaySelected settles releases an empty-queue latch', async () => {
  const f = fixture({ delayPlay: true });
  await f.context.guardNextSong(A);
  const playing = f.context.playSongNow(A);
  await f.dispatched;
  assert.equal(f.context.queueHeadNeedsGuardOnlyAfterCurrentChange, true);
  // The queued request can also be removed while the connector is in flight.
  f.context.targetQueue.splice(0, 1);
  await f.observe(A, { drain: false });
  assert.equal(f.context.activeManagedPlayerAction.targetObserved, true);
  assert.equal(f.context.activeManagedPlayerAction.inFlight, true);
  assert.equal(f.context.queueHeadNeedsGuardOnlyAfterCurrentChange, false);
  f.settlePlay();
  assert.equal(await playing, true);
  await f.flushGuardWork();
  assert.equal(f.context.activeManagedPlayerAction, null);
  f.context.targetQueue.push(B);
  await f.context.guardNextSong(B);
  assert.deepEqual(f.commands, [`InsertNext ${A.Id}`, `PlaySelected ${A.Id}`, `InsertNext ${B.Id}`]);
});

test('an older callback cannot release a newer action latch after awaiting insertion', async () => {
  const f = fixture({ initialQueue: [A, B] });
  await f.registeredPlay();
  let insertionStarted;
  let finishInsertion;
  const started = new Promise(resolve => { insertionStarted = resolve; });
  const blocked = new Promise(resolve => { finishInsertion = resolve; });
  const execute = f.context.executePlayerCommand;
  f.context.executePlayerCommand = async (command, request) => {
    const result = await execute(command, request);
    if (command === 'InsertNext' && request === B) {
      insertionStarted();
      await blocked;
    }
    return result;
  };

  const confirmingA = f.observe(A, { drain: false });
  await started;
  // Queue C's explicit play behind B's actual in-flight insertion. Once the
  // serialized command releases, C can start before A's callback resumes.
  const playingC = f.context.playSongNow(C);
  finishInsertion();
  await Promise.all([confirmingA, playingC]);
  await f.flushGuardWork();
  assert.equal(f.context.activeManagedPlayerAction.target, C);
  assert.equal(f.context.activeManagedPlayerAction.targetObserved, false);
  assert.equal(f.context.queueHeadNeedsGuardOnlyAfterCurrentChange, true);
  assert.deepEqual(f.commands, [`InsertNext ${A.Id}`, `PlaySelected ${A.Id}`,
    `InsertNext ${B.Id}`, `PlaySelected ${C.Id}`]);
});

test('a target still at the queue head is consumed once and never inserted after itself', async () => {
  const f = fixture({ initialQueue: [A, B] });
  await f.context.guardNextSong(A);
  await f.context.playSongNow(A);
  // Unlike the other cases, the endpoint has not removed A yet. A metadata
  // heartbeat may confirm it but must not insert A as its own next song.
  await f.observe(A, { heartbeat: true });
  assert.equal(f.context.queueHeadNeedsGuardOnlyAfterCurrentChange, false);
  assert.equal(f.context.targetQueue[0], A);
  assert.deepEqual(f.commands, [`InsertNext ${A.Id}`, `PlaySelected ${A.Id}`]);
  // The ordinary queue observation owns consuming that same request.
  await f.observe(A);
  assert.equal(f.context.targetQueue.length, 1);
  assert.equal(f.context.targetQueue[0], B);
  assert.deepEqual(f.commands, [`InsertNext ${A.Id}`, `PlaySelected ${A.Id}`, `InsertNext ${B.Id}`]);
});

test('empty-queue confirmation does not resubmit a QQ logical-next owner target', async () => {
  const qqA = { ...A, PlayerKey: 'qqmusic' };
  const f = fixture({ initialQueue: [qqA], playerKey: 'qqmusic', logicalNextOwner: true });
  await f.context.guardNextSong(qqA);
  await f.context.playSongNow(qqA);
  f.context.targetQueue.shift();
  await f.observe(qqA, { heartbeat: true });
  await f.observe(qqA, { heartbeat: true });
  assert.equal(f.context.queueHeadNeedsGuardOnlyAfterCurrentChange, false);
  assert.equal(f.context.activeManagedPlayerAction, null);
  assert.equal(f.context.targetQueue.length, 0);
  assert.deepEqual(f.commands, [`InsertNext ${A.Id}`, `PlaySelected ${A.Id}`]);
});
