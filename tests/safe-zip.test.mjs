import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { normalizeZipEntryPath } from '../electron/safe-zip.ts';

test('normalizes ordinary nested ZIP paths', () => {
  assert.equal(
    normalizeZipEntryPath('bridge/native/Awoo.dll'),
    ['bridge', 'native', 'Awoo.dll'].join(path.sep)
  );
  assert.equal(
    normalizeZipEntryPath('profiles/22.51.json/'),
    ['profiles', '22.51.json'].join(path.sep)
  );
});

test('rejects traversal, absolute, ADS, and Windows device paths', () => {
  for (const unsafe of [
    '../outside.dll',
    'safe/../../outside.dll',
    '/absolute.dll',
    'C:/absolute.dll',
    'file.dll:stream',
    'safe//file.dll',
    'safe/CON',
    'safe/trailing. '
  ]) {
    assert.throws(
      () => normalizeZipEntryPath(unsafe),
      /ZIP 包含不安全路径/
    );
  }
});
