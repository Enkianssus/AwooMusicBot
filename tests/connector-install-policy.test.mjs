import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {
  ConnectorDownloadError,
  createFailureMemo,
  createProgressLogThrottle,
  createReinstallCircuitBreaker,
  describeAutomaticReinstallBlocker,
  isConnectorDownloadError,
  isRetryableHttpStatus
} from '../electron/connector-install-policy.ts';

const MINUTE = 60 * 1000;

test('reinstall breaker allows one attempt per window and three per session', () => {
  const breaker = createReinstallCircuitBreaker();
  const key = 'netease@3.1.37.205354.9';
  assert.equal(breaker.allow(key, 0), true);
  breaker.record(key, 0);
  assert.equal(breaker.allow(key, 10 * MINUTE - 1), false);
  assert.equal(breaker.allow('kugou@20.0.81.5', 1), true, 'keys are independent');
  assert.equal(breaker.allow(key, 10 * MINUTE), true);
  breaker.record(key, 10 * MINUTE);
  assert.equal(breaker.allow(key, 20 * MINUTE), true);
  breaker.record(key, 20 * MINUTE);
  assert.equal(breaker.allow(key, 24 * 60 * MINUTE), false, 'session limit reached');
});

test('reinstall breaker honours custom window and limit', () => {
  const breaker = createReinstallCircuitBreaker({ windowMs: 1000, sessionLimit: 1 });
  assert.equal(breaker.allow('qqmusic@22.52.1', 0), true);
  breaker.record('qqmusic@22.52.1', 0);
  assert.equal(breaker.allow('qqmusic@22.52.1', 5000), false);
  assert.equal(createReinstallCircuitBreaker({ sessionLimit: 0 }).allow('x', 0), false);
});

test('failure memo repeats an error until its TTL expires', () => {
  const memo = createFailureMemo(60_000);
  const error = new Error('catalog unavailable');
  assert.equal(memo.get('qqmusic', 0), null);
  memo.set('qqmusic', error, 1000);
  assert.equal(memo.get('qqmusic', 60_999), error);
  assert.equal(memo.get('kugou', 2000), null);
  assert.equal(memo.get('qqmusic', 61_000), null);
  assert.equal(memo.get('qqmusic', 1000), null, 'an expired entry is removed');
  memo.set('qqmusic', error, 0);
  memo.clear('qqmusic');
  assert.equal(memo.get('qqmusic', 1), null);
});

test('download errors are recognized across vm realms by name', () => {
  const source = fs.readFileSync(
    new URL('../electron/connector-install-policy.ts', import.meta.url),
    'utf8'
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const foreign = { exports: {} };
  vm.runInNewContext(compiled, { module: foreign, exports: foreign.exports });
  const error = new foreign.exports.ConnectorDownloadError('http', '下载 HTTP 404', 404);

  assert.equal(error instanceof ConnectorDownloadError, false);
  assert.equal(error instanceof Error, false);
  assert.equal(isConnectorDownloadError(error), true);
  assert.equal(error.kind, 'http');
  assert.equal(error.status, 404);

  const local = new ConnectorDownloadError('signature', 'Ed25519 签名校验失败');
  assert.equal(local instanceof Error, true);
  assert.equal(local.name, 'ConnectorDownloadError');
  assert.equal(local.status, undefined);
  assert.equal(isConnectorDownloadError(local), true);
  for (const value of [new Error('x'), vm.runInNewContext('new Error("x")'), null, undefined, 'x']) {
    assert.equal(isConnectorDownloadError(value), false);
  }
});

test('only timeouts, rate limits and server errors are retryable HTTP statuses', () => {
  for (const status of [408, 429, 500, 502, 503, 504, 599]) {
    assert.equal(isRetryableHttpStatus(status), true, String(status));
  }
  for (const status of [200, 206, 400, 401, 403, 404, 410, 416]) {
    assert.equal(isRetryableHttpStatus(status), false, String(status));
  }
});

test('reinstall blockers mirror the update checks that would refuse a reinstall', () => {
  const healthy = {
    error: null,
    compatible: true,
    manualUpdateAvailable: false,
    latestVersion: '22.52.2',
    minimumCoreVersion: '1.1.10'
  };
  assert.equal(describeAutomaticReinstallBlocker(healthy), null);
  assert.match(describeAutomaticReinstallBlocker(null), /未找到/);
  assert.match(
    describeAutomaticReinstallBlocker({ ...healthy, error: 'fetch failed' }),
    /更新检查失败：fetch failed/
  );
  assert.match(
    describeAutomaticReinstallBlocker({ ...healthy, compatible: false, minimumCoreVersion: '1.3.0' }),
    /要求嗷呜点歌机 1\.3\.0 或更高版本/
  );
  assert.match(
    describeAutomaticReinstallBlocker({ ...healthy, manualUpdateAvailable: true }),
    /新的播放器版本分支/
  );
});

test('progress logs are limited to 25% steps and always include completion', () => {
  const shouldLog = createProgressLogThrottle();
  const logged = [1, 10, 24, 25, 26, 49, 50, 80, 99, 100, 100]
    .filter((percent, index) => shouldLog(percent, index));
  assert.deepEqual(logged, [25, 50, 80, 100]);

  const twoChunks = createProgressLogThrottle();
  assert.deepEqual([66, 100].filter(percent => twoChunks(percent, 0)), [66, 100]);
});

test('progress logs of an unknown total are at least 5 s apart', () => {
  const shouldLog = createProgressLogThrottle();
  const times = [0, 1000, 4999, 5000, 7000, 10_000];
  assert.deepEqual(
    times.filter(now => shouldLog(null, now)),
    [0, 5000, 10_000]
  );
  assert.equal(shouldLog(100, 10_001), true, 'completion is logged immediately');
  assert.equal(shouldLog(null, 20_000), false, 'nothing is logged after completion');
});

// The real ensureInstalled() recovery paths run with every collaborator that
// would spawn a connector, read the disk or use the network replaced.
const updaterSource = fs.readFileSync(
  new URL('../electron/connector-updater.ts', import.meta.url),
  'utf8'
);
const updaterFile = ts.createSourceFile(
  'connector-updater.ts', updaterSource, ts.ScriptTarget.Latest, true
);
const updaterClass = updaterFile.statements.find(node => ts.isClassDeclaration(node)
  && node.name?.text === 'ConnectorUpdater');
assert.ok(updaterClass);
const ensureMethods = ['ensureInstalled', 'recoverUnhealthyConnector', 'installMissingConnector']
  .map(name => {
    const method = updaterClass.members.find(node => ts.isMethodDeclaration(node)
      && node.name.getText(updaterFile) === name);
    assert.ok(method, name);
    return method.getText(updaterFile);
  })
  .join('\n');
const compiledEnsureMethods = ts.transpileModule(
  `class Subject { ${ensureMethods} } globalThis.Subject = Subject;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
).outputText;

const healthyStatus = {
  id: 'qqmusic',
  error: null,
  compatible: true,
  manualUpdateAvailable: false,
  latestVersion: '22.52.1',
  minimumCoreVersion: '1.1.10'
};

function ensureHarness({
  active = { version: '22.52.1', executable: path.resolve('connector', 'Awoo.Connector.QQMusic.exe') },
  healthChecks = [],
  status = healthyStatus,
  updateResults = [],
  reinstallResults = []
} = {}) {
  const clock = { now: 1_000_000 };
  const calls = { health: [], statuses: [], update: 0, reinstall: 0 };
  const logs = [];
  const breaker = createReinstallCircuitBreaker();
  const firstInstallFailures = createFailureMemo(60_000);
  const context = vm.createContext({
    process: { env: {} },
    path,
    Date: { now: () => clock.now },
    shouldRunAutomaticConnectorMaintenance: () => true,
    CONNECTOR_NAMES: { netease: '网易云音乐', kugou: '酷狗音乐', qqmusic: 'QQ 音乐', folia: 'Folia' },
    CONNECTOR_HEALTH_CHECK_RETRY_TIMEOUT_MS: 15000,
    getErrorMessage: error => error?.message ?? String(error),
    describeAutomaticReinstallBlocker,
    getReinstallCircuitBreaker: () => breaker,
    getFirstInstallFailures: () => firstInstallFailures,
    validateConnectorExecutable: async (_executable, _id, _version, _environment, timeoutMs) => {
      calls.health.push(timeoutMs ?? 'default');
      const failure = healthChecks.length ? healthChecks.shift() : 'still blocked';
      if (failure) throw new Error(failure);
    }
  });
  vm.runInContext(compiledEnsureMethods, context);
  const updater = new context.Subject();
  let installed = active;
  Object.assign(updater, {
    validatedExecutables: new Set(),
    onLog: message => logs.push(message),
    readActive: async () => installed,
    resolve: async () => installed?.executable || null,
    getLaunchEnvironment: async () => ({}),
    getStatuses: async (forceRefresh, id) => {
      calls.statuses.push([forceRefresh, id]);
      if (status instanceof Error) throw status;
      return [status];
    },
    runUpdateWhenAvailable: async (id, force) => {
      const result = (force ? reinstallResults : updateResults).shift()
        || { success: false, message: '安装失败：offline' };
      if (force) calls.reinstall++;
      else calls.update++;
      if (result.success) {
        installed = { version: '22.52.1', executable: path.resolve('connector', `${id}.exe`) };
      }
      return result;
    }
  });
  return { updater, calls, logs, clock, setActive: value => { installed = value; } };
}

test('a slow health check is retried once with 15 s before any repair', async () => {
  const harness = ensureHarness({ healthChecks: ['连接器启动健康检查超时', null] });
  const validated = harness.updater.validatedExecutables;
  assert.equal(await harness.updater.ensureInstalled('qqmusic'), path.resolve('connector', 'Awoo.Connector.QQMusic.exe'));
  assert.deepEqual(harness.calls.health, ['default', 15000]);
  assert.deepEqual(harness.calls.statuses, []);
  assert.equal(harness.calls.reinstall, 0);
  assert.equal(validated.size, 1);
  await harness.updater.ensureInstalled('qqmusic');
  assert.equal(harness.calls.health.length, 2, 'a validated executable is not spawned again');
});

test('an unavailable or refused reinstall launches the existing connector instead', async () => {
  const blockers = [
    { ...healthyStatus, error: 'fetch failed' },
    { ...healthyStatus, compatible: false, latestVersion: '22.60.1', minimumCoreVersion: '1.3.0' },
    { ...healthyStatus, manualUpdateAvailable: true, latestVersion: '22.60.1' },
    new Error('status unavailable')
  ];
  for (const status of blockers) {
    const harness = ensureHarness({ status });
    assert.equal(
      await harness.updater.ensureInstalled('qqmusic'),
      path.resolve('connector', 'Awoo.Connector.QQMusic.exe')
    );
    assert.deepEqual(harness.calls.health, ['default', 15000]);
    assert.deepEqual(harness.calls.statuses, [[false, 'qqmusic']]);
    assert.equal(harness.calls.reinstall, 0);
    assert.equal(harness.updater.validatedExecutables.size, 0, 'the next start checks again');
    assert.equal(harness.logs.length, 1);
    assert.match(harness.logs[0], /QQ 音乐健康检查未通过，但当前无法安全重装（.+），将直接尝试启动现有连接器/);
  }
});

test('automatic reinstalls of one connector version are rate limited and capped', async () => {
  const harness = ensureHarness({
    reinstallResults: Array(5).fill({ success: false, message: '安装失败：signature' })
  });
  const blocked = /QQ 音乐连接器可能被安全软件拦截或已损坏，已暂停自动重装；请检查安全软件后在播放器设置中手动“重新安装”/;

  await assert.rejects(harness.updater.ensureInstalled('qqmusic'), /安装失败：signature/);
  assert.equal(harness.calls.reinstall, 1);
  assert.ok(harness.logs.some(message => /正在自动重新安装/.test(message)));

  harness.clock.now += 9 * MINUTE;
  await assert.rejects(harness.updater.ensureInstalled('qqmusic'), blocked);
  assert.equal(harness.calls.reinstall, 1);

  for (const expected of [2, 3]) {
    harness.clock.now += 10 * MINUTE;
    await assert.rejects(harness.updater.ensureInstalled('qqmusic'), /安装失败：signature/);
    assert.equal(harness.calls.reinstall, expected);
  }
  harness.clock.now += 60 * MINUTE;
  await assert.rejects(harness.updater.ensureInstalled('qqmusic'), blocked);
  assert.equal(harness.calls.reinstall, 3);

  harness.setActive({ version: '22.52.2', executable: path.resolve('connector', 'next.exe') });
  await assert.rejects(harness.updater.ensureInstalled('qqmusic'), /安装失败：signature/);
  assert.equal(harness.calls.reinstall, 4, 'a different version has its own budget');
});

test('a successful automatic reinstall marks the new executable as validated', async () => {
  const harness = ensureHarness({ reinstallResults: [{ success: true, message: 'ok' }] });
  const repaired = await harness.updater.ensureInstalled('qqmusic');
  assert.equal(repaired, path.resolve('connector', 'qqmusic.exe'));
  assert.equal(harness.updater.validatedExecutables.has(repaired), true);
  assert.equal(harness.calls.reinstall, 1);
});

test('a failed first install is repeated from memory for 60 s', async () => {
  const harness = ensureHarness({
    active: null,
    updateResults: [
      { success: false, message: '检查失败：fetch failed' },
      { success: true, message: 'ok' }
    ]
  });
  const firstUse = message => message.includes('首次使用 QQ 音乐');

  const first = await harness.updater.ensureInstalled('qqmusic').catch(error => error);
  assert.match(first.message, /检查失败：fetch failed/);
  assert.equal(harness.calls.update, 1);
  assert.equal(harness.logs.filter(firstUse).length, 1);

  harness.clock.now += 59 * 1000;
  const repeated = await harness.updater.ensureInstalled('qqmusic').catch(error => error);
  assert.equal(repeated, first, 'the cached error is rethrown');
  assert.equal(harness.calls.update, 1);
  assert.equal(harness.logs.filter(firstUse).length, 1, 'no new first-use log');

  harness.clock.now += 1000;
  assert.equal(
    await harness.updater.ensureInstalled('qqmusic'),
    path.resolve('connector', 'qqmusic.exe')
  );
  assert.equal(harness.calls.update, 2);
  assert.equal(harness.logs.filter(firstUse).length, 2);
  assert.equal(
    harness.updater.validatedExecutables.has(path.resolve('connector', 'qqmusic.exe')),
    true
  );
});

test('a successful first install clears the remembered failure', async () => {
  const harness = ensureHarness({
    active: null,
    updateResults: [
      { success: false, message: '安装失败：offline' },
      { success: true, message: 'ok' },
      { success: false, message: '安装失败：later' }
    ]
  });
  await assert.rejects(harness.updater.ensureInstalled('qqmusic'), /offline/);
  harness.clock.now += 60 * 1000;
  await harness.updater.ensureInstalled('qqmusic');
  harness.setActive(null);
  await assert.rejects(harness.updater.ensureInstalled('qqmusic'), /later/);
  assert.equal(harness.calls.update, 3, 'a cleared memo does not block the next attempt');
});
