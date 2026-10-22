import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as queue from '../electron/queue-head-policy.ts';
import * as anchor from '../electron/qq-playback-anchor-policy.ts';
import * as compatibility from '../electron/qq-native-compatibility-policy.ts';
import { isSuccessfulPlayerResult } from '../electron/players/types.ts';

// Replays feedback FB-20261021-CDCE7CDE through the actual main.ts functions:
// a 64-bit KuGou played 青藏高原 under another ID (317243695) than the request
// (303222240), and every host correction flipped it back to 夜夜夜夜
// (548045966). Never imports Electron, starts a connector or controls a player.
const main = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true);
const names = [
  'syncTrackChangeLogic', 'claimQueueHeadCorrection', 'reconcileQueueHeadAfterMutation',
  'playSongNow', 'guardNextSong', 'serializeNextGuardOperation', 'isObservedSong',
  'updatePlayerCurrentTrack', 'cacheSongCover', 'holdUnsupportedQqQueue',
  'getQueueSongIdentity', 'clearRegisteredNextGuard'
];
const functions = names.map(name => {
  const declaration = parsed.statements.find(statement =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  assert.ok(declaration, name);
  return declaration.getText(parsed);
}).join('\n');
const transpile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText;
const javascript = transpile(functions);

const request = {
  RequestId: 'feedback-request', Id: '303222240', SongName: '青藏高原', ArtistName: '李娜',
  PlayerKey: 'kugou', OrderedBy: '观众', OrderedByUid: '10001'
};
const previousRequest = {
  RequestId: 'previous-request', Id: '548045966', SongName: '夜夜夜夜', ArtistName: '齐秦',
  PlayerKey: 'kugou', OrderedBy: '观众', OrderedByUid: '10002'
};
const PLAY = 'PlaySelected 303222240';
const INSERT = 'InsertNext 303222240';

function fixture({ queue: initialQueue = [request], current = null, insertNext = 'accepted' } = {}) {
  let now = 1_000;
  const commands = [];
  const logs = [];
  const statuses = [];
  const context = vm.createContext({
    ...queue, ...anchor, ...compatibility, isSuccessfulPlayerResult,
    Date: { now: () => now },
    appConfig: { sysConfig: { PauseAfterRequests: false } },
    activePlayerSnapshot: { connected: true, player: '酷狗音乐', version: '' },
    playerControlNotice: null, qqAutoplayGeneration: 0, isPlaying: true,
    targetQueue: [...initialQueue], currentPlayingSong: current, playerCurrentTrack: null,
    playerPausedAfterRequests: false, songCoverCache: new Map(),
    activeManagedPlayerAction: null, managedPlayerActionSequence: 0,
    registeredNextGuardKey: '', registeredNextGuardSongIdentity: '', registeredNextGuardId: 0,
    queueHeadNeedsGuardOnlyAfterCurrentChange: false, queueHeadCorrection: null,
    cancelledNativeNextSongs: new Map(), recentQqGuardedCompletion: null,
    skipForcePlayOnce: false, skipForcePlayOnceSong: null,
    deferredQqInsertIdentity: '', qqDeferredInsertRetryAttempted: false,
    qqDeferredInsertRetryInFlight: false, nextGuardOperationTail: Promise.resolve(),
    getSelectedPlayerKey: () => 'kugou',
    connectorOwnsQqLogicalNext: () => false,
    isQqAutoplaySuspended: () => false,
    shouldDeferQqQueueHeadForMissingAnchor: () => false,
    discardQqGuardOperation: () => false,
    getNextGuardKey: song => `kugou|${song.Id}`,
    getResultNextGuardId: () => 0,
    adoptObservedNextGuardId() {},
    recoverQqGuardTerminalFailureIfNeeded: async () => 'none',
    retryDeferredQqInsertAfterObservation: async () => 'none',
    recoverRecentQqGuardedCompletionIfNeeded: async () => 'none',
    rememberQqGuardedCompletionIfEligible() {},
    replaceRecentQqGuardedCompletionForNewGuard() {},
    clearRecentQqGuardedCompletion() {},
    clearQqGuardTerminalRecoveryOwnership() {},
    clearDeferredQqInsert() {}, syncDeferredQqInsertWithQueueHead() {},
    clearSkipForcePlayOnce() {}, rememberCancelledNativeNext() {},
    scheduleManagedActionExpiration() {},
    expireManagedAction() { throw new Error('every action settles before the next observation'); },
    requestPlayerNext() { throw new Error('the replay never skips'); },
    async armNextGuardOnly(song) { commands.push(`ArmNextGuard ${song.Id}`); return true; },
    async executePlayerCommand(command, song) {
      commands.push(`${command} ${song.Id}`);
      // The connector cannot confirm a target that KuGou reports under another ID.
      return { outcome: command === 'InsertNext' ? insertNext : 'indeterminate' };
    },
    writeLog(message, color) { logs.push({ message, color }); },
    setGlobalStatus(message) { statuses.push(message); }
  });
  new vm.Script(javascript).runInContext(context);
  return {
    context, commands, logs, statuses,
    logged: text => logs.filter(({ message }) => message.includes(text)),
    async observe(id, title, artist, seconds = 4.3) {
      now += seconds * 1000;
      // As logged, the inserted request stays the player's next song.
      await context.syncTrackChangeLogic(
        id, title, '303222240', '青藏高原 - 李娜', artist, '',
        { id: '303222240', title: '青藏高原', artist: '李娜' }, 'track', true, 'none', 0
      );
    }
  };
}

// The logs do not show the current artist. Without a matching one the KuGou
// title and artist rule cannot pair the two IDs, which leaves only the bound.
async function replayAlternation(f, cycles = 15) {
  for (let cycle = 0; cycle < cycles; cycle++) {
    await f.observe('317243695', '青藏高原', '');
    await f.observe('548045966', '夜夜夜夜', '');
  }
}

test('the feedback loop stops after two corrections and hands the request to the guard once', async () => {
  const f = fixture();
  await replayAlternation(f);
  assert.deepEqual(f.commands, [PLAY, PLAY, INSERT]);
  assert.equal(f.logged('[兜底纠正] 实际切歌与待播队首不符').length, 2);
  assert.equal(f.logged('[立即播放] 命令已发出但播放器未确认目标').length, 2);
  const stop = f.logged('已停止自动纠正');
  assert.equal(stop.length, 1);
  assert.equal(stop[0].color, 'Yellow');
  assert.match(stop[0].message, /保留队首: 青藏高原；请确认播放器版本受支持，或在播放器设置中更新连接器/);
  assert.equal(f.statuses.filter(status => status.includes('已停止自动纠正')).length, 1);
  assert.equal(f.statuses.at(-1), '下一首已就绪: 青藏高原');
  assert.equal(f.context.targetQueue.length, 1);
  assert.equal(f.context.targetQueue[0], request);
  assert.equal(f.context.currentPlayingSong, null);
  assert.equal(f.context.registeredNextGuardSongIdentity, 'kugou|id:303222240');

  // Once the player reaches the request, it is consumed and the hold is gone.
  await f.observe('303222240', '青藏高原', '李娜', 180);
  assert.equal(f.context.currentPlayingSong, request);
  assert.equal(f.context.targetQueue.length, 0);
  assert.equal(f.context.queueHeadCorrection, null);
  assert.equal(f.commands.length, 3);
});

test('without a registered guard the held request only repeats the status', async () => {
  const f = fixture({ insertNext: 'rejected' });
  await replayAlternation(f);
  assert.deepEqual(f.commands, [PLAY, PLAY, INSERT]);
  assert.equal(f.logged('已停止自动纠正').length, 1);
  // Every later mismatch shows the hold instead of correcting again.
  assert.equal(f.statuses.filter(status => status.includes('已停止自动纠正')).length, 28);
  assert.equal(f.context.registeredNextGuardSongIdentity, '');
  assert.equal(f.context.targetQueue[0], request);
});

test('with the artist reported, KuGou consumes the request under its other ID without a correction', async () => {
  const f = fixture();
  await f.observe('317243695', '青藏高原', '李娜');
  assert.deepEqual(f.commands, []);
  assert.equal(f.context.currentPlayingSong, request);
  assert.equal(f.context.targetQueue.length, 0);
  assert.equal(f.logged('[兜底纠正]').length, 0);
  assert.equal(f.statuses.at(-1), '[播放] 青藏高原');
});

test('a stale current request cannot restart the loop through the 强制拉起 branch', async () => {
  // The previous request plays on while KuGou flips between it and 青藏高原.
  const f = fixture({ current: previousRequest });
  for (let cycle = 0; cycle < 6; cycle++) {
    await f.observe('317243695', '青藏高原', '');
    await f.observe('548045966', '夜夜夜夜', '齐秦');
  }
  assert.deepEqual(f.commands, [PLAY, PLAY, INSERT]);
  assert.equal(f.logged('强制拉起待播列表首曲').length, 2);
  assert.equal(f.logged('已停止自动纠正').length, 1);
  // The old request is released, so the player's own track shows.
  assert.equal(f.context.currentPlayingSong, null);
  assert.equal(f.context.targetQueue[0], request);
});

test('moving another request to the head and back restores corrections', async () => {
  const f = fixture({ queue: [request, previousRequest], insertNext: 'rejected' });
  for (let observation = 0; observation < 4; observation++) {
    await f.observe('317243695', '青藏高原', '');
  }
  assert.deepEqual(f.commands, [PLAY, PLAY, INSERT]);
  // The streamer tops the other request, then tops this one again, with no
  // track change in between.
  f.context.targetQueue.reverse();
  await f.context.reconcileQueueHeadAfterMutation(request, '置顶队列');
  f.context.targetQueue.reverse();
  await f.context.reconcileQueueHeadAfterMutation(previousRequest, '置顶队列');
  assert.equal(f.context.queueHeadCorrection, null);
  await f.observe('317243695', '青藏高原', '');
  assert.deepEqual(f.commands.slice(3), ['InsertNext 548045966', INSERT, PLAY]);
});

test('a reorder behind the head keeps the hold', async () => {
  const third = { ...previousRequest, RequestId: 'third', Id: '1', SongName: '第三首' };
  const f = fixture({ queue: [request, previousRequest, third], insertNext: 'rejected' });
  for (let observation = 0; observation < 3; observation++) {
    await f.observe('317243695', '青藏高原', '');
  }
  f.context.targetQueue.splice(1, 2, third, previousRequest);
  await f.context.reconcileQueueHeadAfterMutation(request, '重排队列');
  await f.observe('548045966', '夜夜夜夜', '');
  assert.deepEqual(f.commands, [PLAY, PLAY, INSERT]);
  assert.equal(f.context.queueHeadCorrection.stopped, true);
});

test('a player disconnect lifts the hold so a reconnect may correct again', () => {
  let callback = null;
  const visit = node => {
    if (callback) return;
    if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === 'playerManager'
        && node.initializer && ts.isNewExpression(node.initializer)) {
      callback = node.initializer.arguments[0].properties
        .find(item => item.name?.getText(parsed) === 'onStateChanged').initializer.getText(parsed);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.ok(callback, 'onStateChanged');
  const held = { song: request, identity: 'kugou|id:303222240', attempts: 2, lastAttemptAt: 0, stopped: true };
  const context = vm.createContext({
    ...compatibility,
    isPlayerConnected: true, playerConnecting: false, activePlayerSnapshot: null,
    playerControlNotice: null, qqAutoplayGeneration: 0,
    getSelectedPlayerKey: () => 'kugou', setGlobalStatus() {}, writeLog() {},
    clearDeferredQqInsert() {}, clearRecentQqGuardedCompletion() {}, clearRegisteredNextGuard() {},
    clearSkipForcePlayOnce() {}, queueHeadNeedsGuardOnlyAfterCurrentChange: false,
    activeManagedPlayerAction: null, cancelledNativeNextSongs: new Map(),
    queueHeadCorrection: held,
    applicationQuitRequested: false, playerConnectionRecoverySuppressed: 0,
    playerConnectionRecoverySuppressionEpoch: 0, queueMicrotask() {},
    scheduleQqCompatibilityRecovery() {}
  });
  vm.runInContext(transpile(`${functions}\nglobalThis.onStateChanged = ${callback};`), context);
  const snapshot = { connected: true, player: '酷狗音乐', processId: 7, version: '' };
  context.onStateChanged({ connected: true, connecting: false, snapshot });
  assert.equal(context.queueHeadCorrection, held);
  context.onStateChanged({ connected: false, connecting: false, snapshot: null });
  assert.equal(context.queueHeadCorrection, null);
});
