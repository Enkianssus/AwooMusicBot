import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  UpdateAnnouncementService,
  UpdateInstallationGuard,
  UpdateReceiptStore,
  CONNECTOR_CATALOG_UNAVAILABLE,
  QUARANTINED_CONNECTOR_NOTE,
  RELEASE_NOTES_TEMPORARILY_UNAVAILABLE,
  RELEASE_NOTES_UNAVAILABLE,
  MAX_RELEASE_NOTES_LENGTH,
  compareUpdateVersions,
  fetchReleaseNotes,
  isUpdateVersion,
  releaseNotesLocation
} from '../electron/update-announcements.ts';
import { opensAutomatically, selectUpdateActions } from '../src/update-announcement-policy.ts';

async function temporaryStore(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awoo-update-announcements-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, store: new UpdateReceiptStore(directory) };
}

/** Scheduling tests need a store that answers without disk I/O. */
const memoryStore = () => ({
  reconcileCoreVersion: async () => {}, list: async () => [],
  inspectPendingCore: async () => ({ failed: false })
});

const settle = () => new Promise(resolve => setImmediate(resolve));

const status = (id, currentVersion, latestVersion, overrides = {}) => ({
  id, name: id, installed: Boolean(currentVersion), currentVersion, latestVersion,
  minimumCoreVersion: '1.2.3', compatible: true, updateAvailable: true,
  manualUpdateAvailable: false, autoUpdateAvailable: true, updateKind: 'revision',
  supportedPlayerVersion: '22.60', updating: false,
  checkedAt: new Date().toISOString(), error: null, ...overrides
});

const fakeNotes = async url => new Response(JSON.stringify({
  tag_name: decodeURIComponent(url.split('/').at(-1)), body: '修复：测试说明',
  draft: false, prerelease: false
}), { headers: { 'Content-Type': 'application/json' } });

function serviceOptions(store, overrides = {}) {
  return {
    store, currentVersion: '1.2.3', networkEnabled: true, coreEnabled: true,
    checkCore: async () => null, getConnectorStatuses: async () => [],
    fetchImpl: fakeNotes, ...overrides
  };
}

test('numeric versions support connector branches without lexical ordering or invalid targets', () => {
  assert.equal(compareUpdateVersions('22.60.10', '22.60.9'), 1);
  assert.equal(compareUpdateVersions('3.1.38.205386.2', '3.1.38.205386.1'), 1);
  assert.equal(compareUpdateVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareUpdateVersions('1.2.4-rc1', '1.2.3'), 0);
  assert.equal(compareUpdateVersions('../1.2.4', '1.2.3'), 0);
  assert.equal(isUpdateVersion('3.1.38.205386.2'), true);
  for (const version of ['1.2.6-rc.1', 'v1.2.6', '1.2', '', null]) assert.equal(isUpdateVersion(version), false);
});

test('only a restarted core at or above the target and newer than previous creates a receipt', async t => {
  const { directory, store } = await temporaryStore(t);
  await store.prepareCoreUpdate('1.2.3', '1.2.4');
  await new UpdateReceiptStore(directory).reconcileCoreVersion('1.2.3');
  assert.deepEqual(await store.list(), []);
  await store.reconcileCoreVersion('1.2.2');
  assert.deepEqual(await store.list(), []);
  await new UpdateReceiptStore(directory).reconcileCoreVersion('1.2.5');
  const receipts = await store.list();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].componentId, 'core');
  assert.equal(receipts[0].previousVersion, '1.2.3');
  assert.equal(receipts[0].version, '1.2.5');
  await store.reconcileCoreVersion('1.2.5');
  assert.equal((await store.list()).length, 1);
});

test('failed apply can clear its pending marker without deleting older success receipts', async t => {
  const { store } = await temporaryStore(t);
  await store.recordConnectorUpdate('qqmusic', 'QQ', '22.60.1', '22.60.2');
  await store.prepareCoreUpdate('1.2.3', '1.2.4');
  await store.clearPendingCoreUpdate();
  await store.reconcileCoreVersion('1.2.4');
  assert.deepEqual((await store.list()).map(item => item.componentId), ['qqmusic']);
  await assert.rejects(store.prepareCoreUpdate('1.2.3', '1.2.3'), /高于/);
});

test('concurrent successful connector updates persist separately and acknowledge only selected ids', async t => {
  const { directory, store } = await temporaryStore(t);
  await Promise.all([
    store.recordConnectorUpdate('qqmusic', 'QQ', '22.60.1', '22.60.2'),
    store.recordConnectorUpdate('netease', '网易云', '3.1.38.205386.1', '3.1.38.205386.2'),
    store.recordConnectorUpdate('kugou', '酷狗', '20.1.41.1', '20.1.41.2')
  ]);
  const receipts = await store.list();
  assert.equal(receipts.length, 3);
  await store.acknowledge([receipts[0].id, 'unknown-id']);
  assert.equal((await new UpdateReceiptStore(directory).list()).length, 2);
  await store.acknowledge([receipts[1].id]);
  assert.deepEqual((await store.list()).map(item => item.id), [receipts[2].id]);
});

test('first install, same-version repair, downgrade and duplicate completion do not add misleading receipts', async t => {
  const { store } = await temporaryStore(t);
  for (const previous of [null, '22.60.2', '22.60.3']) {
    assert.equal(await store.recordConnectorUpdate('qqmusic', 'QQ', previous, '22.60.2'), null);
  }
  await store.recordConnectorUpdate('qqmusic', 'QQ', '22.60.1', '22.60.2');
  assert.equal(await store.recordConnectorUpdate('qqmusic', 'QQ', '22.60.1', '22.60.2'), null);
  assert.equal((await store.list()).length, 1);
});

test('corrupt notification state is quarantined, not overwritten, and blocks neither core updates nor checks', async t => {
  const { directory, store } = await temporaryStore(t);
  const file = path.join(directory, 'update-announcements.json');
  await fs.writeFile(file, 'corrupt');
  await store.prepareCoreUpdate('1.2.3', '1.2.4');
  const quarantined = (await fs.readdir(directory))
    .filter(name => name.startsWith('update-announcements.json.corrupt-'));
  assert.equal(quarantined.length, 1);
  assert.equal(await fs.readFile(path.join(directory, quarantined[0]), 'utf8'), 'corrupt');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).pendingCore.targetVersion, '1.2.4');
  const service = new UpdateAnnouncementService(serviceOptions(store, {
    checkCore: async () => ({ version: '1.2.4', notes: '真实修复说明' })
  }));
  const result = await service.get();
  assert.equal(result.items[0].version, '1.2.4');
  assert.equal(result.errors, undefined);
});

test('future, malformed and oversized state files are moved aside instead of failing every update', async t => {
  for (const content of [
    JSON.stringify({ schemaVersion: 2, pendingCore: null, receipts: [] }),
    JSON.stringify({ schemaVersion: 1, pendingCore: null, receipts: {} }),
    'null',
    JSON.stringify({ schemaVersion: 1, receipts: [], padding: 'x'.repeat(1024 * 1024) })
  ]) {
    const { directory, store } = await temporaryStore(t);
    await fs.writeFile(path.join(directory, 'update-announcements.json'), content);
    assert.deepEqual(await store.list(), []);
    const names = await fs.readdir(directory);
    assert.equal(names.includes('update-announcements.json'), false);
    const quarantined = names.filter(name => name.includes('.corrupt-'));
    assert.equal(quarantined.length, 1);
    assert.equal(await fs.readFile(path.join(directory, quarantined[0]), 'utf8'), content);
  }
});

test('individually invalid receipts and an invalid pending marker are dropped while valid ones survive', async t => {
  const { directory, store } = await temporaryStore(t);
  const file = path.join(directory, 'update-announcements.json');
  const receipt = (id, overrides = {}) => ({
    id, componentId: 'qqmusic', name: 'QQ', previousVersion: '22.60.1', version: '22.60.2',
    completedAt: '2026-10-21T08:00:00.000Z', ...overrides
  });
  // A byte order mark added by an editor is not corruption.
  await fs.writeFile(file, String.fromCharCode(0xfeff) + JSON.stringify({
    schemaVersion: 1,
    pendingCore: { previousVersion: '1.2.3', targetVersion: '1.2.6-rc.1' },
    receipts: [
      receipt('kept-qq'),
      receipt('future-player', { componentId: 'spotify' }),
      receipt('prerelease', { version: '22.61.0-beta' }),
      receipt('bad-date', { completedAt: 'yesterday' }),
      null,
      receipt('kept-netease', {
        componentId: 'netease', previousVersion: '3.1.38.205386.1', version: '3.1.38.205386.2'
      })
    ]
  }));
  assert.deepEqual((await store.list()).map(item => item.id), ['kept-qq', 'kept-netease']);
  assert.deepEqual(await store.inspectPendingCore('1.2.3', 1), { failed: false });
  assert.equal((await fs.readdir(directory)).some(name => name.includes('.corrupt-')), false);
  await store.acknowledge(['kept-qq']);
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(saved.receipts.map(item => item.id), ['kept-netease']);
  assert.equal(saved.pendingCore, null);
});

test('a pending core marker left by another process at the old version reports an unfinished update', async t => {
  const { directory, store } = await temporaryStore(t);
  const file = path.join(directory, 'update-announcements.json');
  assert.deepEqual(await store.inspectPendingCore('1.2.3', 4242), { failed: false });
  await store.prepareCoreUpdate('1.2.3', '1.2.4', { startedAt: '2026-10-21T08:00:00.000Z', pid: 4242 });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).pendingCore, {
    previousVersion: '1.2.3', targetVersion: '1.2.4', startedAt: '2026-10-21T08:00:00.000Z', pid: 4242
  });
  // The process that wrote the marker is still handing over to Velopack.
  assert.deepEqual(await store.inspectPendingCore('1.2.3', 4242), { failed: false });
  assert.deepEqual(await store.inspectPendingCore('1.2.3', 5151), {
    failed: true, previousVersion: '1.2.3', targetVersion: '1.2.4'
  });
  assert.deepEqual(await store.inspectPendingCore('1.2.4', 5151), { failed: false });
  // Callers that pass no marker still identify the current process.
  await store.prepareCoreUpdate('1.2.3', '1.2.5');
  const { pendingCore } = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(pendingCore.pid, process.pid);
  assert.ok(Number.isFinite(Date.parse(pendingCore.startedAt)));
  assert.deepEqual(await store.inspectPendingCore('1.2.3', process.pid), { failed: false });
});

test('the local snapshot reports receipts and an unfinished core update without network access', async t => {
  const { directory, store } = await temporaryStore(t);
  const offline = () => { throw new Error('unexpected network'); };
  const localSnapshot = currentVersion => new UpdateAnnouncementService(serviceOptions(
    new UpdateReceiptStore(directory),
    { currentVersion, processId: 5151, checkCore: offline, getConnectorStatuses: offline, fetchImpl: offline }
  )).getLocalSnapshot();
  await store.recordConnectorUpdate('qqmusic', 'QQ', '22.60.1', '22.60.2');
  await store.prepareCoreUpdate('1.2.3', '1.2.4', { pid: 4242 });
  const unfinished = await localSnapshot('1.2.3');
  assert.deepEqual(unfinished.pendingFailure, { previousVersion: '1.2.3', targetVersion: '1.2.4' });
  assert.deepEqual(unfinished.receipts.map(item => item.componentId), ['qqmusic']);
  const completed = await localSnapshot('1.2.4');
  assert.equal(completed.pendingFailure, null);
  assert.deepEqual(completed.receipts.map(item => item.componentId), ['qqmusic', 'core']);
});

test('installed newer candidates only; incompatible updates explain why and player branch stays manual', async t => {
  const { store } = await temporaryStore(t);
  const service = new UpdateAnnouncementService(serviceOptions(store, {
    checkCore: async () => ({ version: '1.2.4', notes: 'Core release notes' }),
    getConnectorStatuses: async () => [
      status('qqmusic', '22.60.1', '23.0.1', { manualUpdateAvailable: true }),
      status('netease', '3.1.38.205386.1', '3.1.38.205386.2', { compatible: false, minimumCoreVersion: '1.3.0' }),
      status('kugou', null, '20.1.41.2'),
      status('folia', '1.1.4', '1.1.3')
    ]
  }));
  const { items } = await service.get();
  assert.deepEqual(items.map(item => item.id), ['core', 'qqmusic', 'netease']);
  assert.equal(items[1].manualUpdate, true);
  assert.equal(items[1].supportedPlayerVersion, '22.60');
  assert.equal(items[2].canUpdate, false);
  assert.match(items[2].blockedReason, /1.3.0/);
  assert.equal(items[0].notes, 'Core release notes');
});

test('the core update carries its package size only when the feed reports a positive size', async () => {
  for (const [sizeBytes, expected] of [[167_772_160, 167_772_160], [0, undefined], [Number.NaN, undefined], [undefined, undefined]]) {
    const service = new UpdateAnnouncementService(serviceOptions(memoryStore(), {
      checkCore: async () => ({ version: '1.2.4', notes: '修复说明', sizeBytes })
    }));
    const { items } = await service.get();
    assert.equal(items[0].id, 'core');
    assert.equal(items[0].sizeBytes, expected);
  }
});

test('announcement polling coalesces concurrent checks and caches network results; manual retry refreshes', async t => {
  const { store } = await temporaryStore(t);
  let checks = 0;
  let now = 0;
  const service = new UpdateAnnouncementService(serviceOptions(store, {
    now: () => now,
    checkCore: async () => { checks++; await new Promise(resolve => setTimeout(resolve, 10)); return null; }
  }));
  const results = await Promise.all(Array.from({ length: 8 }, () => service.get(true)));
  assert.equal(checks, 1);
  assert.equal(new Set(results.map(result => result.sessionId)).size, 1);
  await service.get();
  assert.equal(checks, 1);
  now += 10_000;
  await service.get(true);
  assert.equal(checks, 2);
});

test('forced refreshes are limited to one per ten seconds', async () => {
  let now = 0;
  let checks = 0;
  const service = new UpdateAnnouncementService(serviceOptions(memoryStore(), {
    now: () => now, checkCore: async () => { checks++; return null; }
  }));
  await service.get(true);
  now += 9_999;
  await service.get(true);
  assert.equal(checks, 1);
  now += 1;
  await service.get(true);
  assert.equal(checks, 2);
});

test('a manual refresh during a regular check runs exactly one more check with fresh connector data', async () => {
  const requests = [];
  let release;
  const regularCheck = new Promise(resolve => { release = resolve; });
  const service = new UpdateAnnouncementService(serviceOptions(memoryStore(), {
    getConnectorStatuses: async refresh => {
      requests.push(refresh);
      if (!refresh) {
        await regularCheck;
        return [];
      }
      return [status('qqmusic', '22.60.1', '22.60.2')];
    }
  }));
  const regular = service.get();
  await settle();
  const manual = [service.get(true), service.get(true), service.get(true)];
  await settle();
  assert.deepEqual(requests, [false]);
  release();
  const [, ...manualResults] = await Promise.all([regular, ...manual]);
  assert.deepEqual(requests, [false, true]);
  for (const result of manualResults) assert.deepEqual(result.items.map(item => item.id), ['qqmusic']);
});

test('failed checks back off from thirty seconds to five minutes and a manual refresh restarts the sequence', async () => {
  let now = 0;
  let checks = 0;
  let online = false;
  const service = new UpdateAnnouncementService(serviceOptions(memoryStore(), {
    now: () => now,
    checkCore: async () => {
      checks++;
      if (!online) throw new Error('offline');
      return null;
    }
  }));
  const nextCheckAfter = async delay => {
    const before = checks;
    now += delay - 1;
    await service.get();
    assert.equal(checks, before, `no check before ${delay} ms`);
    now += 1;
    await service.get();
    assert.equal(checks, before + 1, `a check after ${delay} ms`);
  };
  await service.get();
  for (const delay of [30_000, 60_000, 120_000, 300_000, 300_000]) await nextCheckAfter(delay);
  now += 10_000;
  await service.get(true);
  await nextCheckAfter(30_000);
  online = true;
  await nextCheckAfter(60_000);
  await nextCheckAfter(5 * 60_000);
});

test('connector errors are reported only for installed players and an unavailable catalog is reported once', async () => {
  const errorsFor = async statuses => (await new UpdateAnnouncementService(serviceOptions(memoryStore(), {
    getConnectorStatuses: async () => statuses
  })).get()).errors;
  assert.deepEqual(await errorsFor([
    status('qqmusic', '22.60.1', null, { error: '更新清单缺少 qqmusic 连接器' }),
    status('kugou', null, null, { error: '更新清单缺少 kugou 连接器' }),
    status('netease', '3.1.38.205386.1', '3.1.38.205386.1')
  ]), ['qqmusic更新检查失败，请稍后重试。']);
  const offline = (id, currentVersion) => status(id, currentVersion, null, { error: 'fetch failed' });
  assert.deepEqual(await errorsFor([
    offline('netease', '3.1.38.205386.1'), offline('kugou', '20.1.41.1'),
    offline('qqmusic', null), offline('folia', null)
  ]), [CONNECTOR_CATALOG_UNAVAILABLE]);
  assert.equal(await errorsFor([
    offline('netease', null), offline('kugou', null), offline('qqmusic', null), offline('folia', null)
  ]), undefined);
});

test('invalidating a component drops only its cached candidate; invalidating everything forces a new check', async () => {
  let checks = 0;
  let gate = Promise.resolve();
  let release;
  const service = new UpdateAnnouncementService(serviceOptions(memoryStore(), {
    checkCore: async () => { checks++; await gate; return { version: '1.2.4', notes: '修复说明' }; },
    getConnectorStatuses: async () => [status('qqmusic', '22.60.1', '22.60.2')]
  }));
  const ids = result => result.items.map(item => item.id);
  assert.deepEqual(ids(await service.get()), ['core', 'qqmusic']);
  service.invalidate('core');
  assert.deepEqual(ids(await service.get()), ['qqmusic']);
  assert.equal(checks, 1);
  service.invalidate();
  assert.deepEqual(ids(await service.get()), ['core', 'qqmusic']);
  assert.equal(checks, 2);
  // A check that was already running cannot bring an invalidated candidate back.
  gate = new Promise(resolve => { release = resolve; });
  service.invalidate();
  const running = service.get();
  await settle();
  service.invalidate('core');
  release();
  assert.deepEqual(ids(await running), ['qqmusic']);
  assert.equal(checks, 3);
});

test('one unavailable or hung service cannot suppress another available update', async t => {
  const { store } = await temporaryStore(t);
  const service = new UpdateAnnouncementService(serviceOptions(store, {
    checkCore: () => new Promise(() => {}), checkTimeoutMs: 15,
    getConnectorStatuses: async () => [status('qqmusic', '22.60.1', '22.60.2')]
  }));
  const result = await service.get();
  assert.equal(result.items[0].id, 'qqmusic');
  assert.match(result.errors.join(' '), /点歌机/);
});

test('isolated development checks do not contact any update server', async t => {
  const { store } = await temporaryStore(t);
  const shouldNotRun = () => { throw new Error('unexpected network'); };
  const service = new UpdateAnnouncementService(serviceOptions(store, {
    networkEnabled: false, checkCore: shouldNotRun,
    getConnectorStatuses: shouldNotRun, fetchImpl: shouldNotRun
  }));
  assert.deepEqual((await service.get(true)).items, []);
});

test('activation removes cached candidates even if an earlier check finishes afterward', async t => {
  const { store } = await temporaryStore(t);
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const service = new UpdateAnnouncementService(serviceOptions(store, {
    getConnectorStatuses: async () => { await waiting; return [status('qqmusic', '22.60.1', '22.60.2')]; }
  }));
  const checking = service.get();
  service.noteInstalled('qqmusic', '22.60.2');
  release();
  assert.deepEqual((await checking).items, []);
});

test('a version rolled back on this computer is offered only as an explained manual retry', async () => {
  let now = 0;
  const service = new UpdateAnnouncementService(serviceOptions(memoryStore(), {
    now: () => now,
    getConnectorStatuses: async () => [
      status('qqmusic', '22.52.1', '22.52.2', { quarantined: true, autoUpdateAvailable: false }),
      status('kugou', '20.1.41.1', '20.1.41.2', { quarantined: false })
    ]
  }));
  const check = async () => {
    const { items } = await service.get(true);
    now += 10_000;
    return Object.fromEntries(items.map(item => [item.id, item]));
  };
  const { qqmusic, kugou } = await check();
  assert.equal(qqmusic.canUpdate, true, 'the user can still retry it');
  assert.equal(qqmusic.manualUpdate, true);
  assert.equal(qqmusic.quarantined, true);
  assert.equal(qqmusic.notes, `**${QUARANTINED_CONNECTOR_NOTE}**\n\n修复：测试说明`);
  // Neither the startup check nor the dialog opens on its own for it.
  assert.equal(qqmusic.canUpdate && !qqmusic.manualUpdate, false);
  assert.equal(opensAutomatically(qqmusic), false);
  assert.deepEqual(selectUpdateActions([qqmusic, kugou]).map(item => item.id), ['kugou', 'qqmusic']);

  assert.equal(kugou.manualUpdate, false);
  assert.equal('quarantined' in kugou, false);
  assert.equal(kugou.notes, '修复：测试说明');
  // Cached release notes are not prefixed twice by a later check.
  assert.equal((await check()).qqmusic.notes, qqmusic.notes);
});

test('a rollback withdraws the receipt of the bad version and its stale candidate', async t => {
  const { directory, store } = await temporaryStore(t);
  await store.recordConnectorUpdate('qqmusic', 'QQ', '22.52.0', '22.52.1');
  await store.recordConnectorUpdate('kugou', '酷狗', '20.1.41.1', '20.1.41.2');
  let statuses = [status('qqmusic', '22.52.1', '22.52.2')];
  const options = serviceOptions(store, { getConnectorStatuses: async () => statuses });
  const service = new UpdateAnnouncementService(options);
  const ids = result => result.items.map(item => `${item.id}@${item.version}:${item.manualUpdate}`);
  const receiptsOf = result => result.receipts.map(item => `${item.componentId} ${item.previousVersion}->${item.version}`);
  assert.deepEqual(ids(await service.get()), ['qqmusic@22.52.2:false']);

  // Background maintenance installs 22.52.2 and records its receipt ...
  service.noteInstalled('qqmusic', '22.52.2');
  await store.recordConnectorUpdate('qqmusic', 'QQ', '22.52.1', '22.52.2');
  assert.deepEqual(ids(await service.get()), []);
  // ... then cannot connect, restores 22.52.1 and pauses 22.52.2.
  statuses = [status('qqmusic', '22.52.1', '22.52.2', { quarantined: true, autoUpdateAvailable: false })];
  await service.noteRolledBack('qqmusic', '22.52.2', '22.52.1');

  // The candidate cached before the update must not come back as an
  // ordinary update now that 22.52.1 is installed again.
  const afterRollback = await service.get();
  assert.deepEqual(ids(afterRollback), []);
  assert.deepEqual(receiptsOf(afterRollback), ['qqmusic 22.52.0->22.52.1', 'kugou 20.1.41.1->20.1.41.2']);
  // The next launch finds no success to announce for the bad version.
  const nextLaunch = await new UpdateAnnouncementService({
    ...options, store: new UpdateReceiptStore(directory)
  }).getLocalSnapshot();
  assert.deepEqual(receiptsOf(nextLaunch), ['qqmusic 22.52.0->22.52.1', 'kugou 20.1.41.1->20.1.41.2']);
  // A new check offers the paused version only as a manual retry.
  assert.deepEqual(ids(await service.get(true)), ['qqmusic@22.52.2:true']);
});

test('withdrawing a receipt matches its exact version, is serialized and survives a failed write', async t => {
  const { directory, store } = await temporaryStore(t);
  await store.recordConnectorUpdate('qqmusic', 'QQ', '22.52.0', '22.52.1');
  // Queued behind the record, like every other write of the store.
  const [recorded, discarded] = await Promise.all([
    store.recordConnectorUpdate('qqmusic', 'QQ', '22.52.1', '22.52.2'),
    store.discardReceipt('qqmusic', '22.52.2')
  ]);
  assert.equal(recorded.version, '22.52.2');
  assert.equal(discarded, 1);
  assert.equal(await store.discardReceipt('qqmusic', '22.52.2'), 0);
  assert.equal(await store.discardReceipt('kugou', '22.52.1'), 0);
  assert.equal(await store.discardReceipt('qqmusic', 'not-a-version'), 0);
  const saved = JSON.parse(await fs.readFile(path.join(directory, 'update-announcements.json'), 'utf8'));
  assert.deepEqual(saved.receipts.map(item => item.version), ['22.52.1']);
  assert.deepEqual((await fs.readdir(directory)).filter(name => name.endsWith('.tmp')), []);

  // The in-memory part of a rollback holds even if the receipt file cannot be written.
  const service = new UpdateAnnouncementService(serviceOptions({
    ...memoryStore(),
    discardReceipt: async () => { throw new Error('EPERM: operation not permitted'); }
  }, { getConnectorStatuses: async () => [status('qqmusic', '22.52.1', '22.52.2')] }));
  assert.equal((await service.get()).items[0].manualUpdate, false);
  await assert.rejects(service.noteRolledBack('qqmusic', '22.52.2', '22.52.1'), /EPERM/);
  assert.deepEqual((await service.get()).items, []);
});

test('an old unacknowledged receipt cannot hide an update following a manual rollback', async t => {
  const { store } = await temporaryStore(t);
  await store.recordConnectorUpdate('qqmusic', 'QQ', '22.60.1', '22.60.2');
  const service = new UpdateAnnouncementService(serviceOptions(store, {
    getConnectorStatuses: async () => [status('qqmusic', '22.60.1', '22.60.2')]
  }));
  const result = await service.get();
  assert.equal(result.items.length, 1);
  assert.equal(result.receipts.length, 1);
});

test('release notes use fixed official repositories, exact tags and bounded plain text', async () => {
  assert.equal(releaseNotesLocation('core', '1.2.4').tag, 'v1.2.4');
  assert.match(releaseNotesLocation('qqmusic', '22.60.2').apiUrl,
    /^https:\/\/api.github.com\/repos\/Enkianssus\/awoo-connectors\/releases\/tags\/qqmusic-v22.60.2$/);
  assert.throws(() => releaseNotesLocation('other', '1.2.4'));
  assert.throws(() => releaseNotesLocation('core', '../../latest'));
  const text = await fetchReleaseNotes('core', '1.2.4', async (url, init) => {
    assert.equal(init.redirect, 'error');
    assert.match(url, /AwooMusicBot\/releases\/tags\/v1.2.4$/);
    return new Response(JSON.stringify({ tag_name: 'v1.2.4', body: 'x'.repeat(20000) }));
  });
  assert.equal(text.length, MAX_RELEASE_NOTES_LENGTH);
});

test('missing, oversized, mismatched and empty notes say that none were provided', async () => {
  for (const fetchImpl of [
    async () => new Response('', { status: 404 }),
    async () => new Response(JSON.stringify({ tag_name: 'v1.2.5', body: 'wrong version' })),
    async () => new Response('x'.repeat(200000)),
    async () => new Response(JSON.stringify({ tag_name: 'v1.2.4', body: ' \n ' }))
  ]) assert.equal(await fetchReleaseNotes('core', '1.2.4', fetchImpl, 10), RELEASE_NOTES_UNAVAILABLE);
});

test('offline, timed-out, rate-limited and failing requests are reported as temporarily unavailable', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('offline'); },
    async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
    async () => new Response(JSON.stringify({ message: 'API rate limit exceeded' }), { status: 403 }),
    async () => new Response('', { status: 429 }),
    async () => new Response('', { status: 502 }),
    async () => new Response('<html>captive portal</html>')
  ]) {
    assert.equal(await fetchReleaseNotes('core', '1.2.4', fetchImpl, 10), RELEASE_NOTES_TEMPORARILY_UNAVAILABLE);
  }
});

test('release notes are fetched once per tag and a failed fetch is retried only after ten minutes', async () => {
  let now = 0;
  let qqOnline = false;
  const requests = [];
  const service = new UpdateAnnouncementService(serviceOptions(memoryStore(), {
    now: () => now,
    checkCore: async () => ({ version: '1.2.4' }),
    getConnectorStatuses: async () => [status('qqmusic', '22.60.1', '22.60.2')],
    fetchImpl: async url => {
      requests.push(decodeURIComponent(url.split('/').at(-1)));
      if (url.includes('qqmusic') && !qqOnline) throw new Error('offline');
      return fakeNotes(url);
    }
  }));
  const first = await service.get(true);
  assert.deepEqual(first.items.map(item => item.notes), ['修复：测试说明', RELEASE_NOTES_TEMPORARILY_UNAVAILABLE]);
  now += 60_000;
  qqOnline = true;
  const cached = await service.get(true);
  assert.deepEqual(requests, ['v1.2.4', 'qqmusic-v22.60.2']);
  assert.equal(cached.items[1].notes, RELEASE_NOTES_TEMPORARILY_UNAVAILABLE);
  now += 10 * 60_000;
  const retried = await service.get(true);
  assert.deepEqual(requests, ['v1.2.4', 'qqmusic-v22.60.2', 'qqmusic-v22.60.2']);
  assert.deepEqual(retried.items.map(item => item.notes), ['修复：测试说明', '修复：测试说明']);
});

test('shared installation lock prevents core/connector overlaps and stale releases', () => {
  const guard = new UpdateInstallationGuard();
  const releaseCore = guard.acquire('core');
  assert.equal(guard.componentId, 'core');
  assert.equal(guard.acquire('qqmusic'), null);
  releaseCore();
  const releaseQq = guard.acquire('qqmusic');
  releaseCore();
  assert.equal(guard.componentId, 'qqmusic');
  assert.equal(guard.acquire('core'), null);
  assert.equal(guard.acquire('netease'), null);
  releaseQq();
  assert.equal(guard.componentId, null);
});
