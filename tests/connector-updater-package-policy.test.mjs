import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as catalogPolicy from '../electron/connector-catalog-policy.ts';
import * as brandingPolicy from '../electron/connector-branding-policy.ts';
import * as connectorDownload from '../electron/connector-download.ts';
import * as installPolicy from '../electron/connector-install-policy.ts';
import * as releaseUrl from '../electron/connector-release-url.ts';
import * as versionPolicy from '../electron/connector-version-policy.ts';
import * as devUserDataPolicy from '../electron/dev-user-data-policy.ts';
import * as fsRetry from '../electron/fs-retry.ts';
import { buildPrivateDotnetEnvironment } from '../electron/private-dotnet-runtime.ts';
import { UpdateInstallationGuard } from '../electron/update-announcements.ts';

const { CATALOG_URL, PUBLIC_KEY_ID, V2_DOWNLOAD_URL_PREFIX } = catalogPolicy;

const updaterSource = fs.readFileSync(
  path.resolve(import.meta.dirname, '../electron/connector-updater.ts'),
  'utf8'
);
const compiledUpdater = ts.transpileModule(updaterSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;

/** Runs the real updater module with only the listed imports available. */
function loadUpdater(imports = {}, globals = {}) {
  const updaterModule = { exports: {} };
  vm.runInNewContext(compiledUpdater, {
    module: updaterModule,
    exports: updaterModule.exports,
    require: name => imports[name] ?? {},
    Error,
    ...globals
  });
  return updaterModule.exports;
}

const inertModule = loadUpdater();

function settle(turns = 5) {
  let chain = Promise.resolve();
  for (let i = 0; i < turns; i++) {
    chain = chain.then(() => new Promise(resolve => setImmediate(resolve)));
  }
  return chain;
}

function controlledClock(start) {
  const time = { now: start };
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length) super(...args);
      else super(time.now);
    }

    static now() {
      return time.now;
    }
  }
  return { time, FakeDate };
}

test('new installs take only the framework-dependent package, never a full SelfContained one', async () => {
  const { selectFrameworkDependentConnectorPackage: select, ConnectorUpdater } = inertModule;
  const v2Package = { asset: 'package' };
  const awoo = { asset: 'awoo' };
  const legacy = { asset: 'legacy' };
  assert.equal(select({ package: v2Package, awooFrameworkDependent: awoo, frameworkDependent: legacy }), v2Package);
  assert.equal(select({ awooFrameworkDependent: awoo, frameworkDependent: legacy }), awoo);
  assert.equal(select({ frameworkDependent: legacy }), legacy);
  assert.equal(select({ awooPackage: { asset: 'full' }, asset: 'full.zip' }), null);

  // install() refuses before any runtime, network or disk work.
  const updater = Object.create(ConnectorUpdater.prototype);
  for (const entry of [
    { version: '22.52.2', asset: 'awoo-connector-qqmusic-22.52.2-win-x86.zip', awooPackage: { asset: 'full' } },
    { version: '22.52.2', awooFrameworkDependent: awoo }
  ]) {
    await assert.rejects(
      updater.install('qqmusic', entry),
      /QQ 音乐更新清单缺少 Framework-dependent 小包，已拒绝下载 SelfContained 完整包；v2 清单只接受 package framework-dependent 包/
    );
  }
  assert.doesNotMatch(
    updaterSource,
    /entry\.awooPackage \|\| entry,\s*\{\s*deployment: 'self-contained'/
  );
});

test('active files are replaced by one retried rename, never moved aside first', () => {
  const source = updaterSource.replace(/\r\n/g, '\n');
  for (const writer of ['writeActive', 'writeActiveQQMusicProfiles']) {
    const start = source.indexOf(`private async ${writer}(`);
    const end = source.indexOf('\n  }\n', start);
    assert.ok(start !== -1 && end > start, writer);
    const body = source.slice(start, end);
    assert.match(body, /await renameWithRetry\(temporaryPath, activePath\);/, writer);
    assert.doesNotMatch(body, /rename\(activePath|rm\(activePath|\.bak/, writer);
  }
});

function statusHarness(ids, catalogError = null) {
  // Exercise the actual public method with disk, network and signature I/O
  // replaced by strict fakes that reject work outside the requested scope.
  const updater = Object.create(inertModule.ConnectorUpdater.prototype);
  const reads = [];
  const validations = [];
  const refreshes = [];
  updater.readActive = async id => {
    assert.ok(ids.includes(id), `unexpected connector disk read: ${id}`);
    reads.push(id);
    return { id, version: '1.0.0' };
  };
  updater.loadQuarantine = async id => {
    assert.ok(ids.includes(id), `unexpected quarantine read: ${id}`);
    return [];
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

// The real catalog client (fetchCatalog, entry validation and makeStatus)
// with only Electron's net.fetch, the clock and disk reads replaced.
function v2Entry(id, version, runtime = 'win-x86') {
  const asset = `awoo-connector-${id}-${version}-${runtime}-framework-dependent.zip`;
  return {
    id,
    version,
    protocolVersion: 1,
    minimumCoreVersion: '1.1.10',
    playerVersionPolicy: 'stable',
    testedPlayerVersion: 'stable',
    package: {
      deployment: 'framework-dependent',
      runtime,
      runtimeChannel: '8.0',
      asset,
      size: 1024,
      sha256: 'a'.repeat(64),
      signature: 'c2lnbmF0dXJl',
      downloadUrl: `${V2_DOWNLOAD_URL_PREFIX}${id}/${version}/${asset}`
    }
  };
}

const catalogFixture = {
  schemaVersion: 2,
  publicKeyId: PUBLIC_KEY_ID,
  connectors: {
    netease: v2Entry('netease', '3.1.37.205354.9', 'win-x64'),
    kugou: v2Entry('kugou', '20.0.81.5'),
    qqmusic: v2Entry('qqmusic', '22.52.2'),
    folia: v2Entry('folia', '1.1.3', 'win-x64')
  }
};
const installedVersions = {
  netease: '3.1.37.205354.8',
  kugou: '20.0.81.4',
  qqmusic: '22.52.1',
  folia: '1.1.2'
};

function catalogResponse(catalog = catalogFixture) {
  return new Response(JSON.stringify(catalog), { status: 200 });
}

function fetchFailed(code) {
  return Object.assign(new TypeError('fetch failed'), { cause: { code } });
}

function catalogClient(respond, globals = {}) {
  const { time, FakeDate } = controlledClock(new Date(2026, 9, 21, 9, 0).getTime());
  const requests = [];
  const exported = loadUpdater({
    electron: {
      app: { getVersion: () => '1.2.6' },
      net: {
        fetch: async (url, init) => {
          requests.push({ url, init });
          return respond(url, init, requests.length);
        }
      }
    },
    './connector-catalog-policy.ts': catalogPolicy,
    './connector-version-policy': versionPolicy
  }, { Date: FakeDate, AbortController, setTimeout, clearTimeout, ...globals });
  const updater = Object.create(exported.ConnectorUpdater.prototype);
  Object.assign(updater, {
    updates: new Map(),
    progress: new Map(),
    quarantine: new Map(),
    onLog: () => {},
    sweepInstallDebris: async () => {},
    readActive: async id => ({ id, version: installedVersions[id] }),
    readQuarantine: async () => []
  });
  return { updater, requests, time };
}

test('concurrent status checks share one catalog request, forced or not', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { updater, requests } = catalogClient(async () => {
    await gate;
    return catalogResponse();
  });
  const checks = [
    updater.getStatuses(),
    updater.getStatuses(false, 'qqmusic'),
    updater.getStatuses(true)
  ];
  await settle();
  assert.equal(requests.length, 1);
  release();
  const [all, single, forced] = await Promise.all(checks);
  assert.deepEqual(Array.from(all, status => status.latestVersion),
    ['3.1.37.205354.9', '20.0.81.5', '22.52.2', '1.1.3']);
  assert.equal(single[0].latestVersion, '22.52.2');
  assert.ok(forced.every(status => status.error === null && status.stale === undefined));
  assert.equal(requests.length, 1);

  await updater.getStatuses();
  assert.equal(requests.length, 1, 'an unforced check reuses a fresh catalog');
  await updater.getStatuses(true);
  assert.equal(requests.length, 2, 'a forced check always asks the server');
});

test('the catalog is requested through Electron net.fetch without cache and only from v2', async () => {
  const { updater, requests } = catalogClient(() => { throw fetchFailed('ECONNRESET'); });
  await updater.getStatuses(true);
  await updater.getStatuses(true, 'kugou');
  assert.deepEqual(requests.map(request => request.url), [CATALOG_URL, CATALOG_URL]);
  const { init } = requests[0];
  assert.equal(init.method, 'GET');
  assert.equal(init.cache, 'no-store');
  assert.equal(init.headers.Accept, 'application/json');
  assert.equal(typeof init.signal?.aborted, 'boolean');
});

test('an unforced check repeats a recent failure for 45 s while forced checks retry', async () => {
  const { updater, requests, time } = catalogClient(() => { throw fetchFailed('ENOTFOUND'); });
  const first = await updater.getStatuses();
  assert.equal(requests.length, 1);
  for (const status of first) {
    assert.equal(status.error, '无法解析更新服务器地址，请检查网络或代理');
    assert.equal(status.latestVersion, null);
    assert.equal(status.stale, undefined);
  }

  time.now += 30_000;
  const repeated = await updater.getStatuses(false, 'qqmusic');
  assert.equal(repeated[0].error, '无法解析更新服务器地址，请检查网络或代理');
  assert.equal(requests.length, 1);
  await updater.getStatuses(true, 'qqmusic');
  assert.equal(requests.length, 2);

  time.now += 44_999;
  await updater.getStatuses();
  assert.equal(requests.length, 2);
  time.now += 1;
  await updater.getStatuses();
  assert.equal(requests.length, 3);
});

test('a failed check shows the last good catalog as stale, but a forced check surfaces the error', async () => {
  const { updater, requests, time } = catalogClient((_url, _init, count) => {
    if (count === 1) return catalogResponse();
    throw new Error('net::ERR_TIMED_OUT');
  });
  const fresh = await updater.getStatuses(true);
  assert.ok(fresh.every(status => status.error === null && status.stale === undefined));

  time.now += 6 * 60 * 1000;
  const stale = await updater.getStatuses();
  assert.equal(requests.length, 2);
  for (const status of stale) {
    assert.equal(status.stale, true);
    assert.equal(status.error, null);
    assert.equal(
      status.staleMessage,
      '更新检查失败：连接更新服务器超时；当前显示 09:00 获取的版本信息'
    );
  }
  const qq = stale.find(status => status.id === 'qqmusic');
  assert.equal(qq.latestVersion, '22.52.2');
  assert.equal(qq.updateAvailable, true);

  const [forced] = await updater.getStatuses(true, 'qqmusic');
  assert.equal(requests.length, 3);
  assert.equal(forced.error, '连接更新服务器超时');
  assert.equal(forced.stale, undefined);
  assert.equal(forced.latestVersion, null);
});

test('the catalog request is aborted after 10 s and reported as a timeout', async () => {
  let abortRequest = null;
  const { updater, requests } = catalogClient(
    (_url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    }),
    {
      setTimeout: (callback, milliseconds) => {
        if (milliseconds === 10_000) abortRequest = callback;
        return 0;
      },
      clearTimeout: () => {}
    }
  );
  const pending = updater.getStatuses(true, 'qqmusic');
  await settle();
  assert.equal(requests.length, 1);
  assert.equal(typeof abortRequest, 'function');
  abortRequest();
  const [status] = await pending;
  assert.equal(status.error, '连接更新服务器超时');
});

test('HTTP, unparseable and incompatible catalogs are reported without any fallback request', async () => {
  for (const [respond, message] of [
    [() => new Response('busy', { status: 503 }), '清单 HTTP 503'],
    [() => new Response('<!DOCTYPE html><title>登录</title>', { status: 200 }),
      '更新清单内容无法解析，可能被代理或网络登录页拦截'],
    [() => catalogResponse({ ...catalogFixture, schemaVersion: 1 }),
      '连接器 v2 更新清单格式或签名密钥标识不兼容'],
    [() => catalogResponse({ ...catalogFixture, publicKeyId: 'bilincm-connectors-2027-01' }),
      '连接器 v2 更新清单格式或签名密钥标识不兼容']
  ]) {
    const { updater, requests } = catalogClient(respond);
    const [status] = await updater.getStatuses(true, 'qqmusic');
    assert.equal(status.error, message);
    assert.deepEqual(requests.map(request => request.url), [CATALOG_URL]);
  }
});

test('a malformed entry fails only its own connector with the field-invalid message', async () => {
  const broken = structuredClone(catalogFixture);
  delete broken.connectors.qqmusic.package.downloadUrl;
  const { updater } = catalogClient(() => catalogResponse(broken));
  const statuses = await updater.getStatuses(true);
  assert.equal(
    statuses.find(status => status.id === 'qqmusic').error,
    'qqmusic v2 package framework-dependent 连接器清单字段无效'
  );
  assert.ok(statuses.filter(status => status.id !== 'qqmusic')
    .every(status => status.error === null));
});

test('a rolled-back latest version is reported as quarantined and is not auto-updatable', async () => {
  const { updater } = catalogClient(() => catalogResponse());
  updater.readQuarantine = async id => id === 'qqmusic'
    ? [{ connectorId: 'qqmusic', version: '22.52.2', at: '2026-10-21T01:00:00.000Z' }]
    : [];
  const statuses = await updater.getStatuses(true);
  const qq = statuses.find(status => status.id === 'qqmusic');
  assert.equal(qq.quarantined, true);
  assert.equal(qq.updateAvailable, true);
  assert.equal(qq.autoUpdateAvailable, false);
  assert.equal(qq.manualUpdateAvailable, false);
  const kugou = statuses.find(status => status.id === 'kugou');
  assert.equal(kugou.quarantined, false);
  assert.equal(kugou.autoUpdateAvailable, true);
  assert.equal(updater.isQuarantined('qqmusic', '22.52.2'), true);
  assert.equal(updater.isQuarantined('qqmusic', null), false);

  // A newer revision in the catalog is not held back by the old quarantine.
  const next = updater.makeStatus(
    'qqmusic',
    { id: 'qqmusic', version: '22.52.1' },
    v2Entry('qqmusic', '22.52.3'),
    new Date().toISOString(),
    null
  );
  assert.equal(next.quarantined, false);
  assert.equal(next.autoUpdateAvailable, true);
});

test('statuses carry the install progress only while the connector updates', () => {
  const { updater } = catalogClient(() => catalogResponse());
  const status = () => updater.makeStatus(
    'qqmusic',
    { id: 'qqmusic', version: '22.52.1' },
    v2Entry('qqmusic', '22.52.2'),
    new Date().toISOString(),
    null
  );
  assert.equal(status().progress, null);
  updater.updates.set('qqmusic', new Promise(() => {}));
  assert.equal(status().progress, null, 'updating before the first step');
  updater.reportProgress('qqmusic', 'download', 42);
  const { phase, percent, updatedAt } = status().progress;
  assert.deepEqual({ phase, percent }, { phase: 'download', percent: 42 });
  assert.equal(updatedAt, new Date(2026, 9, 21, 9, 0).toISOString());
  updater.reportProgress('qqmusic', 'verify');
  assert.equal(status().progress.percent, null);
  updater.updates.delete('qqmusic');
  assert.equal(status().progress, null);
});

// rollbackToPrevious() with fake active.json, health check and quarantine I/O.
const runtimeRoot = path.resolve('dotnet-runtimes', 'win-x86', '8.0.11');
const previousRecord = {
  version: '22.52.1',
  executable: path.resolve('player-connectors', 'qqmusic', '22.52.1', 'Awoo.Connector.QQMusic.exe'),
  deployment: 'framework-dependent',
  runtimeRid: 'win-x86',
  runtimeRoot
};
const badActive = {
  id: 'qqmusic',
  version: '22.52.2',
  executable: path.resolve('player-connectors', 'qqmusic', '22.52.2', 'Awoo.Connector.QQMusic.exe'),
  deployment: 'framework-dependent',
  runtimeRid: 'win-x86',
  runtimeRoot,
  activatedAt: '2026-10-21T01:00:00.000Z',
  previous: previousRecord
};

function rollbackHarness({ active = badActive, healthError = null, quarantineWriteError = null } = {}) {
  const guard = new UpdateInstallationGuard();
  const exported = loadUpdater({
    './update-announcements': { updateInstallationGuard: guard },
    'node:path': { default: path }
  });
  const updater = Object.create(exported.ConnectorUpdater.prototype);
  const calls = { prepared: [], writes: [], quarantineWrites: [], logs: [], reads: 0 };
  Object.assign(updater, {
    quarantine: new Map(),
    validatedExecutables: new Set(),
    onLog: message => calls.logs.push(message),
    readActive: async () => {
      calls.reads++;
      return active;
    },
    prepareRollbackTarget: async (id, previous) => {
      calls.prepared.push([id, previous]);
      assert.equal(guard.componentId, 'qqmusic', 'checked under the update lock');
      if (healthError) throw healthError;
      return { ...previous };
    },
    writeActive: async (id, value) => { calls.writes.push([id, value]); },
    readQuarantine: async () => [],
    writeQuarantine: async (id, entries) => {
      if (quarantineWriteError) throw quarantineWriteError;
      calls.quarantineWrites.push([id, entries]);
    }
  });
  return { updater, guard, calls };
}

test('a rollback activates the recorded previous version and pauses the bad one', async () => {
  const { updater, guard, calls } = rollbackHarness();
  const result = await updater.rollbackToPrevious('qqmusic');
  assert.deepEqual({ ...result }, {
    success: true,
    version: '22.52.1',
    message: 'QQ 音乐连接器已回退到 22.52.1'
  });
  assert.deepEqual(calls.prepared, [['qqmusic', previousRecord]]);
  assert.equal(calls.writes.length, 1);
  const [id, written] = calls.writes[0];
  assert.equal(id, 'qqmusic');
  assert.deepEqual(
    { ...written, activatedAt: undefined },
    { id: 'qqmusic', ...previousRecord, activatedAt: undefined }
  );
  assert.equal('previous' in written, false, 'a restored entry never nests a previous');
  assert.equal(calls.quarantineWrites.length, 1);
  assert.deepEqual(
    Array.from(calls.quarantineWrites[0][1], entry => [entry.connectorId, entry.version]),
    [['qqmusic', '22.52.2']]
  );
  assert.ok(updater.validatedExecutables.has(path.resolve(previousRecord.executable)));
  assert.equal(updater.isQuarantined('qqmusic', '22.52.2'), true);
  assert.equal(updater.isQuarantined('qqmusic', '22.52.1'), false);
  assert.match(calls.logs.at(-1), /已从 22\.52\.2 回退到 22\.52\.1，已暂停 22\.52\.2 的自动更新/);
  assert.equal(guard.componentId, null);
});

test('a rollback fails fast while another update holds the lock', async () => {
  const { updater, guard, calls } = rollbackHarness();
  const release = guard.acquire('netease');
  const result = await updater.rollbackToPrevious('qqmusic');
  assert.equal(result.success, false);
  assert.equal(result.message, '另一项更新正在进行，请完成后重试');
  assert.equal(calls.reads, 0);
  release();
});

test('without a usable previous version nothing is activated or paused', async () => {
  const cases = [
    [{ active: null }, /QQ 音乐连接器未安装，无法回退/],
    [{ active: { ...badActive, previous: undefined } }, /没有可回退的上一版本/],
    [{ active: { ...badActive, previous: { ...previousRecord, version: '22.52.2' } } }, /没有可回退的上一版本/],
    [{ healthError: new Error('qqmusic 连接器健康检查协议或版本不匹配') },
      /^QQ 音乐连接器回退失败：qqmusic 连接器健康检查协议或版本不匹配$/]
  ];
  for (const [options, message] of cases) {
    const { updater, guard, calls } = rollbackHarness(options);
    const result = await updater.rollbackToPrevious('qqmusic');
    assert.equal(result.success, false);
    assert.match(result.message, message);
    assert.deepEqual(calls.writes, []);
    assert.deepEqual(calls.quarantineWrites, []);
    assert.equal(updater.isQuarantined('qqmusic', '22.52.2'), false);
    assert.equal(guard.componentId, null);
  }
});

test('a quarantine that cannot be saved still holds for this process', async () => {
  const { updater, calls } = rollbackHarness({ quarantineWriteError: new Error('disk full') });
  const result = await updater.rollbackToPrevious('qqmusic');
  assert.equal(result.success, true);
  assert.equal(calls.writes.length, 1);
  assert.equal(updater.isQuarantined('qqmusic', '22.52.2'), true);
  assert.ok(calls.logs.some(message => /暂停记录保存失败.*disk full/.test(message)));
});

// The real recoverUnhealthyConnector() with every collaborator replaced.
function recoveryHarness(status) {
  const parsed = ts.createSourceFile('connector-updater.ts', updaterSource, ts.ScriptTarget.Latest, true);
  const declaration = parsed.statements.find(node => ts.isClassDeclaration(node)
    && node.name?.text === 'ConnectorUpdater');
  const method = declaration.members.find(node => ts.isMethodDeclaration(node)
    && node.name.getText(parsed) === 'recoverUnhealthyConnector');
  const context = vm.createContext({
    path,
    CONNECTOR_NAMES: { netease: '网易云音乐', kugou: '酷狗音乐', qqmusic: 'QQ 音乐', folia: 'Folia' },
    CONNECTOR_HEALTH_CHECK_RETRY_TIMEOUT_MS: 15000,
    getErrorMessage: error => error.message,
    describeAutomaticReinstallBlocker: installPolicy.describeAutomaticReinstallBlocker,
    validateConnectorExecutable: async () => { throw new Error('blocked by antivirus'); },
    getReinstallCircuitBreaker: () => { throw new Error('a reinstall must not be considered'); }
  });
  vm.runInContext(ts.transpileModule(
    `class Subject { ${method.getText(parsed)} } globalThis.Subject = Subject;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
  ).outputText, context);
  const updater = new context.Subject();
  const calls = { logs: [], reinstalls: 0 };
  Object.assign(updater, {
    validatedExecutables: new Set(),
    onLog: message => calls.logs.push(message),
    getStatuses: async () => [status],
    runUpdateWhenAvailable: async () => {
      calls.reinstalls++;
      return { success: true };
    }
  });
  return { updater, calls };
}

test('automatic repair never reinstalls from a stale catalog or into a rolled-back version', async () => {
  const healthy = {
    id: 'qqmusic',
    error: null,
    compatible: true,
    manualUpdateAvailable: false,
    latestVersion: '22.52.1',
    minimumCoreVersion: '1.1.10'
  };
  const active = {
    version: '22.52.1',
    executable: path.resolve('connector', 'Awoo.Connector.QQMusic.exe')
  };
  for (const [status, blocker] of [
    [{ ...healthy, stale: true, staleMessage: '更新检查失败：连接更新服务器超时；当前显示 09:00 获取的版本信息' },
      '更新检查失败：连接更新服务器超时；当前显示 09:00 获取的版本信息'],
    [{ ...healthy, latestVersion: '22.52.2', quarantined: true },
      '最新版本 22.52.2 已回退并暂停自动安装']
  ]) {
    const { updater, calls } = recoveryHarness(status);
    assert.equal(
      await updater.recoverUnhealthyConnector('qqmusic', active, {}, new Error('timeout')),
      active.executable
    );
    assert.equal(calls.reinstalls, 0);
    assert.equal(calls.logs.length, 1);
    assert.ok(calls.logs[0].includes(`当前无法安全重装（${blocker}），将直接尝试启动现有连接器`));
  }
});

// QQ profile resolution memo with the network step replaced.
function profileHarness({ isolated = false } = {}) {
  const { time, FakeDate } = controlledClock(1_000_000);
  const exported = loadUpdater({
    'node:path': { default: path },
    './dev-user-data-policy': devUserDataPolicy
  }, {
    Date: FakeDate,
    process: { env: isolated ? { AWOO_DEV_USER_DATA_DIR: path.resolve('isolated-data') } : {} }
  });
  const updater = Object.create(exported.ConnectorUpdater.prototype);
  const calls = [];
  const logs = [];
  const results = [];
  const connector = { version: '22.76.1' };
  Object.assign(updater, {
    onLog: message => logs.push(message),
    readActive: async () => ({ version: connector.version }),
    ensureQQMusicProfilesInternal: async () => {
      calls.push(connector.version);
      const next = results.shift();
      if (next instanceof Error) throw next;
      return next ?? null;
    }
  });
  return { updater, calls, logs, results, time, connector };
}

const profileDirectory = version => path.resolve('player-connectors', 'qqmusic', 'profiles', version);

test('one connector start resolves QQ profiles once; the result is kept 30 min per connector version', async () => {
  const { updater, calls, results, time, connector } = profileHarness();
  results.push(profileDirectory('1.4.0'), profileDirectory('1.4.0'), profileDirectory('1.5.0'));
  const [validation, launch] = await Promise.all([
    updater.ensureQQMusicProfiles(),
    updater.ensureQQMusicProfiles()
  ]);
  assert.equal(validation, profileDirectory('1.4.0'));
  assert.equal(launch, profileDirectory('1.4.0'));
  assert.equal(await updater.ensureQQMusicProfiles(), profileDirectory('1.4.0'));
  assert.equal(calls.length, 1);

  time.now += 30 * 60 * 1000 - 1;
  await updater.ensureQQMusicProfiles();
  assert.equal(calls.length, 1);
  time.now += 1;
  assert.equal(await updater.ensureQQMusicProfiles(), profileDirectory('1.4.0'));
  assert.equal(calls.length, 2);

  connector.version = '22.77.1';
  assert.equal(await updater.ensureQQMusicProfiles(), profileDirectory('1.5.0'));
  assert.equal(calls.length, 3);
});

test('a failed QQ profile check is repeated for 45 s instead of waiting for the network again', async () => {
  const { updater, calls, results, time } = profileHarness();
  results.push(new Error('连接更新服务器超时'), profileDirectory('1.4.0'));
  await assert.rejects(updater.ensureQQMusicProfiles(), /连接更新服务器超时/);
  time.now += 44_999;
  await assert.rejects(updater.ensureQQMusicProfiles(), /连接更新服务器超时/);
  assert.equal(calls.length, 1);
  time.now += 1;
  assert.equal(await updater.ensureQQMusicProfiles(), profileDirectory('1.4.0'));
  assert.equal(calls.length, 2);
});

test('a QQ profile refresh bypasses the memo and reports only a newly active directory', async () => {
  const { updater, calls, logs, results } = profileHarness();
  results.push(
    profileDirectory('1.4.0'),
    profileDirectory('1.4.0'),
    profileDirectory('1.5.0'),
    new Error('连接更新服务器超时'),
    null
  );
  await updater.ensureQQMusicProfiles();
  assert.deepEqual({ ...await updater.refreshQQMusicProfiles() }, { changed: false, version: '1.4.0' });
  assert.equal(calls.length, 2);
  assert.deepEqual({ ...await updater.refreshQQMusicProfiles() }, { changed: true, version: '1.5.0' });
  assert.equal(await updater.ensureQQMusicProfiles(), profileDirectory('1.5.0'), 'the next launch uses it');
  assert.equal(calls.length, 3);

  assert.deepEqual({ ...await updater.refreshQQMusicProfiles() }, { changed: false, version: null });
  assert.ok(logs.some(message => /刷新在线画像失败，继续使用连接器内置画像：连接更新服务器超时/.test(message)));
  assert.deepEqual({ ...await updater.refreshQQMusicProfiles() }, { changed: false, version: null });
  assert.equal(calls.length, 5);
});

test('isolated development never refreshes QQ profiles', async () => {
  const { updater, calls } = profileHarness({ isolated: true });
  assert.deepEqual({ ...await updater.refreshQQMusicProfiles() }, { changed: false, version: null });
  assert.equal(calls.length, 0);
});

// The real installer in a temporary user-data directory. Only the network,
// the private runtime download, zip extraction, the connector process and the
// player process query are replaced; files, active.json, quarantine.json and
// the checks are real.
function installerHarness(t, {
  packageResponse = null,
  stagedExecutable = null,
  connectorId = 'qqmusic',
  latest = '22.52.2'
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awoo-connector-updater-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userData = path.join(root, 'userData');
  const connectorRoot = path.join(userData, 'player-connectors', connectorId);
  const activePath = path.join(connectorRoot, 'active.json');
  const quarantinePath = path.join(connectorRoot, 'quarantine.json');
  const executableName = brandingPolicy.AWOO_CONNECTOR_EXECUTABLE_NAMES[connectorId];
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const guard = new UpdateInstallationGuard();
  const state = { latest };
  const archives = new Map();
  const requests = [];
  const receipts = [];
  const logs = [];
  // What the player process query answers, and the connector root at the
  // moment each query ran.
  const player = { running: false, querySucceeded: true };
  const processChecks = [];

  function release(version) {
    const archive = Buffer.from(`connector ${version}`);
    const asset = `awoo-connector-${connectorId}-${version}-win-x86-framework-dependent.zip`;
    archives.set(asset, archive);
    return {
      id: connectorId,
      version,
      protocolVersion: 1,
      minimumCoreVersion: '1.1.10',
      playerVersionPolicy: '22.*',
      testedPlayerVersion: '22.52',
      package: {
        deployment: 'framework-dependent',
        runtime: 'win-x86',
        runtimeChannel: '8.0',
        asset,
        size: archive.length,
        sha256: crypto.createHash('sha256').update(archive).digest('hex'),
        signature: crypto.sign(null, archive, privateKey).toString('base64'),
        downloadUrl: `${V2_DOWNLOAD_URL_PREFIX}${connectorId}/${version}/${asset}`
      }
    };
  }

  async function fetchImpl(url) {
    requests.push(url);
    if (url === CATALOG_URL) {
      return catalogResponse({
        schemaVersion: 2,
        publicKeyId: PUBLIC_KEY_ID,
        connectors: { [connectorId]: release(state.latest) }
      });
    }
    const override = packageResponse?.(url);
    if (override) return override;
    const archive = archives.get(path.basename(new URL(url).pathname));
    return archive ? new Response(archive, { status: 200 }) : new Response('missing', { status: 404 });
  }

  class FakeRuntimeManager {
    constructor(options) {
      this.rootDirectory = options.rootDirectory;
    }

    async ensure(rid) {
      const directory = path.join(this.rootDirectory, rid, '8.0.11');
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'dotnet.exe'), '');
      return directory;
    }

    async sweepStaleDebris() {}
  }

  // A connector answers the health-check ping with the version written into
  // its executable; the text 'broken' answers with a protocol failure.
  function spawn(executable) {
    const child = new EventEmitter();
    const version = fs.readFileSync(executable, 'utf8');
    Object.assign(child, {
      pid: 4242,
      killed: false,
      exitCode: null,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill() {
        child.killed = true;
        setImmediate(() => child.emit('exit', null));
        return true;
      },
      stdin: {
        write(line) {
          const request = JSON.parse(line);
          if (request.action === 'ping') {
            child.stdout.write(`${JSON.stringify(version === 'broken'
              ? { id: request.id, ok: false }
              : {
                id: request.id,
                ok: true,
                result: { protocolVersion: 1, connectorId, connectorVersion: version }
              })}\n`);
          } else if (request.action === 'shutdown') {
            setImmediate(() => {
              child.exitCode = 0;
              child.emit('exit', 0);
            });
          }
          return true;
        }
      }
    });
    return child;
  }

  const exported = loadUpdater({
    electron: {
      app: { getVersion: () => '1.2.6', getPath: () => userData },
      net: { fetch: fetchImpl }
    },
    'node:crypto': { default: crypto },
    'node:fs': { default: fs },
    'node:path': { default: path },
    'node:child_process': { spawn },
    './safe-zip.ts': {
      extractZipSafely: async (archivePath, stagingDirectory) => {
        const version = fs.readFileSync(archivePath, 'utf8').replace('connector ', '');
        fs.mkdirSync(stagingDirectory, { recursive: true });
        fs.writeFileSync(
          path.join(stagingDirectory, executableName),
          stagedExecutable ?? version
        );
      }
    },
    './player-process-inspector': {
      inspectPlayerProcess: async id => {
        processChecks.push({ id, entries: fs.readdirSync(connectorRoot).sort() });
        return {
          running: player.running,
          processId: player.running ? 4343 : null,
          version: null,
          executablePath: null,
          querySucceeded: player.querySucceeded
        };
      }
    },
    './connector-download': connectorDownload,
    './private-dotnet-runtime': {
      PrivateDotnetRuntimeManager: FakeRuntimeManager,
      buildPrivateDotnetEnvironment
    },
    './connector-version-policy': versionPolicy,
    './connector-branding-policy': brandingPolicy,
    './netease-update-process': {
      NeteaseUpdateProcessController: class {},
      NeteaseProcessControlError: class extends Error {},
      isTransientNeteaseFileLock: () => false
    },
    './connector-release-url': releaseUrl,
    './dev-user-data-policy': devUserDataPolicy,
    './update-announcements': {
      updateInstallationGuard: guard,
      reportCompletedConnectorUpdate: async (...args) => { receipts.push(args); }
    },
    './connector-install-policy.ts': installPolicy,
    './fs-retry.ts': fsRetry,
    './connector-catalog-policy.ts': {
      ...catalogPolicy,
      // The installer relies on the pinned production key; only the fixture
      // signer is substituted at this boundary, never the checks themselves.
      verifyConnectorArchive: (...args) => {
        assert.equal(args.length, 2, 'the installer never supplies its own key');
        catalogPolicy.verifyConnectorArchive(args[0], args[1], publicKey);
      }
    }
  }, {
    process: { env: {}, pid: process.pid, platform: process.platform },
    Buffer,
    URL,
    AbortController,
    setTimeout,
    clearTimeout
  });

  const createUpdater = (neteaseProcessController = {
    stopForConnectorUpdate: async () => ({ wasRunning: false }),
    restartAfterConnectorUpdate: async () => {}
  }) => new exported.ConnectorUpdater(
    message => logs.push(message),
    neteaseProcessController
  );

  function installVersion(version, { executableName: name = executableName, selfContained = false } = {}) {
    const executable = path.join(connectorRoot, version, name);
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, version);
    const runtime = path.join(userData, 'dotnet-runtimes', 'win-x86', '8.0.11');
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, 'dotnet.exe'), '');
    fs.writeFileSync(activePath, JSON.stringify({
      id: connectorId,
      version,
      executable,
      ...(selfContained
        ? {}
        : { deployment: 'framework-dependent', runtimeRid: 'win-x86', runtimeRoot: runtime }),
      activatedAt: '2026-10-01T00:00:00.000Z'
    }));
    return { executable, runtimeRoot: runtime };
  }

  return {
    createUpdater,
    installVersion,
    state,
    guard,
    requests,
    receipts,
    logs,
    player,
    processChecks,
    userData,
    connectorRoot,
    activePath,
    quarantinePath
  };
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

test('an update records the replaced version; a rollback restores it and pauses the bad version', async t => {
  const harness = installerHarness(t);
  const installed = harness.installVersion('22.52.1');
  const updater = harness.createUpdater();
  const phases = [];
  const reportProgress = updater.reportProgress;
  updater.reportProgress = function (...args) {
    phases.push(args[1]);
    return reportProgress.apply(this, args);
  };

  const result = await updater.update('qqmusic');
  assert.equal(result.success, true, result.message);
  assert.equal(result.updated, true);
  const active = readJson(harness.activePath);
  assert.equal(active.version, '22.52.2');
  assert.equal(active.deployment, 'framework-dependent');
  assert.deepEqual(active.previous, {
    version: '22.52.1',
    executable: installed.executable,
    deployment: 'framework-dependent',
    runtimeRid: 'win-x86',
    runtimeRoot: installed.runtimeRoot
  });
  assert.ok(fs.existsSync(installed.executable), 'the replaced version directory is kept');
  assert.deepEqual([...new Set(phases)], ['runtime', 'download', 'verify', 'install']);
  assert.equal(updater.progress.size, 0, 'progress is cleared when the update settles');
  assert.deepEqual(harness.receipts, [['qqmusic', 'QQ 音乐连接器', '22.52.1', '22.52.2']]);

  const rollback = await updater.rollbackToPrevious('qqmusic');
  assert.deepEqual({ ...rollback }, {
    success: true,
    version: '22.52.1',
    message: 'QQ 音乐连接器已回退到 22.52.1'
  });
  const restored = readJson(harness.activePath);
  assert.equal(restored.version, '22.52.1');
  assert.equal(restored.executable, installed.executable);
  assert.equal(restored.runtimeRoot, installed.runtimeRoot);
  assert.equal('previous' in restored, false);
  assert.deepEqual(
    readJson(harness.quarantinePath).entries.map(entry => [entry.connectorId, entry.version]),
    [['qqmusic', '22.52.2']]
  );
  assert.ok(fs.existsSync(path.join(harness.connectorRoot, '22.52.2')), 'no version directory is deleted');
  assert.equal(harness.guard.componentId, null);

  const [status] = await updater.getStatuses(false, 'qqmusic');
  assert.equal(status.currentVersion, '22.52.1');
  assert.equal(status.latestVersion, '22.52.2');
  assert.equal(status.quarantined, true);
  assert.equal(status.updateAvailable, true);
  assert.equal(status.autoUpdateAvailable, false);

  const automatic = await updater.update('qqmusic');
  assert.equal(automatic.success, false);
  assert.match(automatic.message, /22\.52\.2 已在本机回退并暂停自动更新/);
  assert.equal(readJson(harness.activePath).version, '22.52.1');
  assert.match((await updater.rollbackToPrevious('qqmusic')).message, /没有可回退的上一版本/);

  // The next process reads the pause from disk; a confirmed update lifts it.
  const nextProcess = harness.createUpdater();
  assert.equal((await nextProcess.getStatuses(false, 'qqmusic'))[0].quarantined, true);
  const confirmed = await nextProcess.update('qqmusic', true);
  assert.equal(confirmed.success, true, confirmed.message);
  const reactivated = readJson(harness.activePath);
  assert.equal(reactivated.version, '22.52.2');
  assert.equal(reactivated.previous.version, '22.52.1');
  assert.equal(fs.existsSync(harness.quarantinePath), false);
  assert.equal((await nextProcess.getStatuses(false, 'qqmusic'))[0].quarantined, false);
});

test('a previous version that lost its files or fails its health check is never activated', async t => {
  const harness = installerHarness(t);
  const installed = harness.installVersion('22.52.1');
  const updater = harness.createUpdater();
  assert.equal((await updater.update('qqmusic')).success, true);

  fs.writeFileSync(installed.executable, 'broken');
  const unhealthy = await updater.rollbackToPrevious('qqmusic');
  assert.equal(unhealthy.success, false);
  assert.match(unhealthy.message, /^QQ 音乐连接器回退失败：qqmusic 连接器健康检查协议或版本不匹配/);
  fs.rmSync(path.dirname(installed.executable), { recursive: true, force: true });
  const missing = await updater.rollbackToPrevious('qqmusic');
  assert.equal(missing.message, 'QQ 音乐连接器回退失败：上一版本的文件已不完整');

  assert.equal(readJson(harness.activePath).version, '22.52.2');
  assert.equal(fs.existsSync(harness.quarantinePath), false);
  assert.equal(harness.guard.componentId, null);
});

test('an existing SelfContained install stays launchable, replaceable and recoverable', async t => {
  const harness = installerHarness(t);
  const legacy = harness.installVersion('22.51.3', {
    executableName: 'BiliNCM.Connector.QQMusic.exe',
    selfContained: true
  });
  const updater = harness.createUpdater();
  const active = await updater.readActive('qqmusic');
  assert.equal(active.deployment, 'self-contained');
  assert.equal(active.executable, legacy.executable);
  assert.equal(active.runtimeRoot, undefined);

  // 22.51 → 22.52 is a player branch change and needs the user's confirmation.
  const result = await updater.update('qqmusic', true);
  assert.equal(result.success, true, result.message);
  assert.deepEqual(readJson(harness.activePath).previous, {
    version: '22.51.3',
    executable: legacy.executable,
    deployment: 'self-contained'
  });
  assert.equal((await updater.rollbackToPrevious('qqmusic')).success, true);
  const restored = await updater.readActive('qqmusic');
  assert.equal(restored.version, '22.51.3');
  assert.equal(restored.deployment, 'self-contained');
  assert.equal(restored.executable, legacy.executable);
});

test('active.json outside its version directory or private runtime is not trusted', async t => {
  const harness = installerHarness(t);
  const installed = harness.installVersion('22.52.1');
  const updater = harness.createUpdater();
  const original = readJson(harness.activePath);
  const outside = path.join(harness.userData, 'Awoo.Connector.QQMusic.exe');
  fs.writeFileSync(outside, '22.52.1');
  const foreignRuntime = path.join(harness.userData, 'elsewhere', 'win-x86', '8.0.11');
  fs.mkdirSync(foreignRuntime, { recursive: true });
  fs.writeFileSync(path.join(foreignRuntime, 'dotnet.exe'), '');
  for (const changes of [
    { executable: outside },
    { executable: path.join(path.dirname(installed.executable), 'other.exe') },
    { runtimeRoot: foreignRuntime },
    { runtimeRid: 'win-arm64' },
    { deployment: 'portable' },
    { version: '22.52' },
    { id: 'kugou' }
  ]) {
    fs.writeFileSync(harness.activePath, JSON.stringify({ ...original, ...changes }));
    assert.equal(await updater.readActive('qqmusic'), null, JSON.stringify(changes));
  }
});

test('a failed proxy download retries the same signed asset on GitHub; a failed health check does not', async t => {
  const asset = 'awoo-connector-qqmusic-22.52.2-win-x86-framework-dependent.zip';
  const proxied = installerHarness(t, {
    packageResponse: url => url.startsWith(V2_DOWNLOAD_URL_PREFIX)
      ? new Response('gone', { status: 404 })
      : null
  });
  proxied.installVersion('22.52.1');
  const result = await proxied.createUpdater().update('qqmusic');
  assert.equal(result.success, true, result.message);
  assert.deepEqual(proxied.requests.filter(url => url !== CATALOG_URL), [
    `${V2_DOWNLOAD_URL_PREFIX}qqmusic/22.52.2/${asset}`,
    `https://github.com/Enkianssus/awoo-connectors/releases/download/qqmusic-v22.52.2/${asset}`
  ]);
  assert.equal(readJson(proxied.activePath).version, '22.52.2');

  const broken = installerHarness(t, { stagedExecutable: 'broken' });
  broken.installVersion('22.52.1');
  const failed = await broken.createUpdater().update('qqmusic');
  assert.equal(failed.success, false);
  assert.match(failed.message, /健康检查协议或版本不匹配/);
  assert.equal(broken.requests.some(url => url.includes('github.com')), false);
  assert.equal(readJson(broken.activePath).version, '22.52.1');
  assert.equal(fs.existsSync(path.join(broken.connectorRoot, '22.52.2')), false);
});

// NetEase may hold the CEF bridge DLL of an earlier connector, so replacing
// one closes and reopens NetEase, but only for an update the user asked for.
const NETEASE_OLD = '3.1.37.205354.8';
const NETEASE_NEW = '3.1.37.205354.9';

function neteaseController(actions) {
  return {
    stopForConnectorUpdate: async () => {
      actions.push('stop');
      return { wasRunning: true, executablePath: 'C:\\NetEase\\cloudmusic.exe', processIds: [4343] };
    },
    restartAfterConnectorUpdate: async () => { actions.push('restart'); }
  };
}

test('an automatic NetEase update never closes a NetEase opened during the download; it is deferred', async t => {
  const harness = installerHarness(t, { connectorId: 'netease', latest: NETEASE_NEW });
  harness.installVersion(NETEASE_OLD);
  const actions = [];
  const updater = harness.createUpdater(neteaseController(actions));
  // Planning saw NetEase closed; the streamer opened it while the package downloaded.
  harness.player.running = true;

  const deferred = await updater.update('netease', false, { automatic: true });
  assert.deepEqual({
    success: deferred.success,
    updated: deferred.updated,
    deferred: deferred.deferred,
    message: deferred.message,
    error: deferred.status.error
  }, {
    success: false,
    updated: false,
    deferred: true,
    message: '网易云正在运行，连接器更新将在网易云关闭后自动应用',
    error: null
  });
  assert.deepEqual(actions, [], 'NetEase is neither closed nor restarted');
  // Checked once, right before replacement: the package was downloaded,
  // extracted and health-checked, and nothing was moved yet.
  assert.equal(harness.processChecks.length, 1);
  assert.equal(harness.processChecks[0].id, 'netease');
  assert.ok(harness.processChecks[0].entries.some(name => name.startsWith('.staging-')));
  assert.ok(harness.requests.some(url => url.startsWith(V2_DOWNLOAD_URL_PREFIX)));
  // Nothing was activated and nothing was left behind.
  assert.equal(readJson(harness.activePath).version, NETEASE_OLD);
  assert.deepEqual(fs.readdirSync(harness.connectorRoot).sort(), [NETEASE_OLD, 'active.json']);
  assert.deepEqual(harness.receipts, []);
  assert.equal(harness.logs.some(message => message.includes('安装失败')), false, 'not a failure');
  assert.equal(updater.progress.size, 0);
  assert.equal(harness.guard.componentId, null);

  // A process query that fails counts as running.
  Object.assign(harness.player, { running: false, querySucceeded: false });
  assert.equal((await updater.update('netease', false, { automatic: true })).deferred, true);
  assert.equal(readJson(harness.activePath).version, NETEASE_OLD);

  // Once NetEase is closed, the same automatic update applies without touching it.
  harness.player.querySucceeded = true;
  const applied = await updater.update('netease', false, { automatic: true });
  assert.equal(applied.success, true, applied.message);
  assert.equal(applied.updated, true);
  assert.equal(applied.deferred, undefined);
  assert.equal(applied.neteasePlayerWasRunning, false);
  assert.deepEqual(actions, []);
  assert.equal(readJson(harness.activePath).version, NETEASE_NEW);
  assert.deepEqual(harness.receipts, [['netease', '网易云音乐连接器', NETEASE_OLD, NETEASE_NEW]]);
});

test('an update the user asked for still closes and reopens a running NetEase', async t => {
  const harness = installerHarness(t, { connectorId: 'netease', latest: NETEASE_NEW });
  harness.installVersion(NETEASE_OLD);
  const actions = [];
  harness.player.running = true;
  const result = await harness.createUpdater(neteaseController(actions)).update('netease', true);
  assert.equal(result.success, true, result.message);
  assert.deepEqual(actions, ['stop', 'restart']);
  assert.equal(result.neteasePlayerWasRunning, true);
  assert.equal(result.neteasePlayerRestarted, true);
  assert.equal(harness.processChecks.length, 0, 'no automatic-only check');
  assert.equal(readJson(harness.activePath).version, NETEASE_NEW);
});

test('NetEase is closed for any earlier connector on disk, even one whose active.json no longer resolves', async t => {
  const cases = [
    ['first install', () => {}, []],
    ['only install debris', harness => {
      fs.mkdirSync(path.join(harness.connectorRoot, `.staging-${NETEASE_OLD}-0123456789abcdef`), { recursive: true });
    }, []],
    ['active.json whose version directory is gone', harness => {
      fs.rmSync(path.dirname(harness.installVersion(NETEASE_OLD).executable), { recursive: true });
    }, ['stop', 'restart']],
    ['version directory without active.json', harness => {
      harness.installVersion(NETEASE_OLD);
      fs.rmSync(harness.activePath);
    }, ['stop', 'restart']],
    ['missing private runtime', harness => {
      fs.rmSync(path.join(harness.installVersion(NETEASE_OLD).runtimeRoot, 'dotnet.exe'));
    }, ['stop', 'restart']],
    ['unreadable active.json', harness => {
      harness.installVersion(NETEASE_OLD);
      fs.writeFileSync(harness.activePath, '{');
    }, ['stop', 'restart']]
  ];
  for (const [label, prepare, expected] of cases) {
    const harness = installerHarness(t, { connectorId: 'netease', latest: NETEASE_NEW });
    prepare(harness);
    const actions = [];
    const updater = harness.createUpdater(neteaseController(actions));
    assert.equal(await updater.readActive('netease'), null, `${label}: nothing reads as installed`);
    const result = await updater.update('netease', true);
    assert.equal(result.success, true, `${label}: ${result.message}`);
    assert.deepEqual(actions, expected, label);
    assert.equal(readJson(harness.activePath).version, NETEASE_NEW, label);
  }

  // Such a leftover also defers an automatic install while NetEase runs.
  const harness = installerHarness(t, { connectorId: 'netease', latest: NETEASE_NEW });
  harness.installVersion(NETEASE_OLD);
  fs.rmSync(harness.activePath);
  harness.player.running = true;
  const actions = [];
  const deferred = await harness.createUpdater(neteaseController(actions))
    .update('netease', false, { automatic: true });
  assert.equal(deferred.deferred, true);
  assert.deepEqual(actions, []);
  assert.deepEqual(fs.readdirSync(harness.connectorRoot), [NETEASE_OLD]);
});
