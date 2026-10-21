import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  APP_UPDATE_CHECK_TIMEOUT_MESSAGE,
  APP_UPDATE_FEED_URL,
  APP_UPDATE_STALL_MESSAGE,
  AppUpdater,
  createAppUpdateManager,
  withTimeout
} from '../electron/app-updater.ts';
import { UpdateInstallationGuard } from '../electron/update-announcements.ts';

const settle = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** Manual timers so minute-long bounds are tested without waiting. */
function fakeTimers() {
  let now = Date.parse('2026-10-21T08:00:00.000Z');
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer: (callback, ms) => {
      timers.set(++nextId, { at: now + ms, callback });
      return nextId;
    },
    clearTimer: id => { timers.delete(id); },
    get pending() { return timers.size; },
    advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = target;
    }
  };
}

const updateInfo = (version = '1.2.4') => ({ TargetFullRelease: { Version: version, Size: 167_772_160 } });

function harness({
  info = updateInfo(),
  checkForUpdates = async () => info,
  download = null,
  listFails = false,
  downloadFails = false,
  pendingFails = false,
  applyFails = false
} = {}) {
  const calls = [];
  const finished = [];
  const markers = [];
  const guard = new UpdateInstallationGuard();
  const clock = fakeTimers();
  let managers = 0;
  const manager = {
    checkForUpdatesAsync: checkForUpdates,
    async downloadUpdateAsync(target, progress) {
      calls.push('download');
      assert.equal(target, info);
      if (download) return download(progress);
      progress(50);
      progress(100);
      if (downloadFails) throw new Error('download failed');
    },
    waitExitThenApplyUpdate(target, silent, restart) {
      calls.push('apply');
      assert.deepEqual([target, silent, restart], [info, false, true]);
      if (applyFails) throw new Error('apply failed');
    }
  };
  const updater = new AppUpdater({
    createManager: () => { managers++; return manager; },
    receiptStore: {
      list: async () => {
        if (listFails) throw new Error('EACCES: permission denied');
        return [];
      },
      prepareCoreUpdate: async (previous, target, marker) => {
        assert.deepEqual([previous, target], ['1.2.3', info.TargetFullRelease.Version]);
        calls.push('pending');
        markers.push(marker);
        if (pendingFails) throw new Error('disk full');
      },
      clearPendingCoreUpdate: async () => { calls.push('clear-pending'); }
    },
    guard,
    requestQuit: () => { calls.push('quit'); return true; },
    log: () => {},
    setGlobalStatus: () => {},
    getVersion: () => '1.2.3',
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onFinished: outcome => finished.push(outcome)
  });
  return { updater, calls, finished, markers, guard, clock, managers: () => managers };
}

test('the production feed has one URL and one manager factory', () => {
  class FakeManager { constructor(feedUrl) { this.feedUrl = feedUrl; } }
  assert.equal(APP_UPDATE_FEED_URL, 'https://app.enkianss.us/update/awoo');
  assert.equal(createAppUpdateManager(FakeManager).feedUrl, APP_UPDATE_FEED_URL);
  assert.equal(createAppUpdateManager(FakeManager, 'https://example.test/feed').feedUrl, 'https://example.test/feed');
});

test('withTimeout settles with the operation or rejects once its bound elapses', async () => {
  const clock = fakeTimers();
  assert.equal(await withTimeout(Promise.resolve('ready'), 50, '超时', clock), 'ready');
  await assert.rejects(withTimeout(Promise.reject(new Error('offline')), 50, '超时', clock), { message: 'offline' });
  assert.equal(clock.pending, 0);
  const hung = withTimeout(new Promise(() => {}), 50, '检查超时', clock);
  clock.advance(49);
  await settle();
  clock.advance(1);
  await assert.rejects(hung, { message: '检查超时' });
  assert.equal(await withTimeout(Promise.resolve(1), 50, '超时'), 1);
});

test('actual core operation persists target after download and before the one updater restart', async () => {
  const { updater, calls, finished, markers, guard, clock } = harness();
  assert.equal(updater.start(), true);
  assert.equal(updater.start(), false);
  assert.equal(updater.getStatus().state, 'checking');
  await settle();
  assert.deepEqual(calls, ['download', 'pending', 'apply', 'quit']);
  assert.equal(updater.phase, 'exit-requested');
  assert.equal(guard.componentId, 'core');
  assert.equal(guard.acquire('qqmusic'), null);
  assert.equal(updater.start(), false);
  assert.deepEqual(markers, [{ startedAt: new Date(clock.now()).toISOString(), pid: process.pid }]);
  const { updatedAt, ...status } = updater.getStatus();
  assert.equal(updatedAt, new Date(clock.now()).toISOString());
  assert.deepEqual(status, {
    state: 'applying', progress: 100, version: '1.2.4',
    message: '下载完成，正在重启安装', sizeBytes: 167_772_160
  });
  assert.deepEqual(finished, []);
  assert.equal(clock.pending, 0);
});

test('failed download or pending write cannot start an untracked core apply', async () => {
  for (const options of [{ downloadFails: true }, { pendingFails: true }]) {
    const { updater, calls, finished, guard } = harness(options);
    updater.start();
    await settle();
    assert.equal(calls.includes('apply'), false);
    assert.equal(calls.includes('quit'), false);
    assert.equal(calls.includes('clear-pending'), false);
    assert.equal(updater.phase, 'idle');
    assert.equal(guard.componentId, null);
    assert.equal(updater.getStatus().state, 'error');
    assert.deepEqual(finished, ['error']);
  }
});

test('failed apply clears its pending marker and makes core operation retryable', async () => {
  const { updater, calls, finished, guard } = harness({ applyFails: true });
  updater.start();
  await settle();
  assert.deepEqual(calls, ['download', 'pending', 'apply', 'clear-pending']);
  assert.equal(updater.phase, 'idle');
  assert.equal(guard.componentId, null);
  assert.equal(updater.getStatus().message, '更新失败：apply failed');
  assert.deepEqual(finished, ['error']);
  assert.equal(updater.start(), true);
});

test('a hung update check fails after its bound and releases the installation lock', async () => {
  const { updater, calls, finished, guard, clock } = harness({ checkForUpdates: () => new Promise(() => {}) });
  assert.equal(updater.start(), true);
  clock.advance(14_999);
  await settle();
  assert.equal(updater.getStatus().state, 'checking');
  assert.equal(guard.componentId, 'core');
  clock.advance(1);
  await settle();
  assert.equal(updater.getStatus().state, 'error');
  assert.equal(updater.getStatus().message, `更新失败：${APP_UPDATE_CHECK_TIMEOUT_MESSAGE}`);
  assert.equal(guard.componentId, null);
  assert.equal(updater.phase, 'idle');
  assert.deepEqual(calls, []);
  assert.deepEqual(finished, ['error']);
  assert.equal(updater.start(), true);
});

test('a download without progress is abandoned and its late completion can never apply', async () => {
  const downloads = [];
  const { updater, calls, finished, guard, clock } = harness({
    download: progress => {
      const pending = deferred();
      downloads.push({ ...pending, progress });
      return pending.promise;
    }
  });
  updater.start();
  await settle();
  const [stale] = downloads;
  assert.equal(updater.getStatus().state, 'downloading');
  assert.equal(updater.getStatus().sizeBytes, 167_772_160);
  // A changed value restarts the watchdog; a repeated value does not.
  clock.advance(119_000);
  stale.progress(12);
  clock.advance(119_000);
  stale.progress(12);
  await settle();
  assert.equal(updater.getStatus().progress, 12);
  assert.equal(guard.componentId, 'core');
  clock.advance(1_000);
  await settle();
  assert.equal(updater.getStatus().state, 'error');
  assert.equal(updater.getStatus().message, APP_UPDATE_STALL_MESSAGE);
  assert.equal(guard.componentId, null);
  assert.equal(updater.phase, 'idle');
  assert.deepEqual(finished, ['error']);
  // The native task finishing later must neither record nor apply anything.
  stale.progress(100);
  stale.resolve();
  await settle();
  assert.deepEqual(calls, ['download']);
  assert.equal(updater.getStatus().state, 'error');
  // A retry is a new attempt that callbacks from the abandoned one cannot touch.
  assert.equal(updater.start(), true);
  await settle();
  assert.deepEqual(calls, ['download', 'download']);
  stale.progress(70);
  assert.equal(updater.getStatus().progress, 0);
  downloads[1].resolve();
  await settle();
  assert.deepEqual(calls, ['download', 'download', 'pending', 'apply', 'quit']);
  assert.deepEqual(finished, ['error']);
});

test('prerelease, missing or not-newer feed versions fail before any download', async () => {
  for (const [version, message] of [
    ['1.2.6-rc.1', '更新失败：更新目标版本格式无效：1.2.6-rc.1'],
    ['', '更新失败：更新包缺少版本号'],
    ['1.2.3', '更新失败：更新目标版本必须高于当前版本']
  ]) {
    const { updater, calls, finished, guard } = harness({ info: updateInfo(version) });
    updater.start();
    await settle();
    assert.deepEqual(calls, []);
    assert.equal(updater.getStatus().state, 'error');
    assert.equal(updater.getStatus().message, message);
    assert.equal(guard.componentId, null);
    assert.deepEqual(finished, ['error']);
  }
});

test('an unreadable receipt store fails before the download instead of after it', async () => {
  const { updater, calls, finished, guard } = harness({ listFails: true });
  updater.start();
  await settle();
  assert.deepEqual(calls, []);
  assert.equal(updater.getStatus().state, 'error');
  assert.equal(guard.componentId, null);
  assert.deepEqual(finished, ['error']);
});

test('no update leaves the core operation retryable and reports the result', async () => {
  const { updater, calls, finished, guard } = harness({ info: null });
  updater.start();
  await settle();
  assert.equal(updater.getStatus().state, 'no-update');
  assert.equal(updater.phase, 'idle');
  assert.equal(guard.componentId, null);
  assert.deepEqual(calls, []);
  assert.deepEqual(finished, ['no-update']);
  assert.equal(updater.start(), true);
});

test('a running connector update blocks the core operation before any network work', () => {
  const { updater, guard, managers } = harness();
  const release = guard.acquire('qqmusic');
  assert.equal(updater.start(), false);
  assert.equal(managers(), 0);
  assert.equal(updater.phase, 'idle');
  assert.equal(updater.getStatus().state, 'idle');
  release();
  assert.equal(updater.start(), true);
});

test('the version page check is bounded, reports the feed target and takes no lock', async () => {
  assert.deepEqual(await harness().updater.check(), { hasUpdate: true, version: '1.2.4' });
  assert.deepEqual(await harness({ info: null }).updater.check(), { hasUpdate: false });
  const { updater, clock, guard } = harness({ checkForUpdates: () => new Promise(() => {}) });
  const checking = updater.check();
  assert.equal(guard.componentId, null);
  clock.advance(15_000);
  await assert.rejects(checking, { message: APP_UPDATE_CHECK_TIMEOUT_MESSAGE });
});

test('the updater has one Velopack restart owner and no Electron or Velopack dependency', () => {
  const source = fs.readFileSync(new URL('../electron/app-updater.ts', import.meta.url), 'utf8');
  assert.equal((source.match(/waitExitThenApplyUpdate\(/g) || []).length, 1);
  assert.match(source, /markAppUpdateExitRequested\(\);[\s\S]{0,120}requestQuit\(\)/);
  assert.doesNotMatch(source, /from '(?:electron|velopack)'|require\(/);
});
