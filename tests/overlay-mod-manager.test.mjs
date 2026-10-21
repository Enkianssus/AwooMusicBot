import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BUILTIN_OVERLAY_SETTINGS,
  OFFICIAL_OVERLAY_DESCRIPTOR_PROXY,
  OverlayModManager,
  normalizeOverlaySettingValues,
  resolveOverlayDescriptorUrl,
  validateOverlayDescriptor,
  validateOverlayManifest,
  validateOverlaySettingDefinitions
} from '../electron/overlay-mod-manager.ts';
import {
  isAllowedSkinMarketplaceOrigin,
  validateSkinMarketplaceDownloadUrl
} from '../electron/skin-marketplace-policy.ts';

const bundled = path.resolve(import.meta.dirname, '..', 'examples', 'obs-overlay');
const DOWNLOAD_TIMEOUT = { message: '下载超时，请重试或改用 ZIP 导入' };
const HOUR = 60 * 60 * 1000;

async function withOverlayRoot(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awoo-overlay-mods-'));
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [name, value] of entries) {
    const fileName = Buffer.from(name, 'utf8');
    const data = Buffer.from(value);
    const crc = crc32(data);
    const local = Buffer.alloc(30 + fileName.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    fileName.copy(local, 30);
    data.copy(local, 30 + fileName.length);
    localParts.push(local);

    const central = Buffer.alloc(46 + fileName.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(localOffset, 42);
    fileName.copy(central, 46);
    centralParts.push(central);
    localOffset += local.length;
  }

  const central = Buffer.concat(centralParts);
  const local = Buffer.concat(localParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

function overlayArchive(version, id = 'example.overlay') {
  return createStoredZip([
    ['overlay.json', JSON.stringify({
      schemaVersion: 1,
      id,
      name: 'Example',
      version,
      entry: 'index.html',
      minAppVersion: '1.1.6',
      settings: [{ key: 'spin', label: '旋转', type: 'toggle', default: false }]
    })],
    ['index.html', `<!doctype html><title>${id} ${version}</title>`]
  ]);
}

function fsError(code) {
  return Object.assign(new Error(`${code}: simulated lock`), { code });
}

test('accepts only official skin marketplace origins', () => {
  assert.equal(
    isAllowedSkinMarketplaceOrigin('https://awoo-skins.enkianss.us'),
    true
  );
  assert.equal(
    isAllowedSkinMarketplaceOrigin('https://awoo-skins.guoxintony.workers.dev'),
    false
  );
  assert.equal(
    isAllowedSkinMarketplaceOrigin('https://skins.enkianss.us'),
    false
  );
  assert.equal(
    isAllowedSkinMarketplaceOrigin('https://enkianss.us.attacker.example'),
    false
  );
  assert.equal(
    isAllowedSkinMarketplaceOrigin('https://example.com'),
    false
  );
});

test('accepts only same-origin skin ZIP download routes', () => {
  const origin = 'https://awoo-skins.enkianss.us';
  const valid = `${origin}/api/skins/123e4567-e89b-12d3-a456-426614174000/download`;
  assert.equal(validateSkinMarketplaceDownloadUrl(valid, origin), valid);
  assert.throws(
    () => validateSkinMarketplaceDownloadUrl(
      'https://example.com/api/skins/123e4567-e89b-12d3-a456-426614174000/download',
      origin
    ),
    /当前皮肤站/
  );
  assert.throws(
    () => validateSkinMarketplaceDownloadUrl(`${valid}?redirect=1`, origin),
    /当前皮肤站/
  );
});

test('recognizes the official GitHub repository and uses the site proxy', () => {
  assert.equal(
    resolveOverlayDescriptorUrl(
      'https://github.com/Enkianssus/AwooMusicBot-Overlay-Default/'
    ),
    OFFICIAL_OVERLAY_DESCRIPTOR_PROXY
  );
});

test('maps community repositories to their latest release descriptor', () => {
  assert.equal(
    resolveOverlayDescriptorUrl('https://github.com/example/pretty-overlay'),
    'https://github.com/example/pretty-overlay/releases/latest/download/awoo-overlay.json'
  );
});

test('rejects unsafe overlay entry paths', () => {
  assert.throws(
    () => validateOverlayManifest({
      schemaVersion: 1,
      id: 'example.overlay',
      name: 'Example',
      version: '1.0.0',
      entry: '../index.html',
      minAppVersion: '1.1.4'
    }, '1.1.4'),
    /入口/
  );
});

test('validates a bounded HTTPS release descriptor', () => {
  const descriptor = validateOverlayDescriptor({
    schemaVersion: 1,
    packageType: 'awoo-overlay',
    id: 'example.overlay',
    name: 'Example',
    version: '1.0.0',
    package: {
      url: 'https://github.com/example/pretty-overlay/releases/download/v1.0.0/awoo-overlay.zip',
      size: 1024,
      sha256: 'a'.repeat(64)
    }
  });
  assert.equal(descriptor.package.size, 1024);
});

test('keeps legacy overlays compatible when no settings are declared', () => {
  const manifest = validateOverlayManifest({
    schemaVersion: 1,
    id: 'example.legacy',
    name: 'Legacy',
    version: '1.0.0',
    entry: 'index.html',
    minAppVersion: '1.1.5'
  }, '1.1.5');
  assert.deepEqual(manifest.settings, []);
});

test('validates flexible overlay controls and normalizes their defaults', () => {
  const definitions = validateOverlaySettingDefinitions([
    {
      key: 'accentColor',
      label: '强调色',
      type: 'color',
      default: '#aabbcc',
      cssVariable: '--accent'
    },
    {
      key: 'opacity',
      label: '透明度',
      type: 'range',
      default: 0.8,
      min: 0,
      max: 1,
      step: 0.05
    },
    {
      key: 'spin',
      label: '旋转',
      type: 'toggle',
      default: true
    },
    {
      key: 'layout',
      label: '布局',
      type: 'select',
      default: 'wide',
      options: [
        { label: '横向', value: 'wide' },
        { label: '竖向', value: 'tall' }
      ]
    }
  ]);
  assert.equal(definitions[1].cssVariable, '--awoo-opacity');
  assert.deepEqual(normalizeOverlaySettingValues(definitions, {}), {
    accentColor: '#aabbcc',
    opacity: 0.8,
    spin: true,
    layout: 'wide'
  });
  assert.throws(
    () => normalizeOverlaySettingValues(definitions, { unknown: true }, true),
    /不支持参数/
  );
});

test('defaults builtin Mod UI artwork to album cover with requester avatar opt-in', () => {
  const definition = BUILTIN_OVERLAY_SETTINGS.find(
    item => item.key === 'artworkSource'
  );
  assert.equal(definition?.type, 'select');
  assert.equal(definition?.label, 'Mod UI 当前歌曲图片');
  assert.equal(definition?.group, 'Mod UI 歌曲图片');
  assert.equal(definition?.default, 'album_cover');
  assert.deepEqual(definition?.options, [
    { label: '专辑封面（默认）', value: 'album_cover' },
    { label: '点歌人头像', value: 'requester_avatar' }
  ]);
  const rotation = BUILTIN_OVERLAY_SETTINGS.find(
    item => item.key === 'coverRotation'
  );
  assert.equal(rotation?.label, '当前图片旋转');
  assert.equal(rotation?.group, '图片动画');
});

test('rejects unsafe or contradictory overlay control definitions', () => {
  assert.throws(
    () => validateOverlaySettingDefinitions([
      {
        key: 'opacity',
        label: '透明度',
        type: 'range',
        default: 2,
        min: 0,
        max: 1,
        step: 0.1
      }
    ]),
    /范围或默认值/
  );
  assert.throws(
    () => validateOverlaySettingDefinitions([
      {
        key: 'accent',
        label: '强调色',
        type: 'color',
        default: '#ffffff',
        cssVariable: 'background-image'
      }
    ]),
    /CSS 变量名/
  );
});

test('caches builtin overlay settings and restores them across manager instances', async () => {
  await withOverlayRoot(async root => {
    const manager = new OverlayModManager(root, bundled, '1.1.5');
    let state = await manager.updateSettings('builtin', { coverRotation: true });
    assert.equal(state.active.values.coverRotation, true);

    const restoredManager = new OverlayModManager(root, bundled, '1.1.5');
    state = await restoredManager.getPublicState();
    assert.equal(state.active.values.coverRotation, true);

    state = await restoredManager.updateSettings('builtin', {}, true);
    assert.equal(state.active.values.coverRotation, false);
  });
});

test('builtin settings stay in sync with the bundled overlay.json', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(bundled, 'overlay.json'), 'utf8'));
  assert.deepEqual(
    BUILTIN_OVERLAY_SETTINGS,
    validateOverlaySettingDefinitions(manifest.settings)
  );
});

test('a stalled descriptor or package body times out and cancels the transfer', { timeout: 20_000 }, async () => {
  await withOverlayRoot(async root => {
    let cancelled = 0;
    // The body never produces a chunk and never ends.
    const fetcher = async () => new Response(new ReadableStream({
      cancel() { cancelled += 1; }
    }));
    const manager = new OverlayModManager(root, bundled, '1.2.6', fetcher, {
      descriptorTimeouts: { totalTimeoutMs: 30 },
      packageTimeouts: { totalTimeoutMs: 60_000, idleTimeoutMs: 30 }
    });
    await assert.rejects(
      manager.installFromUrl('https://example.com/awoo-overlay.json'),
      DOWNLOAD_TIMEOUT
    );
    const startedAt = Date.now();
    await assert.rejects(
      manager.installArchiveFromUrl('https://example.com/skin.zip'),
      DOWNLOAD_TIMEOUT
    );
    assert.ok(Date.now() - startedAt < 10_000, 'the idle limit ends the read long before the total budget');
    assert.equal(cancelled, 2);
    // Nothing stays locked after a timeout.
    const state = await manager.activate('builtin');
    assert.equal(state.activeId, 'builtin');
  });
});

test('steady chunks keep a download alive only until the total budget', async t => {
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await withOverlayRoot(async root => {
    let body;
    let cancelled = false;
    const fetcher = async () => new Response(new ReadableStream({
      start(controller) { body = controller; },
      cancel() { cancelled = true; }
    }));
    const manager = new OverlayModManager(root, bundled, '1.2.6', fetcher, {
      packageTimeouts: { totalTimeoutMs: 100, idleTimeoutMs: 50 }
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let failure = null;
      manager.installArchiveFromUrl('https://example.com/skin.zip')
        .catch(error => { failure = error; });
      await flush();
      for (let elapsed = 30; elapsed <= 90; elapsed += 30) {
        t.mock.timers.tick(30);
        body.enqueue(new Uint8Array([1]));
        await flush();
        assert.equal(failure, null, `a chunk every 30 ms resets the 50 ms idle limit (${elapsed} ms)`);
      }
      t.mock.timers.tick(30);
      await flush();
      assert.equal(failure?.message, DOWNLOAD_TIMEOUT.message);
      assert.equal(cancelled, true);
    } finally {
      t.mock.timers.reset();
    }
  });
});

test('concurrent settings saves and switches all persist', async () => {
  await withOverlayRoot(async root => {
    const manager = new OverlayModManager(root, bundled, '1.2.6');
    await manager.installArchive(overlayArchive('1.0.0'));
    await Promise.all([
      manager.updateSettings('builtin', { coverRotation: true }),
      manager.updateSettings('builtin', { accentColor: '#112233' }),
      manager.updateSettings('example.overlay', { spin: true }),
      manager.activate('builtin'),
      manager.updateSettings('builtin', { maxQueue: 5 })
    ]);
    const state = await new OverlayModManager(root, bundled, '1.2.6').getPublicState();
    assert.equal(state.activeId, 'builtin');
    assert.equal(state.active.values.coverRotation, true);
    assert.equal(state.active.values.accentColor, '#112233');
    assert.equal(state.active.values.maxQueue, 5);
    assert.equal(state.overlays.find(item => item.id === 'example.overlay')?.values.spin, true);
  });
});

test('Windows lock errors on install and registry renames are retried', async () => {
  await withOverlayRoot(async root => {
    const renamed = [];
    const lockedOnce = new Set();
    const delays = [];
    const fsImpl = {
      async rename(from, to) {
        renamed.push(path.basename(to));
        if (!lockedOnce.has(to)) {
          lockedOnce.add(to);
          throw fsError('EPERM');
        }
        await fs.rename(from, to);
      },
      rm: (target, options) => fs.rm(target, options)
    };
    const manager = new OverlayModManager(root, bundled, '1.2.6', fetch, {
      fsRetry: { fsImpl, sleep: async milliseconds => { delays.push(milliseconds); } }
    });
    const installed = await manager.installArchive(overlayArchive('1.0.0'));
    assert.equal(installed.version, '1.0.0');
    assert.deepEqual(renamed, ['1.0.0', '1.0.0', 'registry.json', 'registry.json']);
    assert.deepEqual(delays, [100, 100]);
    const state = await manager.getPublicState();
    assert.equal(state.active.id, 'example.overlay');
    const asset = await manager.resolveActiveAsset('');
    assert.equal(asset?.filePath, path.join(root, 'example.overlay', '1.0.0', 'index.html'));
  });
});

test('an upgrade removes older versions and backups of the same Mod only', async () => {
  await withOverlayRoot(async root => {
    const manager = new OverlayModManager(root, bundled, '1.2.6');
    await manager.installArchive(overlayArchive('1.0.0'));
    await manager.installArchive(overlayArchive('1.0.0', 'other.overlay'));
    await fs.mkdir(path.join(root, 'example.overlay', '0.9.0.backup-interrupted'));
    await manager.installArchive(overlayArchive('1.1.0'));
    assert.deepEqual(await fs.readdir(path.join(root, 'example.overlay')), ['1.1.0']);
    assert.deepEqual(await fs.readdir(path.join(root, 'other.overlay')), ['1.0.0']);
    const state = await manager.getPublicState();
    assert.equal(state.active.id, 'example.overlay');
    assert.equal(state.active.version, '1.1.0');

    // Reinstalling the active version replaces it without leaving a backup.
    await manager.installArchive(overlayArchive('1.1.0'));
    assert.deepEqual(await fs.readdir(path.join(root, 'example.overlay')), ['1.1.0']);
    assert.equal((await fs.readdir(root)).some(name => name.startsWith('.install-')), false);
  });
});

test('the first use sweeps install leftovers only once they are an hour old', async () => {
  await withOverlayRoot(async root => {
    // Staging directories, registry temp files and backups are named with randomUUID().
    const operation = randomUUID();
    const leftovers = [`.install-${operation}`, `registry.json.${operation}.tmp`];
    await fs.mkdir(path.join(root, leftovers[0], 'content'), { recursive: true });
    await fs.writeFile(path.join(root, leftovers[1]), '{}');
    await fs.mkdir(path.join(root, 'example.overlay', '1.0.0'), { recursive: true });
    await fs.mkdir(path.join(root, 'example.overlay', `1.0.0.backup-${operation}`));
    // Names the manager never creates are left alone.
    const lookalikes = ['.install-interrupted', 'registry.json.interrupted.tmp'];
    await fs.mkdir(path.join(root, lookalikes[0]));
    await fs.writeFile(path.join(root, lookalikes[1]), '{}');
    const keptVersions = ['1.0.0', '1.0.0.backup-interrupted', `latest.backup-${operation}`].sort();
    for (const name of keptVersions.slice(1)) {
      await fs.mkdir(path.join(root, 'example.overlay', name));
    }
    const everything = [...leftovers, ...lookalikes, 'example.overlay', 'registry.json'].sort();

    const fresh = new OverlayModManager(root, bundled, '1.2.6');
    await fresh.getPublicState();
    // Mutations queue behind the sweep, so this also waits for it.
    await fresh.activate('builtin');
    assert.deepEqual((await fs.readdir(root)).sort(), everything);

    const later = new OverlayModManager(root, bundled, '1.2.6', fetch, {
      now: () => Date.now() + 2 * HOUR
    });
    await later.getPublicState();
    await later.activate('builtin');
    assert.deepEqual(
      (await fs.readdir(root)).sort(),
      [...lookalikes, 'example.overlay', 'registry.json'].sort()
    );
    assert.deepEqual((await fs.readdir(path.join(root, 'example.overlay'))).sort(), keptVersions);
  });
});

test('Mod ids that collide with system names are rejected', async () => {
  const manifest = id => ({
    schemaVersion: 1,
    id,
    name: 'Example',
    version: '1.0.0',
    entry: 'index.html',
    minAppVersion: '1.1.6'
  });
  for (const id of ['registry.json', 'Registry.JSON', 'registry.json.skin', 'registry.jsonx', 'builtin', 'BuiltIn']) {
    assert.throws(() => validateOverlayManifest(manifest(id), '1.2.6'), /Mod UI 标识与系统保留名称冲突/, id);
  }
  assert.throws(() => validateOverlayManifest(manifest('.install-x'), '1.2.6'), /Mod UI id/);
  for (const id of ['registry-json', 'my.registry.json', 'builtin.extra']) {
    assert.equal(validateOverlayManifest(manifest(id), '1.2.6').id, id);
  }

  // The reviewer's case: a first install named registry.json used to turn the
  // registry file into the Mod's directory, so nothing could be saved again.
  await withOverlayRoot(async root => {
    const manager = new OverlayModManager(root, bundled, '1.2.6');
    for (const id of ['registry.json', 'registry.json.skin', 'builtin']) {
      await assert.rejects(manager.installArchive(overlayArchive('1.0.0', id)), /Mod UI 标识与系统保留名称冲突/);
    }
    assert.deepEqual(await fs.readdir(root), []);
    await manager.installArchive(overlayArchive('1.0.0'));
    assert.equal((await fs.stat(path.join(root, 'registry.json'))).isFile(), true);
    assert.equal((await manager.activate('builtin')).activeId, 'builtin');
    assert.deepEqual((await fs.readdir(root)).sort(), ['example.overlay', 'registry.json']);
  });
});

test('Mod versions may not contain the backup marker', async () => {
  for (const version of ['1.0.0-rc.backup-1', `1.0.0-rc.backup-${randomUUID()}`, '1.0.0+build.BACKUP-2']) {
    assert.throws(
      () => validateOverlayManifest({
        schemaVersion: 1,
        id: 'example.overlay',
        name: 'Example',
        version,
        entry: 'index.html'
      }, '1.2.6'),
      /\.backup-/,
      version
    );
  }
  await withOverlayRoot(async root => {
    const manager = new OverlayModManager(root, bundled, '1.2.6');
    await assert.rejects(manager.installArchive(overlayArchive('1.0.0-rc.backup-1')), /\.backup-/);
  });
});

test('the leftover sweep keeps Mods that older releases installed under look-alike names', async () => {
  await withOverlayRoot(async root => {
    // Earlier releases accepted these names. The first two are the reviewer's
    // cases; the last two match the exact leftover formats and survive only
    // because the registry still uses them.
    const legacy = [
      { id: 'registry.json.skin', version: '1.0.0' },
      { id: 'example.overlay', version: '1.0.0-rc.backup-1' },
      { id: 'other.overlay', version: `1.0.0-rc.backup-${randomUUID()}` },
      { id: `registry.json.${randomUUID()}.tmp`, version: '1.0.0' }
    ];
    for (const { id, version } of legacy) {
      await fs.mkdir(path.join(root, id, version), { recursive: true });
      await fs.writeFile(path.join(root, id, version, 'index.html'), `<!doctype html><title>${id}</title>`);
    }
    await fs.writeFile(path.join(root, 'registry.json'), JSON.stringify({
      schemaVersion: 1,
      activeId: 'example.overlay',
      overlays: legacy.map(({ id, version }) => ({
        schemaVersion: 1,
        id,
        name: id,
        version,
        entry: 'index.html',
        author: 'Example',
        description: '',
        homepage: '',
        minAppVersion: '1.1.6',
        settings: [],
        installedAt: '2026-01-01T00:00:00.000Z',
        source: 'local-zip'
      })),
      settings: {}
    }));

    const later = new OverlayModManager(root, bundled, '1.2.6', fetch, {
      now: () => Date.now() + 2 * HOUR
    });
    assert.equal((await later.getPublicState()).activeId, 'example.overlay');
    // Mutations queue behind the sweep, so this also waits for it.
    await later.activate('example.overlay');
    for (const { id, version } of legacy) {
      assert.deepEqual(await fs.readdir(path.join(root, id)), [version], id);
    }
    assert.equal(
      (await later.resolveActiveAsset(''))?.filePath,
      path.join(root, 'example.overlay', '1.0.0-rc.backup-1', 'index.html')
    );
  });
});

test('active assets report the entry, so the OBS host can send the content root there', async () => {
  await withOverlayRoot(async root => {
    const manager = new OverlayModManager(root, bundled, '1.2.6');
    assert.equal((await manager.resolveActiveAsset(''))?.entry, 'index.html', 'the built-in UI');
    await manager.installArchive(createStoredZip([
      ['overlay.json', JSON.stringify({
        schemaVersion: 1,
        id: 'nested.overlay',
        name: 'Nested',
        version: '1.0.0',
        entry: 'dist/index.html',
        minAppVersion: '1.1.6'
      })],
      ['dist/index.html', '<!doctype html><link rel="stylesheet" href="styles.css">'],
      ['dist/styles.css', 'p{}']
    ]));
    const entry = await manager.resolveActiveAsset('');
    assert.equal(entry?.entry, 'dist/index.html');
    assert.equal(entry?.filePath, path.join(root, 'nested.overlay', '1.0.0', 'dist', 'index.html'));
    assert.equal((await manager.resolveActiveAsset('dist/styles.css'))?.entry, 'dist/index.html');
  });
});

test('the cached registry follows external edits and hands out copies', async () => {
  await withOverlayRoot(async root => {
    const manager = new OverlayModManager(root, bundled, '1.2.6');
    await manager.installArchive(overlayArchive('1.0.0'));
    const first = await manager.getPublicState();
    first.overlays[1].settings.push({ key: 'tampered' });
    first.overlays.length = 0;
    const second = await manager.getPublicState();
    assert.equal(second.overlays.length, 2);
    assert.equal(second.overlays[1].settings.length, 1);

    const registryPath = path.join(root, 'registry.json');
    const registry = JSON.parse(await fs.readFile(registryPath, 'utf8'));
    registry.activeId = 'builtin';
    await fs.writeFile(registryPath, JSON.stringify(registry, null, 2));
    assert.equal((await manager.getPublicState()).activeId, 'builtin');
  });
});

test('an unreadable registry keeps the last state on screen and fails saves', async () => {
  await withOverlayRoot(async root => {
    const manager = new OverlayModManager(root, bundled, '1.2.6');
    await manager.installArchive(overlayArchive('1.0.0'));
    // A directory stands in for a registry file that cannot be read.
    const registryPath = path.join(root, 'registry.json');
    await fs.rm(registryPath);
    await fs.mkdir(registryPath);
    assert.equal((await manager.getPublicState()).activeId, 'example.overlay');
    await assert.rejects(
      manager.updateSettings('builtin', { coverRotation: true }),
      /读取 Mod UI 配置失败/
    );
    assert.equal((await fs.stat(registryPath)).isDirectory(), true, 'the save never replaced the registry');
    const restarted = new OverlayModManager(root, bundled, '1.2.6');
    assert.equal((await restarted.getPublicState()).activeId, 'builtin');
  });
});
