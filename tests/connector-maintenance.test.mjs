import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as maintenance from '../electron/connector-maintenance.ts';
import * as compatibility from '../electron/qq-native-compatibility-policy.ts';
import * as backoffModule from '../electron/connector-start-backoff.ts';
import * as queuePolicy from '../electron/queue-head-policy.ts';
import * as playerTypes from '../electron/players/types.ts';
import * as lifecycleGate from '../electron/connector-lifecycle-gate.ts';
import * as jsonlLineBuffer from '../electron/jsonl-line-buffer.ts';

const {
  CONNECTOR_MAINTENANCE_BACKOFF_MS,
  MAINTENANCE_BUSY_RETRY_MS,
  MAINTENANCE_ERROR_RETRY_MS,
  MAINTENANCE_NETEASE_RETRY_MS,
  describeMaintenanceDelay,
  maintenanceFailureKey,
  planConnectorMaintenance,
  recordMaintenanceFailure,
  recordMaintenanceSuccess
} = maintenance;

const NAMES = { netease: '网易云音乐', kugou: '酷狗音乐', qqmusic: 'QQ 音乐', folia: 'Folia' };

function status(id, overrides = {}) {
  return {
    id, name: NAMES[id], installed: true, currentVersion: '1.0.1', latestVersion: '1.0.2',
    minimumCoreVersion: '1.2.0', compatible: true, updateAvailable: true,
    autoUpdateAvailable: true, manualUpdateAvailable: false, updateKind: 'patch',
    supportedPlayerVersion: null, updating: false, quarantined: false,
    checkedAt: '2026-10-21T00:00:00Z', error: null, ...overrides
  };
}

const missing = (id, overrides = {}) => status(id, {
  installed: false, currentVersion: null, updateKind: 'install', ...overrides
});

const upToDate = (id, overrides = {}) => status(id, {
  currentVersion: '1.0.2', updateAvailable: false, autoUpdateAvailable: false,
  updateKind: 'none', ...overrides
});

function plan(overrides = {}) {
  return planConnectorMaintenance({
    statuses: [status('netease'), status('kugou'), status('qqmusic'), status('folia')],
    selectedId: 'qqmusic',
    guardComponentId: null,
    neteaseRunning: false,
    selectedBusy: false,
    failureMemo: new Map(),
    now: 1_000_000,
    ...overrides
  });
}

const decisions = result => result.actions.map(action => `${action.id}:${action.kind}:${action.reason}`);

const settle = async (turns = 5) => {
  for (let i = 0; i < turns; i++) await new Promise(resolve => setImmediate(resolve));
};

// ---------------------------------------------------------------------------
// Pure planner
// ---------------------------------------------------------------------------

test('the selected connector is planned first and the others keep catalog order', () => {
  assert.deepEqual(plan().actions.map(action => action.id), ['qqmusic', 'netease', 'kugou', 'folia']);
  assert.deepEqual(
    plan({ selectedId: 'folia' }).actions.map(action => action.id),
    ['folia', 'netease', 'kugou', 'qqmusic']
  );
  assert.ok(plan().actions.every(action => action.kind === 'update' && action.reason === 'auto-update'));
  assert.equal(plan().retrySoonMs, null);
});

test('only the selected player installs a missing connector in the background', () => {
  const result = plan({
    statuses: [missing('netease'), missing('kugou'), missing('qqmusic'), status('folia')]
  });
  assert.deepEqual(decisions(result), [
    'qqmusic:update:install',
    'netease:skip:not-selected-missing',
    'kugou:skip:not-selected-missing',
    'folia:update:auto-update'
  ]);
  assert.equal(result.retrySoonMs, null);
});

test('an installed NetEase patch waits while NetEase runs, a first install does not', () => {
  const running = plan({ selectedId: 'netease', neteaseRunning: true });
  assert.deepEqual(decisions(running).slice(0, 2), [
    'netease:skip:netease-running', 'kugou:update:auto-update'
  ]);
  assert.equal(running.retrySoonMs, MAINTENANCE_NETEASE_RETRY_MS);
  assert.equal(MAINTENANCE_NETEASE_RETRY_MS, 300_000);
  // The same holds for an installed NetEase connector of an unselected player.
  assert.equal(decisions(plan({ neteaseRunning: true }))[1], 'netease:skip:netease-running');

  const closed = plan({ selectedId: 'netease', neteaseRunning: false });
  assert.equal(decisions(closed)[0], 'netease:update:auto-update');
  assert.equal(closed.retrySoonMs, null);

  const firstInstall = plan({
    selectedId: 'netease', neteaseRunning: true, statuses: [missing('netease')]
  });
  assert.deepEqual(decisions(firstInstall), ['netease:update:install']);
});

test('the selected connector is deferred while requested playback is busy', () => {
  const busy = plan({ selectedBusy: true });
  assert.deepEqual(decisions(busy), [
    'qqmusic:skip:selected-busy',
    'netease:update:auto-update',
    'kugou:update:auto-update',
    'folia:update:auto-update'
  ]);
  assert.equal(busy.retrySoonMs, MAINTENANCE_BUSY_RETRY_MS);
  assert.equal(MAINTENANCE_BUSY_RETRY_MS, 180_000);
  // A missing connector has no connection that a reconnect could interrupt.
  assert.deepEqual(
    decisions(plan({ selectedBusy: true, statuses: [missing('qqmusic')] })),
    ['qqmusic:update:install']
  );
});

test('failed versions back off 30 min, 2 h, then 6 h, and a success resets them', () => {
  assert.deepEqual(CONNECTOR_MAINTENANCE_BACKOFF_MS, [1_800_000, 7_200_000, 21_600_000]);
  const memo = new Map();
  const key = maintenanceFailureKey('qqmusic', '1.0.2');
  assert.equal(key, 'qqmusic@1.0.2');
  const delays = Array.from({ length: 4 }, () =>
    recordMaintenanceFailure(memo, key, 5_000).nextAttemptAt - 5_000);
  assert.deepEqual(delays, [1_800_000, 7_200_000, 21_600_000, 21_600_000]);
  assert.equal(memo.get(key).failures, 4);

  const deadline = memo.get(key).nextAttemptAt;
  const waiting = plan({ failureMemo: memo, now: deadline - 1 });
  assert.equal(decisions(waiting)[0], 'qqmusic:skip:backoff');
  assert.equal(waiting.retrySoonMs, null, 'the interval tick reaches the deadline');
  assert.equal(decisions(waiting).filter(item => item.endsWith('update:auto-update')).length, 3);
  assert.equal(decisions(plan({ failureMemo: memo, now: deadline }))[0], 'qqmusic:update:auto-update');
  // A newer catalog version is a different attempt.
  assert.deepEqual(decisions(plan({
    failureMemo: memo, now: deadline - 1, statuses: [status('qqmusic', { latestVersion: '1.0.3' })]
  })), ['qqmusic:update:auto-update']);

  recordMaintenanceSuccess(memo, key);
  assert.equal(memo.has(key), false);
  assert.equal(recordMaintenanceFailure(memo, key, 0).nextAttemptAt, 1_800_000);

  assert.equal(describeMaintenanceDelay(1_800_000), '30 分钟');
  assert.equal(describeMaintenanceDelay(7_200_000), '2 小时');
  assert.equal(describeMaintenanceDelay(21_600_000), '6 小时');
  assert.equal(describeMaintenanceDelay(180_000), '3 分钟');
});

test('a held installation lock skips the updates and nothing else', () => {
  const result = plan({
    guardComponentId: 'core',
    statuses: [status('qqmusic'), missing('netease'), upToDate('kugou'), missing('folia')],
    selectedId: 'folia'
  });
  assert.deepEqual(decisions(result), [
    'folia:skip:guard-busy',
    'qqmusic:skip:guard-busy',
    'netease:skip:not-selected-missing',
    'kugou:skip:up-to-date'
  ]);
  assert.equal(result.retrySoonMs, null);
});

test('catalog errors of a connector in use ask for an early retry', () => {
  const offline = plan({
    statuses: ['netease', 'kugou', 'qqmusic', 'folia'].map(id => status(id, { error: '连接更新服务器超时' }))
  });
  assert.ok(offline.actions.every(action => action.kind === 'skip' && action.reason === 'error'));
  assert.equal(offline.retrySoonMs, MAINTENANCE_ERROR_RETRY_MS);
  assert.equal(MAINTENANCE_ERROR_RETRY_MS, 180_000);

  // The earliest of several requested retries wins.
  assert.equal(plan({
    selectedId: 'netease', neteaseRunning: true,
    statuses: [status('netease'), status('kugou', { error: '连接更新服务器超时' })]
  }).retrySoonMs, MAINTENANCE_ERROR_RETRY_MS);

  // A connector that would never be installed does not keep the loop busy.
  const unused = plan({
    statuses: [upToDate('qqmusic'), missing('kugou', { error: '更新清单缺少 kugou 连接器' })]
  });
  assert.deepEqual(decisions(unused), ['qqmusic:skip:up-to-date', 'kugou:skip:not-selected-missing']);
  assert.equal(unused.retrySoonMs, null);
});

test('rolled-back, manual, incompatible and running installs are skipped with their own reason', () => {
  const result = plan({
    statuses: [
      status('netease', { compatible: false, updateAvailable: false, autoUpdateAvailable: false }),
      status('kugou', { autoUpdateAvailable: false, manualUpdateAvailable: true, updateKind: 'player' }),
      status('qqmusic', { quarantined: true, autoUpdateAvailable: false }),
      status('folia', { updating: true })
    ]
  });
  assert.deepEqual(decisions(result), [
    'qqmusic:skip:quarantined',
    'netease:skip:incompatible',
    'kugou:skip:manual-only',
    'folia:skip:updating'
  ]);
  assert.equal(result.retrySoonMs, null);
  // Without an installed version a rolled-back release is still the install.
  assert.deepEqual(
    decisions(plan({ statuses: [missing('qqmusic', { quarantined: true, autoUpdateAvailable: false })] })),
    ['qqmusic:update:install']
  );

  for (const reason of ['up-to-date', 'updating', 'not-selected-missing', 'backoff']) {
    assert.equal(maintenance.describeMaintenanceSkip(status('qqmusic'), reason), null, reason);
  }
  assert.deepEqual(maintenance.describeMaintenanceSkip(status('qqmusic', { quarantined: true }), 'quarantined'), {
    message: 'QQ 音乐连接器 1.0.2 已在本机回退，暂停自动更新；如需安装，请在播放器设置中手动更新。',
    color: 'DarkGray'
  });
});

// ---------------------------------------------------------------------------
// The actual main.ts orchestration, run in a vm with inert dependencies. No
// Electron module, connector process, player, network or window is involved.
// ---------------------------------------------------------------------------

const mainSource = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
const mainAst = ts.createSourceFile('main.ts', mainSource, ts.ScriptTarget.Latest, true);

function mainFunctions(names, extra = '') {
  const text = names.map(name => {
    const node = mainAst.statements.find(statement =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    assert.ok(node, `Missing production function ${name}`);
    return node.getText(mainAst);
  }).join('\n');
  return ts.transpileModule(`${text}\n${extra}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText;
}

const maintenanceJs = mainFunctions([
  'maintainPlayerConnectors', 'planPlayerConnectorMaintenance', 'isNeteaseProcessRunning',
  'isSelectedConnectorBusy', 'reportConnectorMaintenanceSkip',
  'applyConnectorMaintenanceUpdate', 'rollBackUnconnectableConnectorUpdate',
  'waitForSelectedPlayerConnection', 'scheduleConnectorMaintenanceRetry',
  'scheduleConnectorMaintenanceAfterResume', 'scheduleQqCompatibilityRecovery',
  'recoverQqCompatibility', 'claimConnectorMaintenanceStatus', 'releaseConnectorMaintenanceStatus',
  'applyDeferredConnectorUpdate', 'restartDeferredConnector', 'scheduleDeferredConnectorRestart'
]);

function maintenanceHarness({ selected = 'qqmusic', statuses = [], isolated = false } = {}) {
  const clock = { now: 10_000_000 };
  const logs = [];
  const timers = [];
  const calls = [];
  const hooks = { onSleep: null };
  const announcements = {
    rolledBack: [],
    failure: null,
    async noteRolledBack(...args) {
      this.rolledBack.push(args);
      if (this.failure) throw new Error(this.failure);
    }
  };
  let context;
  const manager = {
    statuses,
    onUpdate: {},
    /** Arguments of every updateConnector call after the connector id. */
    updateOptions: [],
    /** The selected connector whose installed update waits for a restart. */
    deferredConnectorRestart: null,
    restartReconnects: true,
    async getConnectorStatuses(force) {
      calls.push(['statuses', force]);
      return this.statuses.map(item => ({ ...item }));
    },
    async applyDeferredConnectorRestart(deferWhile) {
      calls.push(['apply-restart', context.connectorMaintenanceStatus]);
      if (this.deferredConnectorRestart === null || deferWhile?.() === true) return { restarted: false };
      this.deferredConnectorRestart = null;
      context.isPlayerConnected = this.restartReconnects;
      return { restarted: true, reconnected: this.restartReconnects };
    },
    async updateConnector(id, allowPlayerVersionChange, options) {
      calls.push(['update', id]);
      this.updateOptions.push({ id, allowPlayerVersionChange, options });
      if (this.onUpdate[id]) return this.onUpdate[id](options);
      // The fake install brings the connector to its latest version.
      const index = this.statuses.findIndex(item => item.id === id);
      const updated = upToDate(id, { currentVersion: this.statuses[index].latestVersion });
      this.statuses[index] = updated;
      return {
        success: true, updated: true, reconnected: true,
        message: `${NAMES[id]}连接器已更新到 ${updated.currentVersion}，已自动重连播放器`,
        status: updated
      };
    },
    async inspectSelectedPlayerProcess() {
      calls.push(['inspect-selected']);
      return context.playerProcess;
    },
    async rollbackConnector(id) {
      calls.push(['rollback', id, context.connectorMaintenanceStatus]);
      return context.rollbackResult;
    },
    async reconnect() {
      calls.push(['reconnect']);
      return true;
    },
    async refreshConnectorProfiles(id) {
      calls.push(['profiles', id]);
      return context.profileResult;
    }
  };
  context = vm.createContext({
    Error,
    Date: { now: () => clock.now },
    setTimeout(callback, delay) {
      // Short waits are the connection poll and complete at once on the fake
      // clock; longer timers are recorded for the test to inspect or fire.
      if (delay <= 1000) {
        clock.now += delay;
        hooks.onSleep?.();
        setImmediate(callback);
        return { delay };
      }
      const timer = { delay, callback };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
    ...maintenance,
    PLAYER_LABELS: playerTypes.PLAYER_LABELS,
    getUpdateAnnouncementService: () => announcements,
    shouldRunAutomaticConnectorMaintenance: directory => !directory,
    devUserDataDir: isolated ? 'C:\\awoo-isolated' : null,
    playerManager: manager,
    selected,
    getSelectedNativeConnector: () => context.selected,
    getSelectedPlayerKey: () => context.selected,
    updateInstallationGuard: { componentId: null },
    async inspectPlayerProcess(id) {
      calls.push(['inspect', id]);
      return context.neteaseProcess;
    },
    neteaseProcess: { running: false, querySucceeded: true },
    playerProcess: { running: true, querySucceeded: true },
    rollbackResult: { success: true, version: '1.0.1', message: 'QQ 音乐连接器已回退到 1.0.1' },
    profileResult: { changed: false, version: null },
    autoRepairResult: false,
    writeLog: (message, color) => logs.push({ message, color }),
    withPlayerConnectionRecoverySuppressed: operation => operation(),
    async connectWithConnectorMaintenanceStatus(connect) {
      calls.push(['connect-with-status']);
      return await connect();
    },
    async runConnectorAutoRepair(id, options) {
      calls.push(['auto-repair', id, options?.quiet === true]);
      return context.autoRepairResult;
    },
    connectorMaintenanceRunning: false,
    deferredConnectorUpdate: null,
    deferredConnectorRestartTimer: null,
    deferredConnectorRestartInFlight: null,
    connectorMaintenanceFailures: new Map(),
    connectorMaintenanceDecisions: new Map(),
    connectorRollbackAttempts: new Set(),
    qqCompatibilityRecoveryAttempts: new Map(),
    connectorMaintenanceRetryTimer: null,
    connectorMaintenanceResumeTimer: null,
    qqCompatibilityRecoveryTimer: null,
    connectorAutoRepairInFlight: null,
    connectorConnectionRecoveryInFlight: null,
    applicationQuitRequested: false,
    isPlayerConnected: true,
    isPlaying: true,
    playerControlNotice: null,
    targetQueue: [],
    currentPlayingSong: null,
    activeManagedPlayerAction: null,
    registeredNextGuardKey: '',
    connectorMaintenanceStatus: '',
    connectorMaintenanceStatusOwner: 0,
    connectorMaintenanceStatusSequence: 0,
    CONNECTOR_UPDATE_CONNECT_TIMEOUT_MS: 30_000,
    CONNECTOR_MAINTENANCE_RESUME_DELAY_MS: 60_000,
    QQ_COMPATIBILITY_RECOVERY_DELAY_MS: 5_000,
    QQ_COMPATIBILITY_RECOVERY_BUSY_DELAY_MS: 60_000,
    QQ_COMPATIBILITY_RECOVERY_RETRY_DELAYS_MS: [120_000, 600_000]
  });
  vm.runInContext(maintenanceJs, context);
  return {
    context, manager, logs, timers, calls, clock, hooks, announcements,
    fire(timer) {
      timers.splice(timers.indexOf(timer), 1);
      timer.callback();
    },
    updates: () => calls.filter(call => call[0] === 'update').map(call => call[1]),
    messages: () => logs.map(log => log.message),
    run: () => context.maintainPlayerConnectors(true)
  };
}

/** Simulates a hot update whose new connector never reaches the player. */
function disconnectingUpdate(f, id = 'qqmusic', version = '1.0.2') {
  return async () => {
    f.context.isPlayerConnected = false;
    return {
      success: true, updated: true, reconnected: false,
      message: `${NAMES[id]}连接器已更新到 ${version}，后台正在等待播放器连接`,
      status: status(id, { currentVersion: version, updateAvailable: false })
    };
  };
}

test('maintenance updates the selected connector first and one failure never stops the rest', async () => {
  const f = maintenanceHarness({
    statuses: [missing('netease'), status('kugou'), status('qqmusic'), missing('folia')]
  });
  f.manager.onUpdate.qqmusic = async () => { throw new Error('另一项更新正在进行，请完成后重试'); };
  const startedAt = f.clock.now;
  await f.run();
  assert.deepEqual(f.updates(), ['qqmusic', 'kugou'], 'unused missing connectors are not installed');
  assert.deepEqual(f.calls[0], ['statuses', true]);
  assert.equal(f.context.connectorMaintenanceRunning, false);
  assert.ok(f.messages().includes('[连接器热更新] QQ 音乐连接器更新失败：另一项更新正在进行，请完成后重试'));
  assert.ok(f.messages().includes('[连接器热更新] QQ 音乐连接器 1.0.2 将在 30 分钟后再次尝试自动更新'));
  assert.deepEqual(
    { ...f.context.connectorMaintenanceFailures.get('qqmusic@1.0.2') },
    { failures: 1, nextAttemptAt: startedAt + 1_800_000 }
  );
  assert.equal(f.context.connectorMaintenanceFailures.has('kugou@1.0.2'), false);
  assert.equal(f.timers.length, 0, 'nothing asked for an early retry');

  // A later run inside the backoff leaves the failed version alone ...
  delete f.manager.onUpdate.qqmusic;
  f.clock.now = startedAt + 60_000;
  await f.run();
  assert.deepEqual(f.updates(), ['qqmusic', 'kugou']);
  // ... and the next interval tick reaches the deadline.
  f.clock.now = startedAt + 1_800_000;
  await f.run();
  assert.deepEqual(f.updates(), ['qqmusic', 'kugou', 'qqmusic']);
  assert.equal(f.context.connectorMaintenanceFailures.has('qqmusic@1.0.2'), false);
});

test('a skipped connector is logged once per reason and an offline check retries soon', async () => {
  const f = maintenanceHarness({
    statuses: [
      status('qqmusic', {
        autoUpdateAvailable: false, manualUpdateAvailable: true, latestVersion: '22.80.1',
        supportedPlayerVersion: '22.80', updateKind: 'player'
      }),
      status('kugou', { error: '连接更新服务器超时' }),
      missing('netease', { error: '连接更新服务器超时' })
    ]
  });
  await f.run();
  assert.deepEqual(f.logs, [
    {
      message: '[连接器热更新] QQ 音乐 有新的播放器版本分支 22.80.1，支持播放器版本 22.80；'
        + '不会自动更新，可在播放器设置中手动确认。',
      color: 'Yellow'
    },
    { message: '[连接器热更新] 酷狗音乐检查失败：连接更新服务器超时', color: 'Yellow' }
  ]);
  assert.deepEqual(f.timers.map(timer => timer.delay), [180_000]);

  await f.run();
  assert.equal(f.logs.length, 2, 'unchanged reasons stay quiet');
  assert.deepEqual(f.timers.map(timer => timer.delay), [180_000], 'one pending retry at most');

  f.manager.statuses[0] = { ...f.manager.statuses[0], latestVersion: '22.81.1' };
  f.manager.statuses[1] = upToDate('kugou');
  await f.run();
  assert.equal(f.logs.length, 3);
  assert.match(f.logs[2].message, /22\.81\.1/);
  assert.equal(f.timers.length, 0, 'the retry is cleared once the catalog is reachable');

  // The retry timer runs another forced check.
  f.manager.statuses[1] = status('kugou', { error: '连接更新服务器超时' });
  await f.run();
  const [retry] = f.timers;
  const checks = f.calls.filter(call => call[0] === 'statuses').length;
  f.fire(retry);
  await settle();
  assert.equal(f.calls.filter(call => call[0] === 'statuses').length, checks + 1);
  assert.deepEqual(f.calls.filter(call => call[0] === 'statuses').at(-1), ['statuses', true]);
});

test('the selected connector waits for idle playback and NetEase patches wait for NetEase to close', async () => {
  const busy = maintenanceHarness({ statuses: [status('qqmusic'), status('kugou')] });
  busy.context.targetQueue = [{ SongName: '点歌' }];
  await busy.run();
  assert.deepEqual(busy.updates(), ['kugou']);
  assert.ok(busy.messages().includes(
    '[连接器热更新] QQ 音乐连接器有更新 1.0.2；正在播放点歌，将在点歌空闲后应用'
  ));
  assert.deepEqual(busy.timers.map(timer => timer.delay), [180_000]);

  for (const [name, patch] of [
    ['a guard registered for the next song', { registeredNextGuardKey: 'guard' }],
    ['a requested song playing', { currentPlayingSong: { SongName: '点歌' } }],
    ['a managed play-now action', { activeManagedPlayerAction: { id: 1 } }]
  ]) {
    const f = maintenanceHarness({ statuses: [status('qqmusic')] });
    Object.assign(f.context, patch);
    await f.run();
    assert.deepEqual(f.updates(), [], name);
  }

  for (const [name, patch] of [
    ['paused queue playback', { isPlaying: false }],
    ['a disconnected player', { isPlayerConnected: false }],
    ['a queue held for an unsupported QQ build', {
      playerControlNotice: { kind: 'compatibility', processId: 7, currentVersion: '22.76' }
    }]
  ]) {
    const f = maintenanceHarness({ statuses: [status('qqmusic')] });
    Object.assign(f.context, { targetQueue: [{ SongName: '点歌' }] }, patch);
    await f.run();
    assert.deepEqual(f.updates(), ['qqmusic'], name);
  }

  const netease = maintenanceHarness({ statuses: [upToDate('qqmusic'), status('netease')] });
  netease.context.neteaseProcess = { running: true, querySucceeded: true };
  await netease.run();
  assert.deepEqual(netease.updates(), []);
  assert.deepEqual(netease.calls.filter(call => call[0] === 'inspect'), [['inspect', 'netease']]);
  assert.ok(netease.messages().includes(
    '[连接器热更新] 网易云音乐连接器有更新 1.0.2；网易云正在运行，连接器更新将在网易云关闭后或下次启动时应用'
  ));
  assert.deepEqual(netease.timers.map(timer => timer.delay), [300_000]);
  // A failed process query is treated as a running NetEase.
  netease.context.neteaseProcess = { running: false, querySucceeded: false };
  await netease.run();
  assert.deepEqual(netease.updates(), []);
  netease.context.neteaseProcess = { running: false, querySucceeded: true };
  await netease.run();
  assert.deepEqual(netease.updates(), ['netease']);

  // Without a pending NetEase patch no process query is started.
  const quiet = maintenanceHarness({ statuses: [status('qqmusic'), upToDate('netease'), missing('kugou')] });
  await quiet.run();
  assert.deepEqual(quiet.calls.filter(call => call[0] === 'inspect'), []);
});

test('a NetEase patch after another update is checked against NetEase again', async () => {
  const f = maintenanceHarness({ statuses: [status('qqmusic'), status('netease')] });
  f.manager.onUpdate.qqmusic = async () => {
    // NetEase was started while the selected connector was updating.
    f.context.neteaseProcess = { running: true, querySucceeded: true };
    return { success: true, updated: true, reconnected: true, message: 'QQ 音乐连接器已更新', status: upToDate('qqmusic') };
  };
  await f.run();
  assert.deepEqual(f.updates(), ['qqmusic']);
  assert.equal(f.calls.filter(call => call[0] === 'inspect').length, 2);
  assert.deepEqual(f.timers.map(timer => timer.delay), [300_000]);
});

test('the selected connector holds a maintenance status through its update and reconnect', async () => {
  const f = maintenanceHarness({ statuses: [status('qqmusic'), status('kugou')] });
  const seen = {};
  for (const id of ['qqmusic', 'kugou']) {
    f.manager.onUpdate[id] = async () => {
      seen[id] = f.context.connectorMaintenanceStatus;
      return { success: true, updated: true, reconnected: true, message: 'ok', status: upToDate(id) };
    };
  }
  await f.run();
  assert.deepEqual(seen, { qqmusic: '正在应用QQ 音乐连接器更新', kugou: '' });
  assert.equal(f.context.connectorMaintenanceStatus, '');

  const first = maintenanceHarness({ statuses: [missing('qqmusic')] });
  first.manager.onUpdate.qqmusic = async () => {
    seen.install = first.context.connectorMaintenanceStatus;
    return { success: true, updated: true, reconnected: true, message: 'ok', status: upToDate('qqmusic') };
  };
  await first.run();
  assert.equal(seen.install, '正在更新QQ 音乐播放器连接器');
});

test('a hot update that cannot reach the running player is rolled back once and reconnected', async () => {
  const f = maintenanceHarness({ statuses: [status('qqmusic')] });
  f.manager.onUpdate.qqmusic = disconnectingUpdate(f);
  const startedAt = f.clock.now;
  await f.run();
  assert.ok(f.clock.now - startedAt >= 30_000, 'the player gets 30 s to connect');
  assert.deepEqual(
    f.calls.filter(call => ['inspect-selected', 'rollback', 'connect-with-status', 'reconnect'].includes(call[0])),
    [['inspect-selected'], ['rollback', 'qqmusic', '正在回退QQ 音乐连接器'], ['connect-with-status'], ['reconnect']]
  );
  assert.ok(f.logs.some(log => log.color === 'Yellow' && log.message
    === '[连接器热更新] QQ 音乐 新版本 1.0.2 无法连接播放器，已回退到 1.0.1 并暂停该版本的自动更新'));
  assert.equal(f.context.connectorMaintenanceStatus, '');
  assert.equal(f.context.connectorMaintenanceFailures.size, 0, 'the install itself succeeded');

  // The same version is never rolled back twice in one process.
  const rollbacks = () => f.calls.filter(call => call[0] === 'rollback').length;
  await f.context.rollBackUnconnectableConnectorUpdate(
    status('qqmusic'), await disconnectingUpdate(f)()
  );
  assert.equal(rollbacks(), 1);

  // A reconnect started during the rollback finishes first; only a player
  // that is still disconnected afterwards is reconnected again.
  for (const connects of [true, false]) {
    const racing = maintenanceHarness({ statuses: [status('qqmusic')] });
    racing.manager.onUpdate.qqmusic = disconnectingUpdate(racing);
    racing.manager.rollbackConnector = async () => {
      racing.context.connectorConnectionRecoveryInFlight = (async () => {
        await settle(1);
        racing.context.isPlayerConnected = connects;
        racing.context.connectorConnectionRecoveryInFlight = null;
        return connects;
      })();
      return racing.context.rollbackResult;
    };
    await racing.run();
    assert.equal(racing.calls.filter(call => call[0] === 'reconnect').length, connects ? 0 : 1, String(connects));
  }

  // A failed rollback still reconnects, since the connector was stopped.
  const failed = maintenanceHarness({ statuses: [status('qqmusic')] });
  failed.manager.onUpdate.qqmusic = disconnectingUpdate(failed);
  failed.context.rollbackResult = { success: false, message: '另一项更新正在进行，请完成后重试' };
  await failed.run();
  assert.deepEqual(failed.calls.filter(call => call[0] === 'reconnect'), [['reconnect']]);
  assert.ok(failed.logs.some(log => log.color === 'Red'
    && log.message.includes('回退未完成：另一项更新正在进行')));
});

test('no rollback without proof that the new connector cannot reach a running player', async () => {
  const cases = {
    'the update reconnected': f => {
      f.manager.onUpdate.qqmusic = async () => ({
        success: true, updated: true, reconnected: true, message: 'ok', status: upToDate('qqmusic')
      });
    },
    'the player connects during the wait': f => {
      f.manager.onUpdate.qqmusic = disconnectingUpdate(f);
      let sleeps = 0;
      f.hooks.onSleep = () => { if (++sleeps === 4) f.context.isPlayerConnected = true; };
    },
    'the player was closed': f => {
      f.manager.onUpdate.qqmusic = disconnectingUpdate(f);
      f.context.playerProcess = { running: false, querySucceeded: true };
    },
    'the process query failed': f => {
      f.manager.onUpdate.qqmusic = disconnectingUpdate(f);
      f.context.playerProcess = { running: false, querySucceeded: false };
    },
    'the player was not connected before the update': f => {
      f.context.isPlayerConnected = false;
      f.manager.onUpdate.qqmusic = disconnectingUpdate(f);
    },
    'the user switched players during the wait': f => {
      f.manager.onUpdate.qqmusic = disconnectingUpdate(f);
      f.hooks.onSleep = () => { f.context.selected = 'kugou'; };
    },
    'the update failed': f => {
      f.manager.onUpdate.qqmusic = async () => {
        f.context.isPlayerConnected = false;
        return { success: false, updated: false, message: '安装失败：校验失败', status: status('qqmusic') };
      };
    }
  };
  for (const [name, arrange] of Object.entries(cases)) {
    const f = maintenanceHarness({ statuses: [status('qqmusic')] });
    arrange(f);
    await f.run();
    assert.deepEqual(f.calls.filter(call => call[0] === 'rollback' || call[0] === 'reconnect'), [], name);
  }

  // NetEase may already hold the new bridge, so it only gets a hint.
  const netease = maintenanceHarness({ selected: 'netease', statuses: [status('netease')] });
  netease.manager.onUpdate.netease = disconnectingUpdate(netease, 'netease');
  await netease.run();
  assert.deepEqual(netease.calls.filter(call => call[0] === 'rollback' || call[0] === 'reconnect'), []);
  assert.ok(netease.messages().some(message =>
    message.startsWith('[连接器热更新] 网易云音乐 新版本 1.0.2 无法连接播放器。')
    && message.includes('不会自动回退')));
});

test('early retries and resume checks keep one pending timer and respect isolation', async () => {
  const f = maintenanceHarness({ statuses: [upToDate('qqmusic')] });
  f.context.scheduleConnectorMaintenanceRetry(180_000);
  f.context.scheduleConnectorMaintenanceRetry(300_000);
  assert.deepEqual(f.timers.map(timer => timer.delay), [300_000]);
  f.context.scheduleConnectorMaintenanceRetry(null);
  assert.equal(f.timers.length, 0);

  f.context.scheduleConnectorMaintenanceAfterResume();
  f.context.scheduleConnectorMaintenanceAfterResume();
  assert.deepEqual(f.timers.map(timer => timer.delay), [60_000]);
  f.fire(f.timers[0]);
  await settle();
  assert.deepEqual(f.calls.filter(call => call[0] === 'statuses'), [['statuses', true]]);

  f.context.applicationQuitRequested = true;
  f.context.scheduleConnectorMaintenanceRetry(180_000);
  assert.equal(f.timers.length, 0);

  const isolated = maintenanceHarness({ statuses: [status('qqmusic')], isolated: true });
  await isolated.run();
  isolated.context.scheduleConnectorMaintenanceAfterResume();
  isolated.context.scheduleQqCompatibilityRecovery();
  assert.deepEqual(isolated.calls, []);
  assert.equal(isolated.timers.length, 0);
});

test('an unsupported QQ build tries new profiles, then the exact-build repair, then a patch, per session', async () => {
  const notice = { kind: 'compatibility', processId: 7, currentVersion: '22.76.5000.1' };
  const f = maintenanceHarness({ statuses: [upToDate('qqmusic')] });
  f.context.playerControlNotice = notice;
  f.context.scheduleQqCompatibilityRecovery();
  f.context.scheduleQqCompatibilityRecovery();
  assert.deepEqual(f.timers.map(timer => timer.delay), [5_000], 'debounced');
  f.fire(f.timers[0]);
  await settle(10);
  assert.deepEqual(
    f.calls.filter(call => call[0] !== 'inspect').map(call => call.slice(0, 2)),
    [['profiles', 'qqmusic'], ['auto-repair', 'qqmusic'], ['statuses', true]]
  );
  assert.equal(f.calls.find(call => call[0] === 'auto-repair')[2], false, 'the first attempt may show its status');
  assert.deepEqual(f.timers.map(timer => timer.delay), [120_000], 'nothing changed: one more look later');

  await f.context.recoverQqCompatibility();
  assert.equal(f.calls.filter(call => call[0] === 'profiles').length, 1, 'not again before that attempt is due');

  // Newer profiles are applied with a reconnect and need no connector change.
  f.context.playerControlNotice = { ...notice, currentVersion: '22.76.6000.1' };
  f.context.profileResult = { changed: true, version: '2026.10.2' };
  await f.context.recoverQqCompatibility();
  assert.deepEqual(f.calls.slice(-3).map(call => call[0]), ['profiles', 'connect-with-status', 'reconnect']);
  assert.equal(f.calls.filter(call => call[0] === 'auto-repair').length, 1);

  // While another update owns the connector, the attempt is postponed.
  f.timers.length = 0;
  f.context.playerControlNotice = { ...notice, processId: 8 };
  f.context.updateInstallationGuard.componentId = 'kugou';
  await f.context.recoverQqCompatibility();
  assert.deepEqual(f.timers.map(timer => timer.delay), [60_000]);
  assert.equal(f.context.qqCompatibilityRecoveryAttempts.has('8@22.76.5000.1'), false);
  f.context.updateInstallationGuard.componentId = null;
  await f.context.recoverQqCompatibility();
  assert.equal(f.context.qqCompatibilityRecoveryAttempts.has('8@22.76.5000.1'), true);

  // Nothing happens for another player or once QQ supports the build again.
  const calls = f.calls.length;
  f.context.playerControlNotice = { ...notice, processId: 9 };
  f.context.selected = 'netease';
  await f.context.recoverQqCompatibility();
  f.context.selected = 'qqmusic';
  f.context.playerControlNotice = null;
  await f.context.recoverQqCompatibility();
  assert.equal(f.calls.length, calls);
});

test('a QQ recovery that changed nothing, e.g. offline, runs again after 2 and 10 minutes, three times at most', async () => {
  const notice = { kind: 'compatibility', processId: 7, currentVersion: '22.76.5000.1' };
  const f = maintenanceHarness({ statuses: [upToDate('qqmusic')] });
  f.context.playerControlNotice = notice;
  let offline = true;
  // Offline, the profile check reports no change, or fails outright.
  f.manager.refreshConnectorProfiles = async id => {
    f.calls.push(['profiles', id]);
    if (offline) throw new Error('fetch failed');
    return { changed: false, version: null };
  };
  const profileChecks = () => f.calls.filter(call => call[0] === 'profiles').length;
  f.context.scheduleQqCompatibilityRecovery();
  f.fire(f.timers[0]);
  await settle(10);
  assert.equal(profileChecks(), 1);
  assert.ok(f.messages().includes('[连接器兼容恢复] QQ 音乐兼容恢复失败：fetch failed'));
  assert.ok(f.messages().includes('[连接器兼容恢复] QQ 音乐 22.76.5000.1 仍未恢复点歌插入，2 分钟后再检查一次'));
  assert.deepEqual(f.timers.map(timer => timer.delay), [120_000]);

  // A reconnect of the same session asks early; the retry keeps its time.
  f.clock.now += 30_000;
  f.context.scheduleQqCompatibilityRecovery();
  assert.deepEqual(f.timers.map(timer => timer.delay), [5_000]);
  f.fire(f.timers[0]);
  await settle(10);
  assert.equal(profileChecks(), 1);
  assert.deepEqual(f.timers.map(timer => timer.delay), [90_000]);

  // Another update owning the connector postpones the attempt without using it up.
  f.clock.now += 90_000;
  f.context.updateInstallationGuard.componentId = 'kugou';
  f.fire(f.timers[0]);
  await settle(10);
  assert.equal(profileChecks(), 1);
  assert.deepEqual(f.timers.map(timer => timer.delay), [60_000]);
  f.context.updateInstallationGuard.componentId = null;
  offline = false;
  f.fire(f.timers[0]);
  await settle(10);
  assert.equal(profileChecks(), 2);
  assert.ok(f.messages().some(message => message.endsWith('正在检查在线兼容画像（第 2 次）')));
  assert.deepEqual(f.timers.map(timer => timer.delay), [600_000]);

  f.clock.now += 600_000;
  f.fire(f.timers[0]);
  await settle(10);
  assert.equal(profileChecks(), 3);
  assert.deepEqual(f.timers, [], 'three attempts per QQ process and version');
  f.context.scheduleQqCompatibilityRecovery();
  f.fire(f.timers[0]);
  await settle(10);
  assert.equal(profileChecks(), 3);
  assert.deepEqual({ ...f.context.qqCompatibilityRecoveryAttempts.get('7@22.76.5000.1') }, { count: 3, retryAt: null });
  // The first attempt failed before the repair; both retries ask for it quietly.
  assert.deepEqual(f.calls.filter(call => call[0] === 'auto-repair').map(call => call[2]), [true, true]);
});

test('a QQ recovery is not repeated after a fix, or once the session is gone', async () => {
  const notice = { kind: 'compatibility', processId: 7, currentVersion: '22.76.5000.1' };
  for (const [label, prepare] of [
    ['new profiles', f => { f.context.profileResult = { changed: true, version: '2026.10.2' }; }],
    ['exact-build repair', f => { f.context.autoRepairResult = true; }],
    ['QQ recovered', f => {
      f.manager.refreshConnectorProfiles = async () => {
        f.context.playerControlNotice = null;
        return { changed: false, version: null };
      };
    }],
    ['QQ restarted', f => {
      f.context.runConnectorAutoRepair = async () => {
        f.context.playerControlNotice = { ...notice, processId: 8 };
        return false;
      };
    }],
    ['another player', f => {
      f.context.runConnectorAutoRepair = async () => {
        f.context.selected = 'netease';
        return false;
      };
    }]
  ]) {
    const f = maintenanceHarness({ statuses: [upToDate('qqmusic')] });
    f.context.playerControlNotice = notice;
    prepare(f);
    f.context.scheduleQqCompatibilityRecovery();
    f.fire(f.timers[0]);
    await settle(10);
    assert.deepEqual(f.timers, [], label);
    assert.equal(f.context.qqCompatibilityRecoveryAttempts.get('7@22.76.5000.1').retryAt, null, label);
  }
});

test('a quiet QQ retry skips a player session the repair already tried, without a catalog check or status', async () => {
  const versionPolicy = compile('../electron/connector-version-policy.ts', {});
  const autoRepair = compile('../electron/connector-auto-repair-policy.ts', {
    './connector-version-policy': versionPolicy
  });
  const calls = [];
  const statuses = [];
  const context = vm.createContext({
    shouldRunAutomaticConnectorMaintenance: () => true,
    devUserDataDir: null,
    connectorAutoRepairInFlight: null,
    connectorAutoRepairAttemptKey: '',
    CONNECTOR_AUTO_REPAIR_MESSAGES: autoRepair.CONNECTOR_AUTO_REPAIR_MESSAGES,
    planConnectorAutoRepair: autoRepair.planConnectorAutoRepair,
    PLAYER_LABELS: playerTypes.PLAYER_LABELS,
    setGlobalStatus: message => statuses.push(message),
    writeLog() {},
    claimConnectorMaintenanceStatus: () => 1,
    releaseConnectorMaintenanceStatus() {},
    withPlayerConnectionRecoverySuppressed: operation => operation(),
    playerManager: {
      async inspectSelectedPlayerProcess() {
        calls.push('inspect');
        return { running: true, querySucceeded: true, processId: 7, version: '22.76.5000.1' };
      },
      async getConnectorStatuses() {
        calls.push('statuses');
        return [status('qqmusic', { error: '连接更新服务器超时' })];
      },
      async updateConnector() {
        calls.push('update');
        return { success: false };
      }
    }
  });
  vm.runInContext(mainFunctions(['runConnectorAutoRepair', 'getConnectorAutoRepairAttemptKey']), context);
  const failed = autoRepair.CONNECTOR_AUTO_REPAIR_MESSAGES.failed;

  // The first attempt marks the player session and shows its outcome.
  assert.equal(await context.runConnectorAutoRepair('qqmusic'), false);
  assert.deepEqual(calls, ['inspect', 'statuses']);
  assert.deepEqual(statuses, [failed]);
  // A quiet retry of the same session stops after the process check.
  assert.equal(await context.runConnectorAutoRepair('qqmusic', { quiet: true }), false);
  assert.deepEqual(calls, ['inspect', 'statuses', 'inspect']);
  assert.deepEqual(statuses, [failed]);
  // Other callers keep the previous behaviour.
  assert.equal(await context.runConnectorAutoRepair('qqmusic'), false);
  assert.deepEqual(statuses, [failed, failed]);
  // A quiet attempt of a new session still runs, but keeps the status line clear.
  context.connectorAutoRepairAttemptKey = '';
  assert.equal(await context.runConnectorAutoRepair('qqmusic', { quiet: true }), false);
  assert.equal(calls.filter(call => call === 'statuses').length, 3);
  assert.deepEqual(statuses, [failed, failed]);
  assert.equal(calls.includes('update'), false);
});

test('background updates are automatic and leave the reconnect to idle playback', async () => {
  const f = maintenanceHarness({ statuses: [status('qqmusic'), status('kugou')] });
  await f.run();
  assert.deepEqual(
    f.manager.updateOptions.map(({ id, allowPlayerVersionChange, options }) => [id, allowPlayerVersionChange, options.automatic]),
    [['qqmusic', false, true], ['kugou', false, true]]
  );
  const { deferReconnectWhile } = f.manager.updateOptions[0].options;
  assert.equal(deferReconnectWhile, f.context.isSelectedConnectorBusy);
  assert.equal(deferReconnectWhile(), false);
  f.context.targetQueue = [{ SongName: '点歌' }];
  assert.equal(deferReconnectWhile(), true, 'asked when the install has finished');
});

test('an automatic NetEase update stopped because NetEase was opened is no failure and waits for it to close', async () => {
  const f = maintenanceHarness({ selected: 'netease', statuses: [status('netease')] });
  f.manager.onUpdate.netease = async () => {
    // Planning saw NetEase closed; it was opened during the download.
    f.context.neteaseProcess = { running: true, querySucceeded: true };
    return {
      success: false, updated: false, deferred: true,
      message: '网易云正在运行，连接器更新将在网易云关闭后自动应用',
      status: status('netease')
    };
  };
  const neteaseLines = () => f.logs.filter(log => log.message.includes('网易云正在运行'));
  await f.run();
  assert.deepEqual(f.updates(), ['netease']);
  assert.equal(f.context.connectorMaintenanceFailures.size, 0, 'no failure backoff');
  assert.ok(!f.messages().some(message => message.includes('后再次尝试自动更新')));
  assert.deepEqual(neteaseLines(), [{
    message: '[连接器热更新] 网易云音乐连接器有更新 1.0.2；网易云正在运行，连接器更新将在网易云关闭后或下次启动时应用',
    color: 'DarkGray'
  }]);
  assert.deepEqual(f.timers.map(timer => timer.delay), [300_000]);
  assert.equal(f.context.connectorMaintenanceStatus, '');

  // NetEase is still open at the retry: the planned skip says nothing new.
  await f.run();
  assert.deepEqual(f.updates(), ['netease']);
  assert.equal(neteaseLines().length, 1);
  assert.deepEqual(f.timers.map(timer => timer.delay), [300_000]);

  // Once NetEase is closed the update is applied.
  f.context.neteaseProcess = { running: false, querySucceeded: true };
  delete f.manager.onUpdate.netease;
  await f.run();
  assert.deepEqual(f.updates(), ['netease', 'netease']);
  assert.equal(f.timers.length, 0);
});

/** An update of the selected connector installed while requested playback is busy. */
function deferringUpdate(f, id = 'qqmusic') {
  return async options => {
    f.context.targetQueue = [{ SongName: '点歌' }];
    assert.equal(options.deferReconnectWhile(), true);
    f.manager.deferredConnectorRestart = id;
    f.manager.statuses = f.manager.statuses.map(item => item.id === id ? upToDate(id) : item);
    return {
      success: true, updated: true, reconnectDeferred: true,
      message: `${NAMES[id]}连接器已更新到 1.0.2，为避免打断当前播放，将在空闲时重新连接播放器以启用新版本`,
      status: upToDate(id)
    };
  };
}

test('an update installed during requested playback starts once playback is idle and is then checked', async () => {
  const f = maintenanceHarness({ statuses: [status('qqmusic')] });
  f.manager.onUpdate.qqmusic = deferringUpdate(f);
  f.manager.restartReconnects = false;
  await f.run();
  assert.equal(f.context.connectorMaintenanceFailures.size, 0, 'a deferred reconnect is a success');
  assert.ok(f.logs.some(log => log.color === 'Green' && log.message
    === '[连接器热更新] QQ 音乐连接器已更新到 1.0.2，为避免打断当前播放，将在空闲时重新连接播放器以启用新版本'));
  assert.deepEqual(f.calls.filter(call => ['apply-restart', 'inspect-selected', 'rollback'].includes(call[0])), [],
    'nothing is checked while the previous version still runs');
  assert.deepEqual(f.timers.map(timer => timer.delay), [180_000]);

  // Still busy at the next look: nothing restarts, and it looks again later.
  f.fire(f.timers[0]);
  await f.context.applyDeferredConnectorUpdate();
  assert.deepEqual(f.calls.filter(call => call[0] === 'apply-restart'), []);
  assert.deepEqual(f.timers.map(timer => timer.delay), [180_000]);

  // Idle: the new version starts under a maintenance status. It cannot reach
  // the running player, so it gets the check of an immediate reconnect.
  f.context.targetQueue = [];
  f.fire(f.timers[0]);
  await f.context.applyDeferredConnectorUpdate();
  await settle();
  assert.deepEqual(
    f.calls.filter(call => ['apply-restart', 'inspect-selected', 'rollback', 'reconnect'].includes(call[0])),
    [
      ['apply-restart', '正在应用QQ 音乐连接器更新'], ['inspect-selected'],
      ['rollback', 'qqmusic', '正在回退QQ 音乐连接器'], ['reconnect']
    ]
  );
  assert.ok(f.messages().includes('[连接器热更新] 已启用QQ 音乐连接器的新版本，后台正在等待播放器连接'));
  assert.deepEqual(f.announcements.rolledBack, [['qqmusic', '1.0.2', '1.0.1']]);
  assert.equal(f.context.connectorMaintenanceStatus, '');
  assert.equal(f.context.deferredConnectorUpdate, null);
  assert.equal(f.timers.length, 0);
});

test('a deferred restart is applied at the start of a maintenance run, and only when it is still pending', async () => {
  const f = maintenanceHarness({ statuses: [status('qqmusic')] });
  f.manager.onUpdate.qqmusic = deferringUpdate(f);
  await f.run();
  f.context.targetQueue = [];
  // The next maintenance run starts the new version before it checks the catalog.
  const before = f.calls.length;
  await f.run();
  assert.deepEqual(f.calls.slice(before, before + 2).map(call => call[0]), ['apply-restart', 'statuses']);
  assert.ok(f.messages().includes('[连接器热更新] 已启用QQ 音乐连接器的新版本并重新连接播放器'));
  assert.deepEqual(f.calls.filter(call => call[0] === 'rollback' || call[0] === 'inspect-selected'), []);
  assert.equal(f.timers.length, 0);

  // A reconnect, player switch or connector exit has already started it.
  const g = maintenanceHarness({ statuses: [status('qqmusic')] });
  g.manager.onUpdate.qqmusic = deferringUpdate(g);
  await g.run();
  g.manager.deferredConnectorRestart = null;
  g.fire(g.timers[0]);
  await g.context.applyDeferredConnectorUpdate();
  assert.deepEqual(g.calls.filter(call => call[0] === 'apply-restart'), []);
  assert.equal(g.context.deferredConnectorUpdate, null);
  assert.equal(g.timers.length, 0);

  // Playback starts again between the check and the restart: the manager
  // keeps the previous version, and the next look is scheduled.
  const h = maintenanceHarness({ statuses: [status('qqmusic')] });
  h.manager.onUpdate.qqmusic = deferringUpdate(h);
  await h.run();
  h.context.targetQueue = [];
  const restart = h.manager.applyDeferredConnectorRestart.bind(h.manager);
  h.manager.applyDeferredConnectorRestart = async deferWhile => {
    h.context.currentPlayingSong = { SongName: '点歌' };
    return restart(deferWhile);
  };
  h.fire(h.timers[0]);
  await h.context.applyDeferredConnectorUpdate();
  assert.equal(h.manager.deferredConnectorRestart, 'qqmusic');
  assert.notEqual(h.context.deferredConnectorUpdate, null, 'kept for the check after the restart');
  assert.deepEqual(h.timers.map(timer => timer.delay), [180_000]);

  // A restart whose player was not connected right before it proves nothing.
  const i = maintenanceHarness({ statuses: [status('qqmusic')] });
  i.manager.onUpdate.qqmusic = deferringUpdate(i);
  i.manager.restartReconnects = false;
  await i.run();
  Object.assign(i.context, { targetQueue: [], isPlayerConnected: false });
  i.fire(i.timers[0]);
  await i.context.applyDeferredConnectorUpdate();
  assert.equal(i.calls.filter(call => call[0] === 'apply-restart').length, 1);
  assert.deepEqual(i.calls.filter(call => call[0] === 'rollback' || call[0] === 'inspect-selected'), []);
});

test('a failed note about the rollback is logged and the rollback still reconnects', async () => {
  const f = maintenanceHarness({ statuses: [status('qqmusic')] });
  f.manager.onUpdate.qqmusic = disconnectingUpdate(f);
  f.announcements.failure = 'EPERM: operation not permitted';
  await f.run();
  await settle();
  assert.deepEqual(f.announcements.rolledBack, [['qqmusic', '1.0.2', '1.0.1']]);
  assert.ok(f.logs.some(log => log.color === 'Yellow'
    && log.message === '[连接器热更新] QQ 音乐连接器回退后未能更新升级记录：EPERM: operation not permitted'));
  assert.deepEqual(f.calls.filter(call => call[0] === 'reconnect'), [['reconnect']]);

  // A failed rollback restores nothing, so there is nothing to note.
  const failed = maintenanceHarness({ statuses: [status('qqmusic')] });
  failed.manager.onUpdate.qqmusic = disconnectingUpdate(failed);
  failed.context.rollbackResult = { success: false, message: '另一项更新正在进行，请完成后重试' };
  await failed.run();
  assert.deepEqual(failed.announcements.rolledBack, []);
});

test('only background maintenance asks for an automatic update', () => {
  assert.equal((mainSource.match(/automatic: true/g) || []).length, 1);
  assert.match(
    sliceBetween(mainSource, 'async function applyConnectorMaintenanceUpdate', 'function scheduleDeferredConnectorRestart'),
    /playerManager\.updateConnector\(status\.id, false, \{\s*automatic: true,\s*deferReconnectWhile: isSelectedConnectorBusy\s*\}\)/
  );
  // The user's update, the diagnostic repair and the connection repair keep
  // closing and restarting NetEase as before.
  assert.match(
    sliceBetween(mainSource, "url.pathname === '/api/connectors/update'", 'if (url.pathname ==='),
    /playerManager\.updateConnector\(connectorId, true\)/
  );
  assert.match(
    sliceBetween(mainSource, 'async function repairDiagnosticAction', 'async function runDiagnostics'),
    /playerManager\.updateConnector\(playerKey, false\)/
  );
  assert.match(
    sliceBetween(mainSource, 'async function runConnectorAutoRepair', 'async function connectWithConnectorMaintenanceStatus'),
    /playerManager\.updateConnector\(\s*connectorId,\s*plan\.allowPlayerVersionChange\s*\)/
  );
});

test('a newly detected unsupported QQ build schedules recovery from the player state callback', () => {
  let callback = null;
  const visit = node => {
    if (callback) return;
    if (ts.isVariableDeclaration(node) && node.name.getText(mainAst) === 'playerManager'
        && node.initializer && ts.isNewExpression(node.initializer)) {
      const property = node.initializer.arguments[0].properties
        .find(item => item.name?.getText(mainAst) === 'onStateChanged');
      callback = property.initializer.getText(mainAst);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(mainAst);
  assert.ok(callback, 'onStateChanged');
  const javascript = mainFunctions(['holdUnsupportedQqQueue'], `globalThis.onStateChanged = ${callback};`);
  let scheduled = 0;
  let selected = 'qqmusic';
  const context = vm.createContext({
    ...compatibility,
    isPlayerConnected: false, playerConnecting: false, activePlayerSnapshot: null,
    playerControlNotice: null, qqAutoplayGeneration: 0,
    getSelectedPlayerKey: () => selected, setGlobalStatus() {}, writeLog() {},
    clearDeferredQqInsert() {}, clearRecentQqGuardedCompletion() {}, clearRegisteredNextGuard() {},
    clearSkipForcePlayOnce() {}, queueHeadNeedsGuardOnlyAfterCurrentChange: false,
    activeManagedPlayerAction: null, cancelledNativeNextSongs: new Map(),
    applicationQuitRequested: false, playerConnectionRecoverySuppressed: 0,
    playerConnectionRecoverySuppressionEpoch: 0, queueMicrotask() {},
    recoverPlayerConnectionAfterFailure: async () => {},
    scheduleQqCompatibilityRecovery: () => { scheduled++; }
  });
  vm.runInContext(javascript, context);
  const snapshot = (supported, extra = {}) => ({
    connected: true, player: 'QQ 音乐', processId: 7, version: '22.76', status: 'connected',
    observedAt: '2026-10-21T00:00:00Z',
    capabilities: { search: true, playSelected: supported, insertNext: supported },
    compatibilityFailureCode: supported ? null : 'player-version-unsupported', ...extra
  });
  const change = value => context.onStateChanged({ connected: value?.connected === true, connecting: false, snapshot: value });

  change(snapshot(false));
  assert.equal(scheduled, 1);
  change(snapshot(false));
  change(snapshot(false));
  assert.equal(scheduled, 1, 'the same unsupported session is scheduled once');
  change(snapshot(false, { version: '22.77' }));
  assert.equal(scheduled, 2, 'a QQ update is a new session');
  change(snapshot(true, { version: '22.77' }));
  assert.equal(context.playerControlNotice, null);
  change(null);
  change(snapshot(false, { version: '22.77' }));
  assert.equal(scheduled, 3, 'the recovery dedupes a reconnect of the same session');

  selected = 'netease';
  change(snapshot(false, { version: '22.78' }));
  assert.equal(scheduled, 3, 'other players never schedule it');
});

test('only a user-initiated connector update may open the control panel', async () => {
  const javascript = mainFunctions(['handleCompletedConnectorUpdate']);
  const forbidden = name => () => { throw new Error(`a receipt must not call ${name}`); };
  const fakeWindow = (focused = false) => {
    const flashes = [];
    return {
      flashes,
      isDestroyed: () => false,
      isFocused: () => focused,
      flashFrame: flag => flashes.push(flag),
      show: forbidden('show'), focus: forbidden('focus'), moveTop: forbidden('moveTop'),
      restore: forbidden('restore'), setAlwaysOnTop: forbidden('setAlwaysOnTop'),
      webContents: { send: forbidden('webContents.send') }
    };
  };
  const run = async ({ userInitiated = false, panel = null, receipt = { id: 'r' }, started = true } = {}) => {
    const created = [];
    const installed = [];
    const context = vm.createContext({
      getUpdateAnnouncementService: () => ({ noteInstalled: (id, version) => installed.push([id, version]) }),
      updateReceiptStore: { recordConnectorUpdate: async () => receipt },
      applicationQuitRequested: false,
      startupBackgroundServicesStarted: started,
      adminWindow: panel,
      userInitiatedConnectorUpdates: new Set(userInitiated ? ['qqmusic'] : []),
      createAdminWindow: tab => created.push(tab)
    });
    vm.runInContext(javascript, context);
    await context.handleCompletedConnectorUpdate('qqmusic', 'QQ 音乐连接器', '22.61.1', '22.61.2');
    assert.deepEqual(installed, [['qqmusic', '22.61.2']]);
    return created;
  };

  assert.deepEqual(await run({ userInitiated: true }), ['updates']);
  const userPanel = fakeWindow();
  assert.deepEqual(await run({ userInitiated: true, panel: userPanel }), [],
    'an open panel shows the receipt on the current tab');
  assert.deepEqual(userPanel.flashes, []);

  const background = fakeWindow(false);
  assert.deepEqual(await run({ panel: background }), []);
  assert.deepEqual(background.flashes, [true], 'an unfocused panel only flashes');
  const focused = fakeWindow(true);
  assert.deepEqual(await run({ panel: focused }), []);
  assert.deepEqual(focused.flashes, []);
  assert.deepEqual(await run(), [], 'a background receipt waits until the panel is opened');
  assert.deepEqual(await run({ userInitiated: true, receipt: null }), [], 'no upgrade, no window');
  assert.deepEqual(await run({ userInitiated: true, started: false }), [], 'startup shows its own check');
});

test('a diagnostic connector repair counts as user-initiated for its duration', async () => {
  const javascript = mainFunctions(['repairDiagnosticAction', 'isDiagnosticRoomCurrent', 'diagnosticError']);
  const marked = [];
  let fail = false;
  const context = vm.createContext({
    getSelectedPlayerKey: () => 'qqmusic',
    biliRoomState: { requestedRoomId: 42, realRoomId: 42, status: 'connected' },
    appConfig: { roomId: 42, roomConnectionEnabled: true },
    updateInstallationGuard: { componentId: null }, connectorMaintenanceRunning: false,
    connectorAutoRepairInFlight: null, connectorConnectionRecoveryInFlight: null,
    sanitizeFeedbackLog: value => String(value),
    withPlayerConnectionRecoverySuppressed: operation => operation(),
    userInitiatedConnectorUpdates: new Set(),
    playerManager: {
      connectionState: { connected: true, connecting: false },
      getConnectorStatuses: async () => [status('qqmusic')],
      async updateConnector(id, allowPlayerVersionChange) {
        marked.push([id, allowPlayerVersionChange, context.userInitiatedConnectorUpdates.has(id)]);
        if (fail) throw new Error('下载失败');
        return { success: true, message: 'QQ 音乐连接器已更新到 1.0.2' };
      }
    }
  });
  vm.runInContext(javascript, context);
  assert.equal((await context.repairDiagnosticAction('update-connector', 'qqmusic', 42)).success, true);
  fail = true;
  await assert.rejects(context.repairDiagnosticAction('update-connector', 'qqmusic', 42), /下载失败/);
  assert.deepEqual(marked, [['qqmusic', false, true], ['qqmusic', false, true]]);
  assert.equal(context.userInitiatedConnectorUpdates.size, 0);
});

function sliceBetween(text, start, end) {
  const begin = text.indexOf(start);
  assert.ok(begin !== -1, start);
  const finish = text.indexOf(end, begin + start.length);
  assert.ok(finish > begin, end);
  return text.slice(begin, finish);
}

test('manual connector routes are user-initiated and hold a status for their whole duration', () => {
  for (const [route, call] of [
    ['/api/connectors/update', 'playerManager.updateConnector(connectorId, true)'],
    ['/api/connectors/reinstall', 'playerManager.reinstallConnector(connectorId)']
  ]) {
    const block = sliceBetween(mainSource, `url.pathname === '${route}'`, 'if (url.pathname ===');
    const invoked = block.indexOf(call);
    assert.ok(invoked > 0, call);
    assert.ok(block.indexOf('claimConnectorMaintenanceStatus(') < invoked, route);
    assert.ok(block.indexOf('userInitiatedConnectorUpdates.add(connectorId)') < invoked, route);
    assert.match(block, /finally \{\s*userInitiatedConnectorUpdates\.delete\(connectorId\);\s*releaseConnectorMaintenanceStatus\(statusOwner\);\s*\}/);
    assert.doesNotMatch(block, /setGlobalStatus\(`正在/, 'no 4 s status for a long update');
  }
  assert.match(mainSource, /setConnectorUpdateListener\(handleCompletedConnectorUpdate\);/);
  assert.match(mainSource, /powerMonitor\.on\('resume', scheduleConnectorMaintenanceAfterResume\);/);
  const quit = sliceBetween(mainSource, "app.on('before-quit'", "app.on('window-all-closed'");
  for (const timer of [
    'connectorMaintenanceRetryTimer', 'connectorMaintenanceResumeTimer', 'qqCompatibilityRecoveryTimer',
    'deferredConnectorRestartTimer'
  ]) {
    assert.match(quit, new RegExp(`clearTimeout\\(${timer}\\);\\s*${timer} = null;`), timer);
  }
});

// ---------------------------------------------------------------------------
// Player manager and bridge passthroughs
// ---------------------------------------------------------------------------

function compile(relative, imports, globals = {}) {
  const source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, {
    module,
    exports: module.exports,
    require(name) {
      assert.ok(Object.hasOwn(imports, name), `Unexpected dependency: ${name}`);
      return imports[name];
    },
    ...globals
  });
  return module.exports;
}

test('the bridge stops the replaced connector before a rollback and refreshes only QQ profiles', async () => {
  const order = [];
  class FakeUpdater {
    async rollbackToPrevious(id) {
      order.push(['rollback', id]);
      return { success: true, version: '1.0.1', message: '已回退' };
    }
    async refreshQQMusicProfiles() {
      order.push(['profiles']);
      return { changed: true, version: '2026.10.2' };
    }
  }
  const { PlayerBridgeClient } = compile('../electron/player-bridge-client.ts', {
    child_process: { spawn: () => assert.fail('no connector may be spawned') },
    fs: { __esModule: true, default: { existsSync: () => true }, existsSync: () => true },
    './connector-updater': { ConnectorUpdater: FakeUpdater },
    './connector-lifecycle-gate': lifecycleGate,
    './jsonl-line-buffer': jsonlLineBuffer,
    './qq-native-compatibility-policy': compatibility
  }, { process: { env: {} }, setTimeout, clearTimeout });
  const bridge = new PlayerBridgeClient(() => {}, () => '', () => {});
  bridge.stop = async () => { order.push(['stop']); };

  bridge.activePlayer = 'qqmusic';
  assert.equal((await bridge.rollbackConnector('qqmusic')).version, '1.0.1');
  assert.deepEqual(order.splice(0), [['stop'], ['rollback', 'qqmusic']]);

  bridge.activePlayer = null;
  bridge.startPromise = Promise.resolve();
  await bridge.rollbackConnector('qqmusic');
  assert.deepEqual(order.splice(0), [['stop'], ['rollback', 'qqmusic']], 'a start in flight is cancelled');

  bridge.activePlayer = 'netease';
  bridge.startPromise = null;
  await bridge.rollbackConnector('qqmusic');
  assert.deepEqual(order.splice(0), [['rollback', 'qqmusic']], 'another player keeps running');

  assert.deepEqual({ ...await bridge.refreshConnectorProfiles('netease') }, { changed: false, version: null });
  assert.deepEqual(order, []);
  assert.deepEqual(await bridge.refreshConnectorProfiles('qqmusic'), { changed: true, version: '2026.10.2' });
  assert.deepEqual(order, [['profiles']]);
});

function managerHarness(selectedKey = 'qqmusic') {
  const intervals = new Set();
  const states = [];
  const bridge = {
    running: true,
    supportsSnapshotEvents: false,
    rollbacks: [],
    restarts: 0,
    async start() { this.running = true; },
    async restart() { this.restarts++; },
    async stop() { this.running = false; },
    async probe(key) {
      return { connected: true, player: key, version: '1', status: 'ok', observedAt: '' };
    },
    async rollbackConnector(id) {
      this.rollbacks.push(id);
      return { success: true, version: '1.0.1', message: '已回退' };
    },
    async refreshConnectorProfiles(id) {
      return { changed: id === 'qqmusic', version: '2026.10.2' };
    }
  };
  const backend = key => class {
    constructor() { Object.assign(this, { key, label: NAMES[key], usesNativeBridge: true, deactivations: 0 }); }
    async activate() { return await bridge.probe(key); }
    deactivate() { this.deactivations++; }
    async probe() { return await bridge.probe(key); }
  };
  const { PlayerManager } = compile('../electron/players/player-manager.ts', {
    '../player-bridge-client': { PlayerBridgeClient: function PlayerBridgeClient() { return bridge; } },
    '../connector-start-backoff': backoffModule,
    '../queue-head-policy': queuePolicy,
    '../qq-native-compatibility-policy': compatibility,
    '../player-process-inspector': {
      inspectPlayerProcess() { throw new Error('Pure tests must not inspect processes'); }
    },
    './folia-player': { FoliaPlayerBackend: backend('folia') },
    './kugou-player': { KugouPlayerBackend: backend('kugou') },
    './netease-player': { NeteasePlayerBackend: backend('netease') },
    './qqmusic-player': { QQMusicPlayerBackend: backend('qqmusic') },
    './types': playerTypes
  }, {
    setInterval(callback) {
      const timer = { callback };
      intervals.add(timer);
      return timer;
    },
    clearInterval(timer) { intervals.delete(timer); }
  });
  const manager = new PlayerManager({
    getSelectedKey: () => selectedKey,
    getFoliaToken: () => '',
    log() {},
    setStatus() {},
    onStateChanged: state => states.push({ ...state }),
    async onTrackChanged() {},
    async onTrackUpdated() {}
  });
  return { manager, bridge, intervals, states };
}

test('a manager rollback waits for the running command, stops polling and leaves the reconnect to the caller', async () => {
  const f = managerHarness('qqmusic');
  await f.manager.connectSelected();
  assert.equal(f.intervals.size, 1);
  const generation = f.manager.selectionGeneration;

  let releaseCommand;
  f.manager.operationTail = new Promise(resolve => { releaseCommand = resolve; });
  const rolling = f.manager.rollbackConnector('qqmusic');
  await settle();
  assert.deepEqual(f.bridge.rollbacks, [], 'a running command finishes first');
  releaseCommand();
  const result = await rolling;
  assert.equal(result.version, '1.0.1');
  assert.deepEqual(f.bridge.rollbacks, ['qqmusic']);
  assert.equal(f.intervals.size, 0, 'the old connector is no longer polled');
  assert.ok(f.manager.selectionGeneration > generation);
  assert.deepEqual(f.states.at(-1), { connected: false, connecting: true, snapshot: null });
  assert.equal(f.manager.backends.qqmusic.deactivations, 1);
  assert.equal(f.bridge.restarts, 0, 'the caller reconnects');

  // Commands queued behind the rollback run after it.
  let commandRan = false;
  f.manager.backends.qqmusic.execute = async () => {
    commandRan = true;
    return { outcome: 'verified', message: 'ok' };
  };
  await f.manager.execute('Next');
  assert.equal(commandRan, true);

  // Rolling back another connector leaves the selected one untouched.
  const other = managerHarness('qqmusic');
  await other.manager.connectSelected();
  const states = other.states.length;
  await other.manager.rollbackConnector('kugou');
  assert.deepEqual(other.bridge.rollbacks, ['kugou']);
  assert.equal(other.intervals.size, 1);
  assert.equal(other.states.length, states);

  assert.deepEqual(await other.manager.refreshConnectorProfiles('qqmusic'), { changed: true, version: '2026.10.2' });
});

test('the bridge passes the automatic flag to the updater and never stops the running connector', async () => {
  const updates = [];
  class FakeUpdater {
    async update(...args) {
      updates.push(args);
      return { success: true, updated: true, message: '网易云音乐连接器已更新到 1.0.2' };
    }
  }
  const { PlayerBridgeClient } = compile('../electron/player-bridge-client.ts', {
    child_process: { spawn: () => assert.fail('no connector may be spawned') },
    fs: { __esModule: true, default: { existsSync: () => true }, existsSync: () => true },
    './connector-updater': { ConnectorUpdater: FakeUpdater },
    './connector-lifecycle-gate': lifecycleGate,
    './jsonl-line-buffer': jsonlLineBuffer,
    './qq-native-compatibility-policy': compatibility
  }, { process: { env: {} }, setTimeout, clearTimeout });
  const bridge = new PlayerBridgeClient(() => {}, () => '', () => {});
  bridge.stop = async () => assert.fail('an update must not stop the running connector');
  await bridge.updateConnector('netease', false, { automatic: true });
  await bridge.updateConnector('qqmusic', true);
  assert.deepEqual(updates.map(([id, allow, options]) => [id, allow, { ...options }]), [
    ['netease', false, { automatic: true }],
    ['qqmusic', true, {}]
  ]);
});

/** A bridge whose updates install 1.0.2 and whose restarts and stops are recorded. */
function updatingManagerHarness(selectedKey = 'qqmusic') {
  const f = managerHarness(selectedKey);
  const order = [];
  Object.assign(f.bridge, {
    updates: [],
    async updateConnector(...args) {
      this.updates.push(args);
      return { success: true, updated: true, message: `${NAMES[args[0]]}连接器已更新到 1.0.2`, status: {} };
    },
    async stop() { order.push('stop'); this.running = false; },
    async restart(key) {
      order.push('restart');
      this.restarts++;
      this.running = false;
      await this.start(key);
    }
  });
  return { ...f, order };
}

test('a reconnect deferred after an update keeps the previous version running until it is applied', async () => {
  const f = updatingManagerHarness();
  await f.manager.connectSelected();
  const statesBefore = f.states.length;

  // The guard is asked only after the command that was running finished.
  let busy = false;
  let checks = 0;
  let releaseCommand;
  f.manager.operationTail = new Promise(resolve => { releaseCommand = resolve; });
  const updating = f.manager.updateConnector('qqmusic', false, {
    automatic: true,
    deferReconnectWhile: () => { checks++; return busy; }
  });
  await settle();
  assert.equal(checks, 0);
  busy = true; // A requested song started meanwhile.
  releaseCommand();
  const result = await updating;
  assert.equal(checks, 1);
  assert.equal(result.success, true);
  assert.equal(result.reconnectDeferred, true);
  assert.equal(result.reconnected, undefined);
  assert.match(result.message, /^QQ 音乐连接器已更新到 1\.0\.2，为避免打断当前播放/);
  assert.deepEqual(
    f.bridge.updates.map(([id, allow, options]) => [id, allow, { ...options }]),
    [['qqmusic', false, { automatic: true }]]
  );
  // Nothing stopped the old connector: its connection, poll and commands go on.
  assert.deepEqual(f.order, []);
  assert.equal(f.bridge.running, true);
  assert.equal(f.intervals.size, 1);
  assert.equal(f.states.length, statesBefore);
  assert.equal(f.manager.connectionState.connected, true);
  let commandRan = false;
  f.manager.backends.qqmusic.execute = async () => {
    commandRan = true;
    return { outcome: 'verified', message: 'ok' };
  };
  await f.manager.execute('Next');
  assert.equal(commandRan, true);
  assert.equal(f.manager.deferredConnectorRestart, 'qqmusic');

  // Still busy: the restart keeps waiting.
  assert.deepEqual({ ...await f.manager.applyDeferredConnectorRestart(() => busy) }, { restarted: false });
  assert.deepEqual(f.order, []);
  busy = false;
  assert.deepEqual(
    { ...await f.manager.applyDeferredConnectorRestart(() => busy) },
    { restarted: true, reconnected: true }
  );
  assert.deepEqual(f.order, ['restart']);
  assert.equal(f.manager.deferredConnectorRestart, null);
  assert.deepEqual({ ...await f.manager.applyDeferredConnectorRestart() }, { restarted: false });
  assert.deepEqual(f.order, ['restart'], 'applied once');

  // Without a reason to wait, the update reconnects at once as before.
  const idle = updatingManagerHarness();
  await idle.manager.connectSelected();
  const reconnected = await idle.manager.updateConnector('qqmusic', false, {
    automatic: true,
    deferReconnectWhile: () => false
  });
  assert.equal(reconnected.reconnected, true);
  assert.equal(reconnected.reconnectDeferred, undefined);
  assert.deepEqual(idle.order, ['restart']);
  assert.equal(idle.manager.deferredConnectorRestart, null);

  // A connector that is not running has no previous version to keep.
  const stopped = updatingManagerHarness();
  await stopped.manager.connectSelected();
  stopped.bridge.running = false;
  const started = await stopped.manager.updateConnector('qqmusic', false, { deferReconnectWhile: () => true });
  assert.equal(started.reconnected, true);
  assert.equal(started.reconnectDeferred, undefined);
  assert.equal(stopped.manager.deferredConnectorRestart, null);
});

test('a deferred restart is dropped once the previous version has ended anyway', async () => {
  for (const end of ['exit', 'stop', 'switch', 'reconnect']) {
    const f = updatingManagerHarness();
    let selected = 'qqmusic';
    f.manager.options.getSelectedKey = () => selected;
    await f.manager.connectSelected();
    await f.manager.updateConnector('qqmusic', false, { deferReconnectWhile: () => true });
    assert.equal(f.manager.deferredConnectorRestart, 'qqmusic', end);
    if (end === 'exit') {
      f.manager.handleBridgeEvent({
        type: 'event', event: 'connectorExit', player: 'qqmusic', sequence: 0, snapshot: null, error: 'exit'
      });
    } else if (end === 'stop') {
      await f.manager.stop();
    } else if (end === 'switch') {
      // Starting another player ends the shared connector process.
      selected = 'kugou';
      await f.manager.connectSelected();
      selected = 'qqmusic';
    } else {
      await f.manager.reconnect();
    }
    assert.equal(f.manager.deferredConnectorRestart, null, end);
    const restarts = f.bridge.restarts;
    assert.deepEqual({ ...await f.manager.applyDeferredConnectorRestart() }, { restarted: false }, end);
    assert.equal(f.bridge.restarts, restarts, end);
  }
});

test('a reinstall refused by the shared update lock restores the stopped connector and still fails', async () => {
  const f = updatingManagerHarness();
  f.bridge.reinstallConnector = async () => {
    // ConnectorUpdater.runUpdate() while another component holds the lock.
    throw new Error('另一项更新正在进行，请完成后重试');
  };
  assert.equal(await f.manager.start(), true);
  await assert.rejects(f.manager.reinstallConnector('qqmusic'), /另一项更新正在进行/);
  // Stopped for the reinstall, then started again and polled again.
  assert.deepEqual(f.order, ['stop', 'restart']);
  assert.equal(f.bridge.running, true);
  assert.equal(f.intervals.size, 1);
  const state = f.manager.connectionState;
  assert.deepEqual([state.connected, state.connecting], [true, false]);

  // A completed reinstall reconnects as before.
  f.bridge.reinstallConnector = async () => ({
    success: true, updated: true, message: 'QQ 音乐连接器 1.0.2 已重新安装', status: {}
  });
  const result = await f.manager.reinstallConnector('qqmusic');
  assert.equal(result.reconnected, true);
  assert.match(result.message, /已自动重连播放器$/);
});
