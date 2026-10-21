import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { UpdateInstallationGuard } from '../electron/update-announcements.ts';
import { extractFunctions } from './helpers/source.mjs';

const updaterSource = fs.readFileSync(
  path.resolve(import.meta.dirname, '../electron/connector-updater.ts'), 'utf8'
);
const compiled = ts.transpileModule(updaterSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;

function harness({
  installFails = false, activeVersion = '22.60.2', receiptFails = false,
  activeExecutable = undefined, installGate = undefined
} = {}) {
  const guard = new UpdateInstallationGuard();
  const calls = [];
  const quarantineClears = [];
  const exported = { exports: {} };
  vm.runInNewContext(compiled, {
    module: exported, exports: exported.exports,
    require: name => name === './update-announcements' ? {
      updateInstallationGuard: guard,
      reportCompletedConnectorUpdate: async (...args) => {
        calls.push(['receipt', ...args]);
        if (receiptFails) throw new Error('disk full');
      }
    } : name === 'node:path' ? { default: path } : {},
    Error, setTimeout
  });
  const updater = Object.create(exported.exports.ConnectorUpdater.prototype);
  Object.assign(updater, {
    updates: new Map(), catalog: { connectors: { qqmusic: { version: '22.60.2' } } },
    validatedExecutables: new Set(),
    // runUpdate() clears each install's progress, and an explicit update or
    // reinstall first clears the connector's rollback quarantine on disk.
    progress: new Map(),
    clearQuarantine: async id => { quarantineClears.push([id, guard.componentId]); },
    onLog: message => calls.push(['log', message]),
    getStatuses: async () => [{ id: 'qqmusic', name: 'QQ 音乐', currentVersion: '22.60.1',
      installed: true, compatible: true, updateAvailable: true }],
    install: async () => {
      calls.push(['install']);
      await installGate;
      if (installFails) throw new Error('signature/health/activation rejected');
    },
    readActive: async () => {
      calls.push(['readActive']);
      return { version: activeVersion, ...(activeExecutable ? { executable: activeExecutable } : {}) };
    },
    makeStatus: (_id, active) => ({ id: 'qqmusic', name: 'QQ 音乐', currentVersion: active.version })
  });
  return { updater, guard, calls, quarantineClears };
}

test('both normal and repair installation paths notify only after verified install and active version read', async () => {
  for (const method of ['update', 'reinstall']) {
    const { updater, guard, calls } = harness();
    const result = await updater[method]('qqmusic');
    assert.equal(result.success, true);
    assert.equal(result.updated, true);
    assert.deepEqual(calls.slice(0, 3), [
      ['install'], ['readActive'], ['receipt', 'qqmusic', 'QQ 音乐连接器', '22.60.1', '22.60.2']
    ]);
    assert.equal(guard.componentId, null);
  }
});

test('signature/health/activation failure never creates completion evidence and releases the lock', async () => {
  const { updater, guard, calls } = harness({ installFails: true });
  const result = await updater.update('qqmusic');
  assert.equal(result.success, false);
  assert.equal(result.updated, false);
  assert.equal(calls.some(call => call[0] === 'receipt'), false);
  assert.equal(guard.componentId, null);
});

test('missing or mismatched active version never creates an update receipt', async () => {
  const { updater, calls } = harness({ activeVersion: '22.60.1' });
  await updater.update('qqmusic');
  assert.equal(calls.some(call => call[0] === 'receipt'), false);
});

test('receipt storage failure does not disguise a successful installation as failure', async () => {
  const { updater, calls } = harness({ receiptFails: true });
  const result = await updater.update('qqmusic');
  assert.equal(result.success, true);
  assert.ok(calls.some(call => call[0] === 'log' && call[1].includes('通知保存失败')));
});

test('a core update in progress rejects connector operations before any installation work', async () => {
  const { updater, guard, calls } = harness();
  const release = guard.acquire('core');
  await assert.rejects(updater.update('qqmusic'), /另一项更新/);
  assert.deepEqual(calls, []);
  release();
  assert.equal((await updater.update('qqmusic')).success, true);
});

test('connection-path installs wait for another connector, but user actions still fail fast', async () => {
  const { updater, guard, calls } = harness();
  const releaseNetease = guard.acquire('netease');
  await assert.rejects(updater.update('qqmusic'), /另一项更新正在进行，请完成后重试/);
  await assert.rejects(updater.reinstall('qqmusic'), /另一项更新正在进行，请完成后重试/);

  const waiting = updater.runUpdateWhenAvailable('qqmusic', false, false);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(calls.some(call => call[0] === 'install'), false);
  assert.ok(calls.some(call => call[0] === 'log' && call[1].includes('网易云音乐连接器正在更新')));
  releaseNetease();
  const result = await waiting;
  assert.equal(result.success, true);
  assert.equal(calls.filter(call => call[0] === 'install').length, 1);
  assert.equal(guard.componentId, null);
});

test('connection-path installs never wait for a core update', async () => {
  const { updater, guard, calls } = harness();
  const release = guard.acquire('core');
  const started = Date.now();
  await assert.rejects(
    updater.runUpdateWhenAvailable('qqmusic', true, false),
    /另一项更新正在进行，请完成后重试/
  );
  assert.ok(Date.now() - started < 400, 'no polling while core holds the lock');
  assert.deepEqual(calls, []);
  release();
});

test('a connection-path install joins a running install of the same connector', async () => {
  let openGate;
  const installGate = new Promise(resolve => { openGate = resolve; });
  const { updater, guard, calls } = harness({ installGate });
  const running = updater.update('qqmusic');
  assert.equal(guard.componentId, 'qqmusic');
  const joined = updater.runUpdateWhenAvailable('qqmusic', false, false);
  openGate();
  const [first, second] = await Promise.all([running, joined]);
  assert.equal(first.updated, true);
  assert.equal(second.updated, false);
  assert.match(second.message, /安装任务已完成/);
  assert.equal(calls.filter(call => call[0] === 'install').length, 1);
});

test('a completed install marks its health-checked executable as validated', async () => {
  const executable = path.resolve('player-connectors', 'qqmusic', '22.60.2', 'Awoo.Connector.QQMusic.exe');
  const current = harness({ activeExecutable: executable });
  await current.updater.update('qqmusic');
  assert.deepEqual(Array.from(current.updater.validatedExecutables), [executable]);

  const mismatched = harness({ activeExecutable: executable, activeVersion: '22.60.1' });
  await mismatched.updater.update('qqmusic');
  assert.equal(mismatched.updater.validatedExecutables.size, 0);
});

test('NetEase is closed and restarted only when an active NetEase connector is replaced', async () => {
  for (const previousVersion of [null, '3.1.37.205354.8']) {
    const { updater, calls } = harness();
    const neteaseActions = [];
    let installedVersion = previousVersion;
    let receivedHook;
    Object.assign(updater, {
      catalog: { connectors: { netease: { version: '3.1.37.205354.9' } } },
      getStatuses: async () => [{ id: 'netease', name: '网易云音乐', currentVersion: previousVersion,
        installed: Boolean(previousVersion), compatible: true, updateAvailable: true }],
      readActive: async () => installedVersion ? { version: installedVersion } : null,
      // Earlier connector files on disk, which a NetEase bridge may come from.
      hasInstalledConnectorFiles: async () => Boolean(previousVersion),
      makeStatus: (_id, active) => ({ id: 'netease', name: '网易云音乐', currentVersion: active?.version }),
      neteaseProcessController: {
        stopForConnectorUpdate: async () => { neteaseActions.push('stop'); return { wasRunning: true }; },
        restartAfterConnectorUpdate: async () => { neteaseActions.push('restart'); }
      },
      install: async (_id, _entry, _force, beforeReplace) => {
        receivedHook = beforeReplace;
        await beforeReplace?.();
        installedVersion = '3.1.37.205354.9';
      }
    });
    const result = await updater.update('netease');
    assert.equal(result.success, true, String(previousVersion));
    if (previousVersion) {
      assert.equal(typeof receivedHook, 'function');
      assert.deepEqual(neteaseActions, ['stop', 'restart']);
      assert.match(result.message, /已自动重新启动网易云音乐/);
    } else {
      assert.equal(receivedHook, undefined, 'a first install never closes NetEase');
      assert.deepEqual(neteaseActions, []);
      assert.equal(result.neteasePlayerWasRunning, undefined);
    }
    assert.ok(calls.some(call => call[0] === 'receipt'));
  }
});

test('only an explicit reinstall or confirmed update lifts a rollback quarantine, under the lock', async () => {
  const { updater, guard, quarantineClears } = harness();
  await updater.update('qqmusic');
  await updater.runUpdateWhenAvailable('qqmusic', true, false);
  assert.deepEqual(quarantineClears, [], 'automatic paths keep the quarantine');

  await updater.update('qqmusic', true);
  await updater.reinstall('qqmusic');
  assert.deepEqual(quarantineClears, [['qqmusic', 'qqmusic'], ['qqmusic', 'qqmusic']]);

  const release = guard.acquire('core');
  await assert.rejects(updater.reinstall('qqmusic'), /另一项更新/);
  release();
  assert.equal(quarantineClears.length, 2, 'a refused operation changes nothing');
});

test('a quarantined latest version is never installed by an unconfirmed update', async () => {
  const quarantinedStatus = { id: 'qqmusic', name: 'QQ 音乐', currentVersion: '22.60.1',
    latestVersion: '22.60.2', installed: true, compatible: true, updateAvailable: true,
    autoUpdateAvailable: false, quarantined: true };
  const automatic = harness();
  automatic.updater.getStatuses = async () => [quarantinedStatus];
  const refused = await automatic.updater.update('qqmusic');
  assert.equal(refused.success, false);
  assert.match(refused.message, /22\.60\.2 已在本机回退并暂停自动更新/);
  assert.equal(automatic.calls.some(call => call[0] === 'install'), false);
  assert.equal(automatic.guard.componentId, null);

  for (const run of [
    updater => updater.update('qqmusic', true),
    updater => updater.reinstall('qqmusic')
  ]) {
    const confirmed = harness();
    confirmed.updater.getStatuses = async () => [quarantinedStatus];
    assert.equal((await run(confirmed.updater)).success, true);
    assert.equal(confirmed.calls.filter(call => call[0] === 'install').length, 1);
  }
});

test('install progress is reported while updating and cleared when the install settles', async () => {
  for (const installFails of [false, true]) {
    let openGate;
    const installGate = new Promise(resolve => { openGate = resolve; });
    const { updater } = harness({ installGate, installFails });
    const running = updater.update('qqmusic');
    updater.reportProgress('qqmusic', 'download', 40);
    assert.deepEqual(
      { ...updater.progress.get('qqmusic'), updatedAt: undefined },
      { phase: 'download', percent: 40, updatedAt: undefined }
    );
    assert.match(updater.progress.get('qqmusic').updatedAt, /^\d{4}-\d\d-\d\dT/);
    openGate();
    await running;
    assert.equal(updater.progress.has('qqmusic'), false, String(installFails));
  }

  const { updater } = harness();
  let restartPhase = null;
  Object.assign(updater, {
    catalog: { connectors: { netease: { version: '3.1.37.205354.9' } } },
    getStatuses: async () => [{ id: 'netease', name: '网易云音乐', currentVersion: '3.1.37.205354.8',
      installed: true, compatible: true, updateAvailable: true }],
    readActive: async () => ({ version: '3.1.37.205354.9' }),
    hasInstalledConnectorFiles: async () => true,
    makeStatus: (_id, active) => ({ id: 'netease', name: '网易云音乐', currentVersion: active?.version }),
    neteaseProcessController: {
      stopForConnectorUpdate: async () => ({ wasRunning: true }),
      restartAfterConnectorUpdate: async () => { restartPhase = updater.progress.get('netease')?.phase; }
    },
    install: async (_id, _entry, _force, beforeReplace) => { await beforeReplace?.(); }
  });
  assert.equal((await updater.update('netease')).success, true);
  assert.equal(restartPhase, 'restart');
  assert.equal(updater.progress.has('netease'), false);
});

// The core self-update itself is covered by tests/app-updater.test.mjs. These
// run the actual startup announcement check from main.ts in a vm.
const startupJs = ts.transpileModule(
  extractFunctions('electron/main.ts', ['checkStartupUpdateAnnouncements']),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
).outputText;

const settle = () => new Promise(resolve => setImmediate(resolve));
const coreItem = { id: 'core', canUpdate: true, manualUpdate: false };

function startupHarness({
  local = { receipts: [], pendingFailure: null }, localFails = false,
  multiInstance = false, panelOpen = false
} = {}) {
  const events = [];
  let answer;
  let fail;
  const network = new Promise((resolve, reject) => { answer = resolve; fail = reject; });
  const context = vm.createContext({
    applicationQuitRequested: false,
    allowMultipleInstances: multiInstance,
    adminWindow: panelOpen ? { isDestroyed: () => false } : null,
    getUpdateAnnouncementService: () => ({
      async getLocalSnapshot() {
        events.push('local');
        if (localFails) throw new Error('EACCES: permission denied');
        return local;
      },
      get() {
        events.push('network');
        return network;
      }
    }),
    createAdminWindow: tab => events.push(['open', tab]),
    writeLog: (message, color) => events.push(['log', message, color]),
    setGlobalStatus: message => events.push(['status', message]),
    updateReceiptStore: {
      clearPendingCoreUpdate: async () => { events.push('clear-pending'); }
    },
    Error, String
  });
  vm.runInContext(startupJs, context);
  return {
    context, events,
    start: () => context.checkStartupUpdateAnnouncements(),
    respond: items => answer({ success: true, sessionId: 's', items, receipts: [] }),
    fail: () => fail(new Error('offline')),
    opened: () => events.filter(event => event[0] === 'open')
  };
}

test('a finished update is confirmed from the local receipts before the network check', async () => {
  const h = startupHarness({ local: { receipts: [{ id: 'receipt' }], pendingFailure: null } });
  const running = h.start();
  await settle();
  assert.deepEqual(h.events, ['local', ['open', 'updates'], 'network'], 'opened while the network check runs');
  h.respond([coreItem]);
  await running;
  assert.equal(h.opened().length, 1, 'never opened twice');
});

test('after startup only an update that installs without a choice opens the panel', async () => {
  const run = async (items, options = {}) => {
    const h = startupHarness(options);
    const running = h.start();
    await settle();
    if (options.quit) h.context.applicationQuitRequested = true;
    h.respond(items);
    await running;
    return h.opened();
  };
  assert.deepEqual(await run([coreItem]), [['open', 'updates']]);
  assert.deepEqual(await run([{ id: 'qqmusic', canUpdate: true, manualUpdate: false }]), [['open', 'updates']]);
  assert.deepEqual(await run([]), []);
  assert.deepEqual(await run([
    { id: 'qqmusic', canUpdate: true, manualUpdate: true },
    { id: 'kugou', canUpdate: false, manualUpdate: false }
  ]), [], 'manual player-branch and blocked items wait for the user');
  assert.deepEqual(await run([coreItem], { panelOpen: true }), [], 'an open panel shows its own dialog');
  assert.deepEqual(await run([coreItem], { quit: true }), []);
});

test('an update that Velopack never applied is reported once and its marker cleared', async () => {
  const pendingFailure = { previousVersion: '1.2.6', targetVersion: '1.2.7' };
  const h = startupHarness({ local: { receipts: [], pendingFailure } });
  const running = h.start();
  await settle();
  h.respond([]);
  await running;
  assert.deepEqual(h.events.slice(0, 4), [
    'local',
    ['log', '[更新] 上次点歌机更新未完成：更新包 v1.2.7 没有安装，当前仍为 v1.2.6', 'Yellow'],
    ['status', '上次点歌机更新未完成（v1.2.6 → v1.2.7），可在“版本升级”中重试'],
    'clear-pending'
  ]);

  const debugging = startupHarness({ local: { receipts: [], pendingFailure }, multiInstance: true });
  const other = debugging.start();
  await settle();
  debugging.respond([]);
  await other;
  assert.deepEqual(debugging.events, ['local', 'network'], 'a second debugging instance never judges the owner');
});

test('local and network failures never interrupt startup', async () => {
  const unreadable = startupHarness({ localFails: true });
  const running = unreadable.start();
  await settle();
  unreadable.respond([coreItem]);
  await running;
  assert.deepEqual(unreadable.events, [
    'local',
    ['log', '[更新] 检查本机更新记录失败：EACCES: permission denied', 'Yellow'],
    'network',
    ['open', 'updates']
  ]);

  const offline = startupHarness({ local: { receipts: [{ id: 'receipt' }], pendingFailure: null } });
  const checking = offline.start();
  await settle();
  offline.fail();
  await checking;
  assert.deepEqual(offline.opened(), [['open', 'updates']]);
});
