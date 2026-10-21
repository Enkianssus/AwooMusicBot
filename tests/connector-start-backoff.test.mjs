import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as backoffModule from '../electron/connector-start-backoff.ts';
import * as compatibility from '../electron/qq-native-compatibility-policy.ts';
import * as queuePolicy from '../electron/queue-head-policy.ts';
import * as playerTypes from '../electron/players/types.ts';

const { CONNECTOR_START_BACKOFF_MS, createStartBackoff } = backoffModule;

test('start retry delays follow the schedule and stay at the 30 s cap', () => {
  assert.deepEqual(CONNECTOR_START_BACKOFF_MS, [1000, 2000, 5000, 15000, 30000]);
  const backoff = createStartBackoff();
  const delays = Array.from({ length: 8 }, (_, i) => backoff.recordFailure(i * 100_000).delayMs);
  assert.deepEqual(delays, [1000, 2000, 5000, 15000, 30000, 30000, 30000, 30000]);
  assert.equal(backoff.failures, 8);
});

test('a failed start blocks further attempts until its deadline', () => {
  const backoff = createStartBackoff();
  assert.equal(backoff.canAttempt(0), true);
  backoff.recordFailure(10_000);
  assert.equal(backoff.canAttempt(10_000), false);
  assert.equal(backoff.canAttempt(10_999), false);
  assert.equal(backoff.canAttempt(11_000), true);
  backoff.recordFailure(11_000);
  assert.equal(backoff.canAttempt(12_999), false);
  assert.equal(backoff.canAttempt(13_000), true);
});

test('a streak is announced once when it starts and once when the delay reaches the cap', () => {
  const backoff = createStartBackoff();
  const failures = Array.from({ length: 7 }, (_, i) => backoff.recordFailure(i));
  assert.deepEqual(failures.map(failure => failure.firstInStreak),
    [true, false, false, false, false, false, false]);
  assert.deepEqual(failures.map(failure => failure.firstAtCap),
    [false, false, false, false, true, false, false]);
});

test('success and reset both end the streak and clear the deadline', () => {
  for (const end of ['recordSuccess', 'reset']) {
    const backoff = createStartBackoff();
    backoff.recordFailure(0);
    backoff.recordFailure(1000);
    backoff[end]();
    assert.equal(backoff.failures, 0, end);
    assert.equal(backoff.canAttempt(1001), true, end);
    assert.deepEqual(backoff.recordFailure(2000), { delayMs: 1000, firstInStreak: true, firstAtCap: false }, end);
  }
});

// Run the actual PlayerManager polling against a scripted bridge. No connector
// process, updater, media session or Electron module is loaded.
const managerSource = fs.readFileSync(
  new URL('../electron/players/player-manager.ts', import.meta.url), 'utf8'
);
const managerJs = ts.transpileModule(managerSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;

function managerFixture() {
  const clock = { now: 1_000_000 };
  const logs = [];
  const intervals = new Set();
  let selectedKey = 'netease';
  const bridge = {
    running: false,
    supportsSnapshotEvents: false,
    starts: [],
    probes: 0,
    startError: new Error('播放器桥已退出 (code=-532462766)'),
    probeError: null,
    async start(key) {
      this.starts.push(key);
      if (this.startError) throw this.startError;
      this.running = true;
    },
    async probe(key) {
      if (!this.running) await this.start(key);
      this.probes++;
      if (this.probeError) {
        this.running = false;
        throw this.probeError;
      }
      return { connected: false, player: key, version: '', status: '播放器未运行', observedAt: '' };
    },
    async restart(key) {
      this.running = false;
      await this.start(key);
    },
    async stop() {
      this.running = false;
    },
    async updateConnector() {
      return { success: true, updated: true, message: '连接器已更新' };
    }
  };
  const backend = (key, label) => class {
    constructor() {
      Object.assign(this, { key, label, usesNativeBridge: true });
    }
    async activate() { return await this.probe(); }
    deactivate() {}
    async probe() { return await bridge.probe(key); }
  };
  const imports = {
    '../player-bridge-client': { PlayerBridgeClient: function PlayerBridgeClient() { return bridge; } },
    '../connector-start-backoff': backoffModule,
    '../queue-head-policy': queuePolicy,
    '../qq-native-compatibility-policy': compatibility,
    '../player-process-inspector': {
      inspectPlayerProcess() { throw new Error('Pure tests must not inspect processes'); }
    },
    './folia-player': { FoliaPlayerBackend: backend('folia', 'Folia') },
    './kugou-player': { KugouPlayerBackend: backend('kugou', '酷狗音乐') },
    './netease-player': { NeteasePlayerBackend: backend('netease', '网易云音乐') },
    './qqmusic-player': { QQMusicPlayerBackend: backend('qqmusic', 'QQ 音乐') },
    './types': playerTypes
  };
  const module = { exports: {} };
  vm.runInNewContext(managerJs, {
    module,
    exports: module.exports,
    require(name) {
      assert.ok(Object.hasOwn(imports, name), `Unexpected manager dependency: ${name}`);
      return imports[name];
    },
    Date: { now: () => clock.now },
    setInterval(callback) {
      const timer = { callback };
      intervals.add(timer);
      return timer;
    },
    clearInterval(timer) { intervals.delete(timer); }
  });
  const manager = new module.exports.PlayerManager({
    getSelectedKey: () => selectedKey,
    getFoliaToken: () => '',
    log: message => logs.push(message),
    setStatus() {},
    onStateChanged() {},
    async onTrackChanged() {},
    async onTrackUpdated() {}
  });
  return {
    manager, bridge, clock, logs, intervals,
    select(key) { selectedKey = key; },
    poll: () => manager.pollNativePlayer(manager.selectionGeneration),
    retryLogs: () => logs.filter(message => message.includes('连接器启动失败'))
  };
}

test('manager polling retries a failing connector on the backoff schedule and logs once per streak', async () => {
  const f = managerFixture();
  const attemptAt = [0, 1000, 3000, 8000, 23000, 53000];
  const start = f.clock.now;
  for (let elapsed = 0; elapsed <= 53_000; elapsed += 500) {
    f.clock.now = start + elapsed;
    await f.poll();
  }
  assert.equal(f.bridge.starts.length, attemptAt.length);
  assert.equal(f.manager.startBackoff.failures, attemptAt.length);
  assert.deepEqual(f.retryLogs(), [
    '⚠️ 网易云音乐 连接器启动失败，将在 1 秒后重试：播放器桥已退出 (code=-532462766)',
    '⚠️ 网易云音乐 连接器启动失败，将在 30 秒后重试：播放器桥已退出 (code=-532462766)'
  ]);
  assert.equal(f.manager.probeGeneration, null);
  assert.equal(f.manager.connectionState.connected, false);

  // A successful probe ends the streak; the next failure starts a new one.
  f.bridge.startError = null;
  f.clock.now = start + 83_000;
  await f.poll();
  assert.equal(f.bridge.probes, 1);
  assert.equal(f.manager.startBackoff.failures, 0);
  f.bridge.running = false;
  f.bridge.startError = new Error('spawn UNKNOWN');
  f.clock.now += 1;
  await f.poll();
  assert.equal(f.bridge.starts.length, attemptAt.length + 2);
  assert.equal(f.retryLogs().at(-1), '⚠️ 网易云音乐 连接器启动失败，将在 1 秒后重试：spawn UNKNOWN');
});

test('a connector that dies before its first snapshot stays in the same streak', async () => {
  const f = managerFixture();
  f.bridge.startError = null;
  f.bridge.probeError = new Error('播放器桥已退出 (code=1)');
  await f.poll();
  assert.equal(f.bridge.starts.length, 1);
  assert.equal(f.manager.startBackoff.failures, 1);
  f.clock.now += 500;
  await f.poll();
  assert.equal(f.bridge.starts.length, 1, 'no respawn before the backoff deadline');
  // A successful handshake alone does not end the streak, so the delay grows.
  for (const wait of [500, 2000]) {
    f.clock.now += wait;
    await f.poll();
  }
  assert.equal(f.bridge.starts.length, 3);
  assert.equal(f.manager.startBackoff.failures, 3);
  assert.equal(f.retryLogs().length, 1);
});

test('a running bridge keeps the normal polling cadence during a failure streak', async () => {
  const f = managerFixture();
  await f.poll();
  assert.equal(f.manager.startBackoff.failures, 1);
  // Another caller (for example a song search) started the connector.
  f.bridge.running = true;
  f.bridge.startError = null;
  for (let i = 0; i < 3; i++) await f.poll();
  assert.equal(f.bridge.probes, 3);
  assert.equal(f.bridge.starts.length, 1);
  assert.equal(f.manager.startBackoff.failures, 0);
});

test('explicit connects, reconnects, updates and a player switch start a fresh streak', async () => {
  const failTwice = async f => {
    await f.poll();
    f.clock.now += 1000;
    await f.poll();
    assert.equal(f.manager.startBackoff.failures, 2);
  };

  const connect = managerFixture();
  await failTwice(connect);
  assert.equal(await connect.manager.connectSelected(), false);
  assert.equal(connect.manager.startBackoff.failures, 0);
  assert.equal(connect.intervals.size, 1, 'the 350ms poll is still installed after a failed connect');
  const attempts = connect.bridge.starts.length;
  await connect.poll();
  assert.equal(connect.bridge.starts.length, attempts + 1, 'first retry is not delayed');

  const reconnect = managerFixture();
  await failTwice(reconnect);
  assert.equal(await reconnect.manager.reconnect(), false);
  assert.equal(reconnect.manager.startBackoff.failures, 0);
  assert.equal(reconnect.intervals.size, 1, 'a failed restart falls back to the poll');

  // A successful update resets at once, while its reconnect still waits for
  // a running command.
  const update = managerFixture();
  await failTwice(update);
  update.bridge.startError = null;
  let releaseCommand;
  update.manager.operationTail = new Promise(resolve => { releaseCommand = resolve; });
  const updating = update.manager.updateConnector('netease');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(update.manager.startBackoff.failures, 0);
  releaseCommand();
  assert.equal((await updating).success, true);
  assert.equal(update.bridge.running, true);

  const switched = managerFixture();
  await failTwice(switched);
  switched.select('kugou');
  await switched.poll();
  assert.deepEqual(switched.bridge.starts.slice(-1), ['kugou'], 'the new player is not held back');
  assert.equal(switched.manager.startBackoff.failures, 1);
});

test('a reconnect whose restart fails keeps retrying through the backoff-gated poll', async () => {
  const f = managerFixture();
  const states = [];
  f.manager.options.onStateChanged = state => states.push(state);
  assert.equal(await f.manager.reconnect(), false);
  assert.deepEqual({ ...states.at(-1) }, { connected: false, connecting: false, snapshot: null });
  assert.equal(f.retryLogs().length, 0, 'the failed restart is reported once, not as a streak');
  assert.equal(f.intervals.size, 1);
  const [timer] = f.intervals;
  const tick = async () => {
    timer.callback();
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  };

  // The first retry is not delayed; later ones follow the start backoff.
  await tick();
  assert.equal(f.bridge.starts.length, 2);
  assert.equal(f.manager.startBackoff.failures, 1);
  f.clock.now += 500;
  await tick();
  assert.equal(f.bridge.starts.length, 2, 'no respawn before the backoff deadline');
  f.clock.now += 500;
  f.bridge.startError = null;
  await tick();
  assert.equal(f.bridge.starts.length, 3);
  assert.equal(f.bridge.probes, 1);
  assert.equal(f.manager.startBackoff.failures, 0, 'a successful start ends the streak');

  // A newer connect owns the state and the poll of a superseded restart.
  const stale = managerFixture();
  let failRestart;
  stale.bridge.restart = () => new Promise((_resolve, reject) => { failRestart = reject; });
  const reconnecting = stale.manager.reconnect();
  stale.bridge.startError = null;
  await stale.manager.connectSelected();
  const intervals = stale.intervals.size;
  failRestart(new Error('连接器启动已取消'));
  assert.equal(await reconnecting, false);
  assert.equal(stale.intervals.size, intervals);
  assert.equal(stale.logs.some(message => message.includes('播放器重连失败')), false);
});
