import test from 'node:test';
import assert from 'node:assert/strict';
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awoo-overlay-settings-'));
  const bundled = path.resolve('examples/obs-overlay');
  try {
    const manager = new OverlayModManager(root, bundled, '1.1.5');
    let state = await manager.updateSettings('builtin', { coverRotation: true });
    assert.equal(state.active.values.coverRotation, true);

    const restoredManager = new OverlayModManager(root, bundled, '1.1.5');
    state = await restoredManager.getPublicState();
    assert.equal(state.active.values.coverRotation, true);

    state = await restoredManager.updateSettings('builtin', {}, true);
    assert.equal(state.active.values.coverRotation, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
