import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../electron/diagnostics-policy.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
const module = { exports: {} };
vm.runInNewContext(compiled, { module, exports: module.exports });
const { buildDiagnosticChecks, DanmakuReceptionTracker } = module.exports;

const connector = {
  id: 'qqmusic', name: 'QQ 音乐', installed: true,
  currentVersion: '22.60.2', latestVersion: '22.60.2', minimumCoreVersion: '1.1.10',
  compatible: true, updateAvailable: false, autoUpdateAvailable: false,
  manualUpdateAvailable: false, updateKind: 'none', supportedPlayerVersion: '22.60',
  updating: false, checkedAt: '2026-10-17T12:00:00Z', error: null
};
const base = {
  room: { enabled: true, status: 'connected', message: '', requestedRoomId: 123, realRoomId: 456 },
  loginReady: true, accepting: true, queuePlaybackEnabled: true, playerKey: 'qqmusic',
  playerConnected: true, playerConnecting: false,
  snapshot: {
    connected: true, player: 'qqmusic', version: '22.60', status: 'ready', observedAt: '',
    capabilities: { search: true, playSelected: true }
  },
  connector, connectorError: '', search: { status: 'pass', message: '已找到歌曲。' },
  ordinaryPermission: { allowed: true }, giftRequirement: '', cooldownSeconds: 0,
  pendingCommands: 0, receptionCount: 0, lastDanmakuAt: null
};
const check = (id, changes = {}) => buildDiagnosticChecks({ ...base, ...changes }).find(item => item.id === id);

test('guest mode supports ordinary requests while identity-dependent actions need login', () => {
  const guest = check('login', { loginReady: false });
  assert.equal(guest.status, 'warning');
  assert.match(guest.message, /游客模式/);
  assert.match(guest.message, /普通点歌和撤回/);
  assert.match(guest.advice, /房管、舰队/);
  assert.doesNotMatch(guest.advice, /重试弹幕连接/);
  assert.doesNotMatch(check('request-permission').advice, /黑名单/);
});

test('authenticated room is not evidence of receiving real danmaku', () => {
  assert.equal(check('room-connection').status, 'pass');
  assert.equal(check('danmaku-reception').status, 'unknown');
  assert.equal(check('danmaku-reception', { receptionCount: 1, lastDanmakuAt: 10 }).status, 'pass');
  assert.equal(check('danmaku-reception', { receptionCount: 1, lastDanmakuAt: null }).status, 'unknown');
  assert.equal(check('danmaku-reception', {
    room: { ...base.room, enabled: false }, receptionCount: 2, lastDanmakuAt: 10
  }).status, 'unknown');
});

test('historical reception reports session evidence without claiming current realtime health', () => {
  const historical = check('danmaku-reception', { receptionCount: 8, lastDanmakuAt: 1 });
  assert.equal(historical.status, 'pass');
  assert.match(historical.message, /本次连接已收到 8 条/);
  assert.doesNotMatch(historical.message, /实时|接收正常|当前正常/);
  assert.match(historical.advice, /启动接收测试/);
});

test('disabled room stays manual while only failed enabled room offers reconnect', () => {
  const disabled = check('room-connection', { room: { ...base.room, enabled: false, status: 'error' } });
  assert.equal(disabled.repair, undefined);
  assert.match(disabled.advice, /手动连接/);
  for (const status of ['connecting', 'disconnected']) {
    assert.equal(check('room-connection', { room: { ...base.room, status } }).repair, undefined);
  }
  assert.equal(check('room-connection', { room: { ...base.room, status: 'error' } }).repair, 'reconnect-room');
});

test('search and capability success never claim real playback success', () => {
  assert.equal(check('song-search').status, 'pass');
  assert.match(check('song-search').advice, /不代表/);
  assert.equal(check('player-capabilities').status, 'pass');
  assert.equal(check('playback-verification').status, 'unknown');
  assert.match(check('playback-verification').advice, /实际出声/);
  assert.equal(check('player-capabilities', { snapshot: null }).status, 'unknown');
  assert.equal(check('player-capabilities', {
    snapshot: { ...base.snapshot, capabilities: { search: true, playSelected: false } }
  }).status, 'error');
});

test('player reconnect is offered only when it is not already connecting', () => {
  assert.equal(check('player-connection', { playerConnected: false }).repair, 'reconnect-player');
  assert.equal(check('player-connection', { playerConnected: false, playerConnecting: true }).repair, undefined);
  assert.equal(check('player-connection', { snapshot: { ...base.snapshot, connected: false } }).status, 'error');
});

test('offline or incomplete catalog cannot claim latest or offer an update', () => {
  for (const changes of [
    { connector: null }, { connectorError: '无法访问目录' },
    { connector: { ...connector, error: '网络错误', autoUpdateAvailable: true } },
    { connector: { ...connector, latestVersion: null } },
    { connector: { ...connector, checkedAt: '' } },
    { connector: { ...connector, currentVersion: null } },
    { connector: { ...connector, id: 'netease' } }
  ]) {
    assert.equal(check('connector-update', changes).status, 'unknown');
    assert.equal(check('connector-update', changes).repair, undefined);
  }
});

test('core compatibility is separate from player compatibility and required core upgrades cannot auto repair', () => {
  assert.equal(check('connector-update').status, 'pass');
  assert.match(check('connector-update').advice, /核心版本兼容/);
  assert.match(check('connector-update').advice, /播放器是否可用/);
  const incompatible = check('connector-update', { connector: { ...connector, compatible: false, autoUpdateAvailable: true } });
  assert.equal(incompatible.status, 'error');
  assert.equal(incompatible.repair, undefined);
  assert.match(incompatible.message, /1\.1\.10/);
});

test('revision updates and first installs are repairable but branch changes require manual confirmation', () => {
  for (const updated of [{ ...connector, autoUpdateAvailable: true }, { ...connector, installed: false }]) {
    assert.equal(check('connector-update', { connector: updated }).repair, 'update-connector');
  }
  const manual = check('connector-update', { connector: {
    ...connector, manualUpdateAvailable: true, autoUpdateAvailable: true
  } });
  assert.equal(manual.repair, undefined);
  assert.match(manual.advice, /手动确认/);
  assert.equal(check('connector-update', { connector: { ...connector, updating: true, autoUpdateAvailable: true } }).repair, undefined);
});

test('user policy blockers explain rejection or delay without proposing changes to settings', () => {
  const blocked = {
    accepting: false, queuePlaybackEnabled: false, ordinaryPermission: { allowed: false, reason: '仅限粉丝' },
    giftRequirement: '需要一个小心心', cooldownSeconds: 30, pendingCommands: 4
  };
  for (const id of ['request-accepting', 'queue-playback', 'request-permission', 'gift-requirement', 'request-cooldown', 'command-queue']) {
    assert.equal(check(id, blocked).status, 'warning');
    assert.equal(check(id, blocked).repair, undefined);
  }
  assert.match(check('request-permission', blocked).message, /仅限粉丝/);
  assert.match(check('request-cooldown', blocked).message, /30/);
  assert.match(check('queue-playback', blocked).message, /成功点歌也不会自动播放/);
});

test('QQ missing playback anchor gives actionable playback guidance', () => {
  const result = check('playback-verification', { snapshot: { ...base.snapshot, playbackAnchorReady: false } });
  assert.equal(result.status, 'unknown');
  assert.match(result.advice, /先在播放器中播放一首歌曲/);
});

test('tracker records only current session nonempty real messages and exact test phrase', () => {
  const tracker = new DanmakuReceptionTracker();
  tracker.resetSession(1, 456);
  const state = tracker.start(1, 456, '嗷呜测试123', 100);
  assert.equal(state.expiresAt, 60100);
  tracker.observe(0, 456, '嗷呜测试123', 101);
  tracker.observe(1, 123, '嗷呜测试123', 102);
  tracker.observe(1, 456, '  ', 103);
  assert.equal(tracker.observation.count, 0);
  tracker.observe(1, 456, '其他真实弹幕', 104);
  tracker.observe(1, 456, '包含嗷呜测试123的其他弹幕', 105);
  assert.equal(tracker.observation.count, 2);
  assert.equal(tracker.getState(105).status, 'waiting');
  tracker.observe(1, 456, '嗷呜测试123', 106);
  assert.equal(tracker.getState(106).status, 'received');
  assert.equal(tracker.getState(106).receivedAt, 106);
  assert.equal(tracker.observation.lastDanmakuAt, 106);
});

test('late messages count as observations but cannot pass an expired test', () => {
  const tracker = new DanmakuReceptionTracker();
  tracker.resetSession(1, 456);
  tracker.start(1, 456, '测试', 100);
  tracker.observe(1, 456, '测试', 60100);
  assert.equal(tracker.getState(60100).status, 'timeout');
  assert.equal(tracker.getState(60100).receivedAt, null);
  assert.equal(tracker.observation.count, 1);
  tracker.start(1, 456, '测试2', 70000);
  assert.equal(tracker.getState(130000).status, 'timeout');
});

test('changing room session cancels waiting test and clears observations', () => {
  const tracker = new DanmakuReceptionTracker();
  tracker.resetSession(1, 456);
  tracker.start(1, 456, '测试', 100);
  tracker.observe(1, 456, '其他', 101);
  tracker.resetSession(2, 789);
  assert.equal(tracker.getState(102).status, 'cancelled');
  assert.equal(tracker.observation.count, 0);
  assert.equal(tracker.observation.lastDanmakuAt, null);
  tracker.observe(1, 456, '测试', 103);
  assert.equal(tracker.observation.count, 0);
  tracker.start(2, 789, '新测试', 104);
  tracker.observe(2, 789, '新测试', 105);
  assert.equal(tracker.getState(105).status, 'received');
});

test('successful reception from a prior room never carries over to a new session', () => {
  const tracker = new DanmakuReceptionTracker();
  tracker.resetSession(1, 456);
  tracker.start(1, 456, '测试', 100);
  tracker.observe(1, 456, '测试', 101);
  assert.equal(tracker.getState(101).status, 'received');
  tracker.resetSession(2, 789);
  assert.equal(tracker.getState(102).status, 'cancelled');
  assert.equal(tracker.getState(102).receivedAt, null);
  assert.equal(tracker.observation.count, 0);
  assert.equal(tracker.observation.lastDanmakuAt, null);
  tracker.observe(1, 456, '测试', 103);
  assert.equal(tracker.getState(103).status, 'cancelled');
});

test('cancel and invalid starts never allow accidental success', () => {
  const tracker = new DanmakuReceptionTracker();
  tracker.resetSession(1, 456);
  assert.equal(tracker.start(0, 456, '测试', 100).status, 'cancelled');
  assert.equal(tracker.start(1, 123, '测试', 100).status, 'cancelled');
  assert.equal(tracker.start(1, 456, ' ', 100).status, 'cancelled');
  tracker.start(1, 456, '测试', 100);
  tracker.cancel();
  tracker.observe(1, 456, '测试', 101);
  assert.equal(tracker.getState(101).status, 'cancelled');
  assert.equal(tracker.getState(101).receivedAt, null);
});

test('old timestamps cannot pass a new test and returned state cannot mutate tracker', () => {
  const tracker = new DanmakuReceptionTracker();
  tracker.resetSession(1, 456);
  const returned = tracker.start(1, 456, '测试', 100);
  returned.phrase = '其他';
  tracker.observe(1, 456, '测试', 99);
  assert.equal(tracker.getState(100).status, 'waiting');
  const observed = tracker.observation;
  observed.count = 500;
  assert.equal(tracker.observation.count, 1);
  const snapshot = tracker.getState(101);
  snapshot.status = 'received';
  assert.equal(tracker.getState(102).status, 'waiting');
  tracker.observe(1, 456, '测试', 103);
  assert.equal(tracker.getState(103).status, 'received');
});
