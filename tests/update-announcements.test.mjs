import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  UpdateAnnouncementService,
  UpdateInstallationGuard,
  UpdateReceiptStore,
  RELEASE_NOTES_UNAVAILABLE,
  MAX_RELEASE_NOTES_LENGTH,
  compareUpdateVersions,
  fetchReleaseNotes,
  releaseNotesLocation
} from '../electron/update-announcements.ts';

async function temporaryStore(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awoo-update-announcements-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, store: new UpdateReceiptStore(directory) };
}

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

test('corrupt notification state is not overwritten and does not block announcement checks', async t => {
  const { directory, store } = await temporaryStore(t);
  const file = path.join(directory, 'update-announcements.json');
  await fs.writeFile(file, 'corrupt');
  await assert.rejects(store.prepareCoreUpdate('1.2.3', '1.2.4'));
  const service = new UpdateAnnouncementService(serviceOptions(store, {
    checkCore: async () => ({ version: '1.2.4', notes: '真实修复说明' })
  }));
  const result = await service.get();
  assert.equal(result.items[0].version, '1.2.4');
  assert.match(result.errors.join(' '), /记录/);
  assert.equal(await fs.readFile(file, 'utf8'), 'corrupt');
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

test('announcement polling coalesces concurrent checks and caches network results; manual retry refreshes', async t => {
  const { store } = await temporaryStore(t);
  let checks = 0;
  const service = new UpdateAnnouncementService(serviceOptions(store, {
    checkCore: async () => { checks++; await new Promise(resolve => setTimeout(resolve, 10)); return null; }
  }));
  const results = await Promise.all(Array.from({ length: 8 }, () => service.get(true)));
  assert.equal(checks, 1);
  assert.equal(new Set(results.map(result => result.sessionId)).size, 1);
  await service.get();
  assert.equal(checks, 1);
  await service.get(true);
  assert.equal(checks, 2);
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

test('missing, oversized, mismatched and timed-out notes have an honest fallback', async () => {
  for (const fetchImpl of [
    async () => new Response('', { status: 404 }),
    async () => new Response(JSON.stringify({ tag_name: 'v1.2.5', body: 'wrong version' })),
    async () => new Response('x'.repeat(200000)),
    async () => { throw new Error('offline'); },
    async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })
  ]) assert.equal(await fetchReleaseNotes('core', '1.2.4', fetchImpl, 10), RELEASE_NOTES_UNAVAILABLE);
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
