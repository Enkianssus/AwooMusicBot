import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OFFICIAL_OVERLAY_DESCRIPTOR_PROXY,
  resolveOverlayDescriptorUrl,
  validateOverlayDescriptor,
  validateOverlayManifest
} from '../electron/overlay-mod-manager.ts';

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
