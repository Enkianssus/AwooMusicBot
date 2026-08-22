import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const updaterSource = fs.readFileSync(
  path.resolve(import.meta.dirname, '../electron/connector-updater.ts'),
  'utf8'
);

test('new connector installs prefer Awoo framework-dependent packages', () => {
  assert.match(
    updaterSource,
    /return entry\.package[\s\S]*entry\.awooFrameworkDependent[\s\S]*entry\.frameworkDependent/
  );
  assert.match(
    updaterSource,
    /const framework = selectFrameworkDependentConnectorPackage\(entry\);/
  );
  assert.match(updaterSource, /deployment: 'framework-dependent'/);
});

test('missing framework packages are rejected instead of falling back to full packages', () => {
  assert.match(
    updaterSource,
    /更新清单缺少 Framework-dependent 小包[\s\S]*拒绝下载 SelfContained 完整包/
  );
  assert.match(updaterSource, /未下载 SelfContained 完整包/);
  assert.doesNotMatch(
    updaterSource,
    /entry\.awooPackage \|\| entry,\s*\{\s*deployment: 'self-contained'/
  );
});

test('small-package failure only retries the same signed framework asset on GitHub', () => {
  assert.match(
    updaterSource,
    /downloadUrl: buildConnectorGitHubReleaseUrl\([\s\S]*?framework\.asset/
  );
  assert.match(
    updaterSource,
    /本站小体积包安装失败：[\s\S]*GitHub 签名小体积包安装失败/
  );
  assert.match(updaterSource, /wholeFileDownload[\s\S]*true/);
});

test('legacy self-contained active connectors remain readable and launchable', () => {
  assert.match(
    updaterSource,
    /const deployment = active\.deployment \|\| 'self-contained';/
  );
  assert.match(
    updaterSource,
    /const expected = connectorExecutableNames\(connectorId\)/
  );
  assert.match(
    updaterSource,
    /if \(deployment === 'framework-dependent'\)[\s\S]*else if \(deployment !== 'self-contained'\)/
  );
});

test('1.1.10 reads the v2 small-only Awoo catalog contract', () => {
  assert.match(
    updaterSource,
    /CATALOG_URL[\s\S]*connectors\/v2\/catalog\.json/
  );
  assert.match(updaterSource, /catalog\.schemaVersion !== 2/);
  assert.match(updaterSource, /entry\.package/);
  assert.match(
    updaterSource,
    /connectors\/v2\/download\//
  );
  assert.match(
    updaterSource,
    /v2 清单只接受 package[\s\S]*framework-dependent 包/
  );
});

test('v2 catalog failures do not silently fall back to frozen v1', () => {
  assert.match(
    updaterSource,
    /不回退到它|不.*fallback|does not fall back|不.*静默.*v1/i
  );
  assert.match(
    updaterSource,
    /LEGACY_CONNECTOR_CATALOG_URL[\s\S]*connectors\/v1\/catalog\.json/
  );
});
