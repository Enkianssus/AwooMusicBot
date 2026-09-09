import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

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

const compiledUpdater = ts.transpileModule(updaterSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const updaterModule = { exports: {} };
vm.runInNewContext(compiledUpdater, {
  module: updaterModule,
  exports: updaterModule.exports,
  require: () => ({}),
  Error
});

function statusHarness(ids, catalogError = null) {
  // Exercise the actual public method with disk, network and signature I/O
  // replaced by strict fakes that reject work outside the requested scope.
  const updater = Object.create(updaterModule.exports.ConnectorUpdater.prototype);
  const reads = [];
  const validations = [];
  const refreshes = [];
  updater.readActive = async id => {
    assert.ok(ids.includes(id), `unexpected connector disk read: ${id}`);
    reads.push(id);
    return { id, version: '1.0.0' };
  };
  updater.fetchCatalog = async forceRefresh => {
    refreshes.push(forceRefresh);
    if (catalogError) throw catalogError;
    return {
      schemaVersion: 2,
      connectors: new Proxy({}, {
        get: (_, id) => {
          assert.ok(ids.includes(id), `unexpected catalog entry read: ${id}`);
          return { id, version: '1.0.1' };
        }
      })
    };
  };
  updater.validateV2Entry = (id, entry) => {
    assert.equal(entry.id, id);
    validations.push(id);
  };
  updater.makeStatus = (id, active, entry, checkedAt, error) => {
    assert.equal(active.id, id);
    return { id, entry, checkedAt, error };
  };
  return { updater, reads, validations, refreshes };
}

const nativeConnectorIds = ['netease', 'kugou', 'qqmusic', 'folia'];
for (const connectorId of nativeConnectorIds) {
  test(`manual ${connectorId} status refresh reads and validates only that connector`, async () => {
    const harness = statusHarness([connectorId]);
    const statuses = await harness.updater.getStatuses(true, connectorId);
    assert.deepEqual(Array.from(statuses, status => status.id), [connectorId]);
    assert.equal(statuses[0].error, null);
    assert.deepEqual(harness.reads, [connectorId]);
    assert.deepEqual(harness.validations, [connectorId]);
    assert.deepEqual(harness.refreshes, [true]);
  });
}

test('targeted status refresh reports catalog failure only for that connector', async () => {
  const harness = statusHarness(['netease'], new Error('catalog unavailable'));
  const statuses = await harness.updater.getStatuses(true, 'netease');
  assert.deepEqual(Array.from(statuses, status => status.id), ['netease']);
  assert.equal(statuses[0].error, 'catalog unavailable');
  assert.deepEqual(harness.reads, ['netease']);
  assert.deepEqual(harness.validations, []);
});

test('status refresh without a target still checks all native connectors', async () => {
  const harness = statusHarness(nativeConnectorIds);
  const statuses = await harness.updater.getStatuses();
  assert.deepEqual(Array.from(statuses, status => status.id), nativeConnectorIds);
  assert.deepEqual(harness.reads, nativeConnectorIds);
  assert.deepEqual(harness.validations, nativeConnectorIds);
  assert.deepEqual(harness.refreshes, [false]);
});
