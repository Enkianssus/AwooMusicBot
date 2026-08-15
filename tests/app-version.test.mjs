import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('package metadata and the development output folder share one version', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const packageLock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));

  assert.equal(packageJson.version, packageLock.version);
  assert.equal(packageJson.version, packageLock.packages[''].version);
  assert.match(packageJson.scripts['build:dev'], new RegExp(`dist_electron_dev_${packageJson.version.replaceAll('.', '\\.')}$`));
});
