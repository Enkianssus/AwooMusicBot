import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { AVATAR_PLACEHOLDER } from '../electron/bili-avatar-cache.ts';
import {
  MAX_REQUEST_NOTIFICATIONS,
  RequestNotificationStore,
  parseRequestNotificationCommand,
  sanitizeRequestNotifications
} from '../electron/request-notifications.ts';

const waiting = { kind: 'waiting', title: '搜索词', message: '等待处理', requestedBy: '观众' };
const QQ_HOLD_MESSAGE = '点歌成功，已保留在待播队列（当前 QQ 版本暂不支持自动插入，等待主播处理）';

test('a request keeps its id through completion, replaces waiting, and expires after six seconds', () => {
  const store = new RequestNotificationStore();
  const id = store.publish(waiting, 1_000);
  assert.equal(store.snapshot(100_000)[0].kind, 'waiting');
  store.publish({ ...waiting, id, kind: 'success', title: '真实歌名' }, 100_000);
  assert.deepEqual(store.snapshot(105_999), [{
    ...waiting, id, kind: 'success', action: 'request', title: '真实歌名', createdAt: 100_000, expiresAt: 106_000
  }]);
  assert.deepEqual(store.snapshot(106_000), []);
});

test('notification storage is bounded, snapshots cannot mutate it, and abandoned waiting expires', () => {
  const store = new RequestNotificationStore();
  const first = store.publish(waiting, 1_000);
  for (let i = 0; i < MAX_REQUEST_NOTIFICATIONS; i++) store.publish(waiting, 1_001 + i);
  const snapshot = store.snapshot(1_050);
  assert.equal(snapshot.length, MAX_REQUEST_NOTIFICATIONS);
  assert.equal(snapshot.some(item => item.id === first), false);
  snapshot[0].title = 'mutated';
  assert.equal(store.snapshot(1_050)[0].title, '搜索词');
  assert.deepEqual(store.snapshot(121_021), []);
});

test('public notifications whitelist fields and discard malformed, expired, or duplicate entries', () => {
  const entry = { ...waiting, id: '1', createdAt: 1_000, expiresAt: 7_000 };
  const sanitized = sanitizeRequestNotifications([
    null, 'invalid', { ...entry, kind: 'native' },
    { ...entry, kind: { toString: () => 'success', secret: 'secret' } },
    { ...entry, id: 'expired', expiresAt: 1_500 },
    { ...entry, id: 'invalid', createdAt: NaN }, entry,
    { ...entry, kind: 'error', NativeData: 'secret', token: 'secret', user: { cookie: 'secret' } }
  ], 2_000);
  assert.deepEqual(sanitized, [{ ...entry, kind: 'error', action: 'request' }]);
  assert.equal(JSON.stringify(sanitized).includes('secret'), false);
});

test('notices carry a whitelisted action that defaults to request', () => {
  const entry = { ...waiting, createdAt: 1_000, expiresAt: 7_000 };
  const sanitized = sanitizeRequestNotifications([
    { ...entry, id: 'legacy' }, { ...entry, id: 'cancel', action: 'cancel' },
    { ...entry, id: 'remove', action: 'remove' }, { ...entry, id: 'invalid', action: 'native' },
    { ...entry, id: 'object', action: { toString: () => 'cancel' } }
  ], 2_000);
  assert.deepEqual(sanitized.map(item => [item.id, item.action]), [
    ['legacy', 'request'], ['cancel', 'cancel'], ['remove', 'remove'], ['invalid', 'request'], ['object', 'request']
  ]);
  const store = new RequestNotificationStore();
  store.publish({ ...waiting, action: 'remove' }, 1_000);
  store.publish({ ...waiting, action: 'bogus' }, 1_000);
  assert.deepEqual(store.snapshot(1_000).map(item => item.action), ['remove', 'request']);
});

test('remove withdraws one notice without touching the others', () => {
  const store = new RequestNotificationStore();
  const first = store.publish(waiting, 1_000);
  const second = store.publish({ ...waiting, title: '另一首' }, 1_000);
  store.remove(first);
  store.remove('missing');
  assert.deepEqual(store.snapshot(1_000).map(item => item.id), [second]);
});

test('only song requests and withdrawals create feedback, including every existing request spelling', () => {
  for (const prefix of ['点歌', '點歌', '立即点歌', '插队点歌', '置顶点歌', '优先点歌']) {
    assert.deepEqual(parseRequestNotificationCommand(` ${prefix}  歌名 `), { action: 'request', title: '歌名' });
  }
  assert.deepEqual(parseRequestNotificationCommand('撤回'), { action: 'cancel', title: '最近一首点歌' });
  assert.deepEqual(parseRequestNotificationCommand('撤回 歌名'), { action: 'cancel', title: '歌名' });
  for (const message of ['普通弹幕', '切歌', '停止接单']) assert.equal(parseRequestNotificationCommand(message), null);
});

// Execute the real request lifecycle with inert player/network dependencies.
// This catches missing feedback branches without launching Electron or playback.
const source = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const functions = ['beginRequestFeedback', 'updateRequestFeedback', 'failRequestFeedback', 'dismissRequestFeedback',
  'addReject', 'tryRequestSong', 'handleDanmaku', 'enqueueDanmakuCommand', 'processDanmakuCommandQueue'];
const compiled = ts.transpileModule(functions.map(name => {
  const declaration = parsed.statements.find(value => ts.isFunctionDeclaration(value) && value.name?.text === name);
  assert.ok(declaration, name);
  return declaration.getText(parsed);
}).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;

const user = { uid: '1', name: '观众', avatar: 'avatar', guardLevel: 0 };
const faceless = { ...user, avatar: '' };
const track = { id: 'song-id', title: '真实歌名', artist: '歌手', coverUrl: 'cover', nativeData: 'private-native-data' };
const flush = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function fixture(overrides = {}) {
  let now = 1_000_000;
  let requestSequence = 0;
  const store = new RequestNotificationStore();
  const context = vm.createContext({
    Date: { now: () => now }, setTimeout() {}, parseRequestNotificationCommand,
    requestNotificationStore: { publish: input => store.publish(input, now), remove: id => store.remove(id) },
    playerManager: { search: async () => [track] },
    getSelectedPlayerKey: () => 'netease', getSelectedPlayerLabel: () => '播放器',
    playerSelectionEpoch: 0, playerControlNotice: null, randomUUID: () => `request-${++requestSequence}`,
    getBiliAvatar: async () => 'avatar', getNcmSongCover: async () => 'cover',
    biliAvatarCache: { peek: () => undefined }, AVATAR_PLACEHOLDER,
    getQueueSongIdentity: song => song.Id, cancelledNativeNextSongs: new Map(),
    setGlobalStatus() {}, writeLog() {}, recentRejects: [], targetQueue: [],
    clearRecentQqGuardedCompletion() {}, waitForManagedPlayerActionSettlement: async () => {},
    currentPlayingSong: null, playSongNow: async () => false,
    reconcileQueueHeadAfterMutation: async () => {}, guardNextSong: async () => true,
    shouldDeferQqQueueHeadForMissingAnchor: () => false,
    isPlaying: false, isAccepting: true, lastPausedIntakeNoticeAt: 0, appConfig: { sysConfig: {} },
    checkPermission: () => ({ allowed: true }), isConfiguredSuperUser: () => false,
    userCooldowns: new Map(), giftRequestCredits: new Map(),
    getGiftRequirementForGuardLevel: () => ({ tier: 'Normal', requirement: {} }),
    canRequestWithGiftCredits: () => true, consumeGiftRequestCredit: (_requirement, credits) => credits,
    giftRequestTierLabel: () => '普通观众', describeGiftRequestRequirement: () => '礼物',
    MAX_DANMAKU_COMMAND_QUEUE: 200, MAX_DANMAKU_COMMAND_AGE_MS: 90_000,
    danmakuCommandQueue: [], recentDanmakuCommands: new Map(), processingDanmakuCommand: false,
    ...overrides
  });
  new vm.Script(compiled).runInContext(context);
  return {
    context, notices: () => store.snapshot(now), advance: milliseconds => { now += milliseconds; },
    feedback: (title = '搜索词', action = 'request') => context.beginRequestFeedback(user, action, title),
    async handle(message, sender = user) {
      const command = parseRequestNotificationCommand(message);
      const feedback = context.beginRequestFeedback(sender, command.action, command.title);
      await context.handleDanmaku(sender, message, feedback);
      return feedback;
    }
  };
}

test('search waiting becomes one successful notice with the resolved song title', async () => {
  let finishSearch;
  const f = fixture({ playerManager: { search: () => new Promise(resolve => { finishSearch = resolve; }) } });
  const result = f.context.tryRequestSong(user, '搜索词', 'normal', f.feedback());
  const initial = f.notices()[0];
  assert.equal(initial.kind, 'waiting');
  assert.equal(initial.title, '搜索词');
  finishSearch([track]);
  assert.equal((await result).success, true);
  assert.equal(f.notices().length, 1);
  assert.equal(f.notices()[0].id, initial.id);
  assert.equal(f.notices()[0].kind, 'success');
  assert.equal(f.notices()[0].action, 'request');
  assert.equal(f.notices()[0].title, '真实歌名');
  assert.equal(f.context.targetQueue[0].SongName, '真实歌名');
  assert.equal(JSON.stringify(f.notices()).includes('private-native-data'), false);
});

test('unconfirmed immediate and interrupt playback report accepted queue fallback', async () => {
  for (const mode of ['play_now', 'interrupt']) {
    const f = fixture();
    const result = await f.context.tryRequestSong(user, '搜索词', mode, f.feedback());
    assert.equal(result.success, true);
    assert.equal(result.playbackConfirmed, false);
    assert.equal(f.notices()[0].kind, 'success');
    assert.match(f.notices()[0].message, /等待播放/);
    assert.equal(f.context.targetQueue.length, 1);
  }
});

test('missing songs and search exceptions finish waiting without exposing internal errors', async () => {
  for (const search of [async () => [], async () => { throw new Error('secret backend URL'); }]) {
    const f = fixture({ playerManager: { search } });
    assert.equal((await f.context.tryRequestSong(user, '搜索词', 'normal', f.feedback())).success, false);
    assert.equal(f.notices().length, 1);
    assert.equal(f.notices()[0].kind, 'error');
    assert.equal(f.notices()[0].title, '搜索词');
    assert.equal(JSON.stringify(f.notices()).includes('secret'), false);
  }
});

test('requests without danmaku feedback, such as the local test API, publish no public notices', async () => {
  for (const search of [async () => [track], async () => [], async () => { throw new Error('offline'); }]) {
    const f = fixture({ playerManager: { search } });
    await f.context.tryRequestSong(user, '搜索词');
    await f.context.tryRequestSong(user, '搜索词', 'play_now');
    assert.deepEqual(f.notices(), []);
  }
});

test('success is published right after enqueueing, before player synchronization settles', async () => {
  for (const [mode, overrides] of [
    ['normal', { isPlaying: true, guardNextSong: () => new Promise(() => {}) }],
    ['top', { targetQueue: [{ Id: 'old', SongName: '旧队首' }], reconcileQueueHeadAfterMutation: () => new Promise(() => {}) }]
  ]) {
    let guardCalls = 0;
    const f = fixture(overrides);
    const original = f.context.guardNextSong;
    f.context.guardNextSong = (...args) => { guardCalls++; return original(...args); };
    const result = f.context.tryRequestSong(user, '搜索词', mode, f.feedback());
    let settled = false;
    void result.then(() => { settled = true; });
    await flush();
    assert.equal(settled, false, mode);
    assert.equal(f.notices()[0].kind, 'success', mode);
    assert.equal(f.notices()[0].title, '真实歌名', mode);
    assert.equal(f.notices()[0].message, mode === 'top' ? '点歌成功，已置顶待播' : '点歌成功，已加入待播队列');
    assert.equal(f.context.targetQueue.some(song => song.SongName === '真实歌名'), true, mode);
    if (mode === 'normal') assert.equal(guardCalls, 1);
  }
});

test('a player sync failure after enqueueing keeps the accepted request and its success notice', async () => {
  for (const [mode, overrides] of [
    ['normal', { isPlaying: true, guardNextSong: async () => { throw new Error('connector timeout'); } }],
    ['top', {
      targetQueue: [{ Id: 'old', SongName: '旧队首' }],
      reconcileQueueHeadAfterMutation: async () => { throw new Error('connector timeout'); }
    }]
  ]) {
    const f = fixture(overrides);
    const feedback = f.feedback();
    const result = await f.context.tryRequestSong(user, '搜索词', mode, feedback);
    assert.equal(result.success, true, mode);
    assert.equal(result.queued, true, mode);
    assert.equal(feedback.completed, true);
    assert.equal(f.notices().length, 1);
    assert.equal(f.notices()[0].kind, 'success');
    assert.equal(f.notices()[0].message, '已加入待播队列，播放器同步稍后重试');
    assert.equal(f.context.targetQueue.some(song => song.SongName === '真实歌名'), true);
    assert.equal(f.context.recentRejects.length, 0);
  }
});

test('an unsupported QQ version holds every queued outcome with an honest notice', async () => {
  for (const mode of ['normal', 'top', 'play_now', 'interrupt']) {
    const f = fixture({
      getSelectedPlayerKey: () => 'qqmusic', playerControlNotice: { kind: 'compatibility' },
      isPlaying: true, guardNextSong: async () => false, playSongNow: async () => false
    });
    const result = await f.context.tryRequestSong(user, '搜索词', mode, f.feedback());
    assert.equal(result.success, true, mode);
    assert.equal(f.notices()[0].kind, 'success', mode);
    assert.equal(f.notices()[0].message, QQ_HOLD_MESSAGE, mode);
    assert.equal(f.context.targetQueue.length, 1, mode);
  }
  for (const [playerKey, notice] of [['qqmusic', { kind: 'upgrade' }], ['netease', { kind: 'compatibility' }]]) {
    const f = fixture({ getSelectedPlayerKey: () => playerKey, playerControlNotice: notice });
    await f.context.tryRequestSong(user, '搜索词', 'normal', f.feedback());
    assert.equal(f.notices()[0].message, '点歌成功，已加入待播队列');
  }
});

test('a player switch while the avatar or cover resolves rejects the old player result', async () => {
  for (const change of ['key', 'epoch']) {
    let playerKey = 'netease';
    const avatar = deferred();
    const searched = deferred();
    let avatarCalls = 0;
    const f = fixture({
      getSelectedPlayerKey: () => playerKey,
      getBiliAvatar: () => { avatarCalls++; return avatar.promise; },
      playerManager: { search: () => searched.promise }
    });
    const result = f.context.tryRequestSong(faceless, '搜索词', 'normal', f.feedback());
    assert.equal(avatarCalls, 1, 'avatar lookup starts with the search');
    searched.resolve([track]);
    await flush();
    if (change === 'key') playerKey = 'kugou';
    else f.context.playerSelectionEpoch++;
    avatar.resolve('face');
    const outcome = await result;
    assert.equal(outcome.success, false, change);
    assert.equal(outcome.message, '播放器已切换，请重新点歌');
    assert.equal(f.notices()[0].kind, 'error');
    assert.match(f.notices()[0].message, /播放器已切换/);
    assert.deepEqual(f.context.targetQueue, []);
  }

  // Switching away and back still invalidates requests from before the switch.
  const settled = deferred();
  const f = fixture({ waitForManagedPlayerActionSettlement: () => settled.promise, playSongNow: async () => true });
  const result = f.context.tryRequestSong(user, '搜索词', 'play_now', f.feedback());
  await flush();
  f.context.playerSelectionEpoch += 2;
  settled.resolve();
  assert.equal((await result).success, false);
  assert.deepEqual(f.context.targetQueue, []);
});

test('every queued request receives its own request identity', async () => {
  const f = fixture();
  await f.context.tryRequestSong(user, '搜索词');
  await f.context.tryRequestSong(user, '搜索词', 'top');
  const ids = f.context.targetQueue.map(song => song.RequestId);
  assert.equal(ids.length, 2);
  assert.ok(ids.every(Boolean));
  assert.notEqual(ids[0], ids[1]);
});

test('permission, cooldown, gift and disabled requests retain their requested title and fail before search', async () => {
  for (const overrides of [
    { checkPermission: () => ({ allowed: false, reason: '权限不足' }) },
    { appConfig: { sysConfig: { Cooldowns: { Normal: 60 } } }, userCooldowns: new Map([['1', 999_999]]) },
    { canRequestWithGiftCredits: () => false }, { isAccepting: false }
  ]) {
    const f = fixture({ ...overrides, playerManager: { search() { throw new Error('must not search'); } } });
    const feedback = await f.handle('点歌 搜索词');
    assert.equal(feedback.completed, true);
    assert.equal(f.notices()[0].kind, 'error');
    assert.equal(f.notices()[0].title, '搜索词');
    assert.match(f.notices()[0].message, /点歌失败/);
    assert.equal(f.context.targetQueue.length, 0);
  }
});

test('rejections never wait for an avatar lookup and patch the face when it arrives', async () => {
  const deadline = () => new Promise((_, reject) => setTimeout(() => reject(new Error('waited for avatar')), 200));
  const stalled = fixture({
    getBiliAvatar: () => new Promise(() => {}),
    appConfig: { sysConfig: { Cooldowns: { Normal: 60 } } }, userCooldowns: new Map([['1', 999_999]])
  });
  await Promise.race([stalled.context.addReject(faceless, '冷却中'), deadline()]);
  await Promise.race([stalled.handle('点歌 搜索词', faceless), deadline()]);
  assert.equal(stalled.context.recentRejects.length, 2);
  assert.equal(stalled.context.recentRejects[0].user.avatar, AVATAR_PLACEHOLDER);

  const avatar = deferred();
  const late = fixture({ getBiliAvatar: () => avatar.promise });
  await late.context.addReject(faceless, '原因');
  avatar.resolve('https://face');
  await flush();
  assert.equal(late.context.recentRejects[0].user.avatar, 'https://face');

  let lookups = 0;
  const cached = fixture({
    biliAvatarCache: { peek: uid => (uid === '1' ? 'cached-face' : undefined) },
    getBiliAvatar: async () => { lookups++; return 'fresh'; }
  });
  await cached.context.addReject(faceless, '原因');
  assert.equal(cached.context.recentRejects[0].user.avatar, 'cached-face');
  assert.equal(lookups, 0);
});

test('a bare 点歌 only fails its notice, without a reject toast or avatar lookup', async () => {
  for (const overrides of [
    {},
    { appConfig: { sysConfig: { Cooldowns: { Normal: 60 } } }, userCooldowns: new Map([['1', 999_999]]) },
    { checkPermission: () => ({ allowed: false, reason: '权限不足' }) }
  ]) {
    let lookups = 0;
    const f = fixture({ ...overrides, getBiliAvatar: async () => { lookups++; return 'face'; } });
    for (const message of ['点歌', '置顶点歌 ']) {
      const feedback = await f.handle(message, faceless);
      assert.equal(feedback.completed, true);
      assert.equal(f.notices().at(-1).kind, 'error');
      assert.equal(f.notices().at(-1).message, '点歌失败：请在点歌指令后填写歌名');
    }
    assert.equal(f.context.recentRejects.length, 0);
    assert.equal(lookups, 0);
  }
});

test('paused intake publishes at most one public reminder per 10 seconds', async () => {
  const f = fixture({ isAccepting: false });
  const first = await f.handle('点歌 第一首');
  const second = await f.handle('点歌 第二首');
  assert.equal(first.completed && second.completed, true);
  assert.deepEqual(f.notices().map(item => [item.title, item.kind]), [['第一首', 'error']]);
  assert.match(f.notices()[0].message, /已暂停接收点歌/);
  f.advance(9_999);
  const withdrawal = await f.handle('撤回');
  assert.equal(withdrawal.completed, true);
  assert.equal(f.notices().some(item => item.id === withdrawal.id), false);
  f.advance(1);
  await f.handle('点歌 第三首');
  assert.deepEqual(f.notices().map(item => [item.title, item.kind]), [['第三首', 'error']]);

  // Dismissed waiting cards stay removed after the command queue finishes.
  const queued = fixture({ isAccepting: false, processingDanmakuCommand: true });
  queued.context.enqueueDanmakuCommand(user, '点歌 第一首');
  queued.context.enqueueDanmakuCommand(user, '点歌 第二首');
  assert.equal(queued.notices().length, 2);
  queued.context.processingDanmakuCommand = false;
  await queued.context.processDanmakuCommandQueue();
  assert.deepEqual(queued.notices().map(item => [item.title, item.kind]), [['第一首', 'error']]);
});

test('withdrawal names the actual removed song, and empty queue reports withdrawal failure', async () => {
  for (const message of ['撤回', '撤回 真实']) {
    const f = fixture({ targetQueue: [{ Id: '1', SongName: '真实歌名', ArtistName: '歌手', OrderedByUid: '1' }] });
    await f.handle(message);
    assert.equal(f.context.targetQueue.length, 0);
    assert.equal(f.notices()[0].kind, 'cancelled');
    assert.equal(f.notices()[0].action, 'cancel');
    assert.equal(f.notices()[0].title, '真实歌名');
  }
  const f = fixture();
  await f.handle('撤回');
  assert.equal(f.notices()[0].kind, 'error');
  assert.equal(f.notices()[0].action, 'cancel');
  assert.match(f.notices()[0].message, /撤回失败/);
});

test('a request for a song titled 撤回 stays a request when it fails', async () => {
  const f = fixture({ playerManager: { search: async () => [] } });
  await f.handle('点歌 撤回');
  assert.equal(f.notices()[0].kind, 'error');
  assert.equal(f.notices()[0].action, 'request');
  assert.match(f.notices()[0].message, /^点歌失败/);
});

test('queued requests finish the same notice, deduplicate delivery, and terminate expired/full requests', async () => {
  const f = fixture({ processingDanmakuCommand: true });
  f.context.enqueueDanmakuCommand(user, '点歌 搜索词');
  f.context.enqueueDanmakuCommand(user, '点歌 搜索词');
  assert.equal(f.notices().length, 1);
  assert.equal(f.notices()[0].kind, 'waiting');
  const id = f.notices()[0].id;
  f.context.processingDanmakuCommand = false;
  await f.context.processDanmakuCommandQueue();
  assert.equal(f.notices()[0].id, id);
  assert.equal(f.notices()[0].kind, 'success');

  const expired = fixture({ processingDanmakuCommand: true });
  expired.context.enqueueDanmakuCommand(user, '点歌 搜索词');
  expired.advance(90_001);
  expired.context.processingDanmakuCommand = false;
  await expired.context.processDanmakuCommandQueue();
  assert.equal(expired.notices()[0].kind, 'error');
  assert.match(expired.notices()[0].message, /90 秒/);

  const full = fixture({ MAX_DANMAKU_COMMAND_QUEUE: 0 });
  full.context.enqueueDanmakuCommand(user, '点歌 搜索词');
  assert.equal(full.notices()[0].kind, 'error');
  assert.equal(full.context.danmakuCommandQueue.length, 0);
});

test('an accepted request is never overwritten by a later handler failure', async () => {
  const f = fixture({
    processingDanmakuCommand: true,
    consumeGiftRequestCredit() { throw new Error('credit store failed'); }
  });
  f.context.enqueueDanmakuCommand(user, '点歌 搜索词');
  f.context.processingDanmakuCommand = false;
  await f.context.processDanmakuCommandQueue();
  assert.equal(f.notices()[0].kind, 'success');
  assert.equal(f.context.targetQueue.length, 1);
});
