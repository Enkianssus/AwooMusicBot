import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { UpdateInstallationGuard } from '../electron/update-announcements.ts';

const updaterSource = fs.readFileSync(
  path.resolve(import.meta.dirname, '../electron/connector-updater.ts'), 'utf8'
);
const compiled = ts.transpileModule(updaterSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;

function harness({ installFails = false, activeVersion = '22.60.2', receiptFails = false } = {}) {
  const guard = new UpdateInstallationGuard();
  const calls = [];
  const exported = { exports: {} };
  vm.runInNewContext(compiled, {
    module: exported, exports: exported.exports,
    require: name => name === './update-announcements' ? {
      updateInstallationGuard: guard,
      reportCompletedConnectorUpdate: async (...args) => {
        calls.push(['receipt', ...args]);
        if (receiptFails) throw new Error('disk full');
      }
    } : {},
    Error
  });
  const updater = Object.create(exported.exports.ConnectorUpdater.prototype);
  Object.assign(updater, {
    updates: new Map(), catalog: { connectors: { qqmusic: { version: '22.60.2' } } },
    onLog: message => calls.push(['log', message]),
    getStatuses: async () => [{ id: 'qqmusic', name: 'QQ 音乐', currentVersion: '22.60.1',
      installed: true, compatible: true, updateAvailable: true }],
    install: async () => {
      calls.push(['install']);
      if (installFails) throw new Error('signature/health/activation rejected');
    },
    readActive: async () => { calls.push(['readActive']); return { version: activeVersion }; },
    makeStatus: (_id, active) => ({ id: 'qqmusic', name: 'QQ 音乐', currentVersion: active.version })
  });
  return { updater, guard, calls };
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

function coreUpdateHarness({ pendingFails = false, downloadFails = false, applyFails = false } = {}) {
  const source = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const begin = source.indexOf('function startAppUpdateOperation(): boolean {');
  const end = source.indexOf("process.on('uncaughtException'", begin);
  assert.ok(begin !== -1 && end > begin);
  const calls = [];
  const guard = new UpdateInstallationGuard();
  class UpdateManager {
    async checkForUpdatesAsync() { return { TargetFullRelease: { Version: '1.2.4' } }; }
    async downloadUpdateAsync() {
      calls.push('download');
      if (downloadFails) throw new Error('download failed');
    }
    waitExitThenApplyUpdate() {
      calls.push('apply');
      if (applyFails) throw new Error('apply failed');
    }
  }
  const context = vm.createContext({
    appUpdateOperation: null, appUpdatePhase: 'idle',
    updateInstallationGuard: guard,
    planAppUpdateRequest: phase => phase === 'idle' ? 'start' : 'already-running',
    markAppUpdateStarted: () => 'running', markAppUpdateRetryable: () => 'idle',
    markAppUpdateApplying: () => 'applying', markAppUpdateExitRequested: () => 'exit-requested',
    setAppUpdateDownloadStatus: () => {}, setGlobalStatus: () => {}, writeLog: () => {},
    requestApplicationQuit: () => { calls.push('quit'); },
    UpdateManager, app: { getVersion: () => '1.2.3' },
    updateReceiptStore: {
      prepareCoreUpdate: async (previous, target) => {
        assert.equal(previous, '1.2.3'); assert.equal(target, '1.2.4');
        calls.push('pending');
        if (pendingFails) throw new Error('disk full');
      },
      clearPendingCoreUpdate: async () => { calls.push('clear-pending'); }
    }, Error
  });
  vm.runInContext(ts.transpileModule(source.slice(begin, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText, context);
  return { context, calls, guard };
}

test('actual core operation persists target after download and before the one updater restart', async () => {
  const { context, calls, guard } = coreUpdateHarness();
  assert.equal(context.startAppUpdateOperation(), true);
  assert.equal(context.startAppUpdateOperation(), false);
  await context.appUpdateOperation;
  assert.deepEqual(calls, ['download', 'pending', 'apply', 'quit']);
  assert.equal(context.appUpdatePhase, 'exit-requested');
  assert.equal(guard.acquire('qqmusic'), null);
});

test('failed download or pending write cannot start an untracked core apply', async () => {
  for (const options of [{ downloadFails: true }, { pendingFails: true }]) {
    const { context, calls, guard } = coreUpdateHarness(options);
    context.startAppUpdateOperation();
    await context.appUpdateOperation;
    assert.equal(calls.includes('apply'), false);
    assert.equal(calls.includes('quit'), false);
    assert.equal(context.appUpdatePhase, 'idle');
    assert.equal(guard.componentId, null);
  }
});

test('failed apply clears its pending marker and makes core operation retryable', async () => {
  const { context, calls, guard } = coreUpdateHarness({ applyFails: true });
  context.startAppUpdateOperation();
  await context.appUpdateOperation;
  assert.deepEqual(calls, ['download', 'pending', 'apply', 'clear-pending']);
  assert.equal(context.appUpdatePhase, 'idle');
  assert.equal(guard.componentId, null);
});
