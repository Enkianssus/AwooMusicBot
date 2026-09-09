import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {
  resolveDevUserDataDir,
  shouldRunAutomaticConnectorMaintenance
} from '../electron/dev-user-data-policy.ts';

test('Electron resolves isolation before the instance lock and configuration paths', () => {
  const main = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const override = main.indexOf('const devUserDataDir = resolveDevUserDataDir(process.env, allowMultipleInstances)');
  assert.ok(override > main.indexOf('const allowMultipleInstances ='));
  assert.ok(override < main.indexOf('const hasSingleInstanceLock ='));
  assert.ok(override < main.indexOf('const CONFIG_PATH ='));
  assert.match(main, /if \(devUserDataDir\) \{\s*fs\.mkdirSync\(devUserDataDir, \{ recursive: true \}\);\s*app\.setPath\('userData', devUserDataDir\)/);
  assert.match(main, /else if \(process\.platform === 'win32'\) \{[\s\S]*?app\.setPath\('userData', path\.join\(app\.getPath\('appData'\), '嗷呜点歌机'\)\)/);
});

test('an omitted or empty development override preserves the default directory', () => {
  for (const allowMultipleInstances of [false, true]) {
    for (const value of [undefined, '', '   ', '\t\n']) {
      assert.equal(resolveDevUserDataDir(
        { AWOO_DEV_USER_DATA_DIR: value }, allowMultipleInstances
      ), null);
    }
    assert.equal(resolveDevUserDataDir({}, allowMultipleInstances), null);
  }
});

test('automatic connector maintenance is disabled only for an isolated data directory', () => {
  assert.equal(shouldRunAutomaticConnectorMaintenance(null), true);
  assert.equal(shouldRunAutomaticConnectorMaintenance(resolveDevUserDataDir({}, false)), true);
  assert.equal(shouldRunAutomaticConnectorMaintenance(resolveDevUserDataDir({
    AWOO_DEV_USER_DATA_DIR: '   '
  }, true)), true);
  assert.equal(shouldRunAutomaticConnectorMaintenance(resolveDevUserDataDir({
    AWOO_DEV_USER_DATA_DIR: path.resolve('isolated-data')
  }, true)), false);
});

test('automatic maintenance exits before checking or updating any connector when isolated', () => {
  const main = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const maintenanceStart = main.indexOf('async function maintainPlayerConnectors(');
  const maintenanceEnd = main.indexOf('async function startPlayerBridge()', maintenanceStart);
  assert.ok(maintenanceStart !== -1 && maintenanceEnd > maintenanceStart);
  const maintenance = main.slice(maintenanceStart, maintenanceEnd);
  assert.match(maintenance, /\): Promise<void> \{\s*if \(!shouldRunAutomaticConnectorMaintenance\(devUserDataDir\)\) return;/);
  assert.ok(maintenance.indexOf('shouldRunAutomaticConnectorMaintenance(devUserDataDir)')
    < maintenance.indexOf('playerManager.getConnectorStatuses('));
});

test('isolated startup does not allocate the periodic connector maintenance timer', () => {
  const main = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  assert.equal((main.match(/connectorMaintenanceTimer\s*=\s*setInterval\(/g) || []).length, 1);
  assert.match(main, /if \(shouldRunAutomaticConnectorMaintenance\(devUserDataDir\)\) \{\s*connectorMaintenanceTimer = setInterval\(\s*\(\) => void maintainPlayerConnectors\(true\),\s*CONNECTOR_MAINTENANCE_INTERVAL_MS\s*\);\s*\}/);
});

test('isolated automatic connection recovery exits before probing or updating a player', () => {
  const main = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const start = main.indexOf('async function runConnectorAutoRepair(');
  assert.ok(start !== -1);
  assert.match(main.slice(start), /\): Promise<boolean> \{\s*if \(!shouldRunAutomaticConnectorMaintenance\(devUserDataDir\)\) return false;/);
});

// Execute only these real methods with inert dependencies; no Electron import,
// network, installed files, health-check process, or actual player is involved.
function makeUpdaterHarness({ isolated = true, active = null, validationFails = false } = {}) {
  const source = fs.readFileSync(new URL('../electron/connector-updater.ts', import.meta.url), 'utf8');
  const method = (start, end) => {
    const begin = source.indexOf(start);
    const finish = source.indexOf(end, begin);
    assert.ok(begin !== -1 && finish > begin);
    return source.slice(begin, finish);
  };
  const methods = method('  async getLaunchEnvironment(', '  private getPrivateDotnetRuntime(')
    + method('  async ensureInstalled(', '  async getStatuses(')
    + method('  private getConnectorRoot(', '\n}\n');
  const calls = { validate: 0, update: 0, reinstall: 0, profiles: 0 };
  const context = vm.createContext({
    process: { env: {
      BILINCM_CONNECTOR_ROOT: path.resolve('production-connectors'),
      ...(isolated ? { AWOO_DEV_USER_DATA_DIR: path.resolve('isolated-data') } : {})
    } },
    app: { getPath: () => path.resolve('isolated-data') },
    path,
    shouldRunAutomaticConnectorMaintenance,
    CONNECTOR_NAMES: { netease: '网易云音乐', qqmusic: 'QQ 音乐', kugou: '酷狗', folia: 'Folia' },
    getErrorMessage: error => error.message,
    buildPrivateDotnetEnvironment: (rid, root) => ({ DOTNET_ROOT: root, RID: rid }),
    validateConnectorExecutable: async () => {
      calls.validate++;
      if (validationFails) throw new Error('stub health failure');
    }
  });
  vm.runInContext(ts.transpileModule(`class Subject { ${methods} } globalThis.Subject = Subject;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 }
  }).outputText, context);
  const updater = new context.Subject();
  Object.assign(updater, {
    validatedExecutables: new Set(),
    readActive: async () => active,
    resolve: async () => path.resolve('stub-connector.exe'),
    onLog: () => {},
    update: async () => { calls.update++; return { success: true }; },
    reinstall: async () => { calls.reinstall++; return { success: true }; },
    ensureQQMusicProfiles: async () => { calls.profiles++; return 'stub-profiles'; }
  });
  return { updater, calls };
}

test('isolated missing connectors cannot invoke automatic installation for any player', async () => {
  for (const player of ['netease', 'qqmusic', 'kugou', 'folia']) {
    const { updater, calls } = makeUpdaterHarness();
    await assert.rejects(updater.ensureInstalled(player), /隔离开发.*禁止自动下载安装/);
    assert.deepEqual(calls, { validate: 0, update: 0, reinstall: 0, profiles: 0 });
  }
});

test('isolated unhealthy installed connectors fail without automatic reinstall', async () => {
  const { updater, calls } = makeUpdaterHarness({
    active: { executable: path.resolve('stub-connector.exe'), version: '1.2.3' },
    validationFails: true
  });
  await assert.rejects(updater.ensureInstalled('qqmusic'), /隔离开发.*禁止自动重装.*stub health failure/);
  assert.deepEqual(calls, { validate: 1, update: 0, reinstall: 0, profiles: 0 });
});

test('isolated valid connectors retain health checks and private runtime without fetching QQ profiles', async () => {
  const active = {
    executable: path.resolve('stub-connector.exe'), version: '1.2.3',
    deployment: 'framework-dependent', runtimeRid: 'win-x86', runtimeRoot: path.resolve('private-runtime')
  };
  const { updater, calls } = makeUpdaterHarness({ active });
  assert.equal(await updater.ensureInstalled('qqmusic'), active.executable);
  assert.equal(await updater.ensureInstalled('qqmusic'), active.executable);
  const environment = await updater.getLaunchEnvironment('qqmusic');
  assert.equal(environment.DOTNET_ROOT, active.runtimeRoot);
  assert.equal(environment.RID, active.runtimeRid);
  assert.equal(environment.BILINCM_QQMUSIC_PROFILE_DIR, '');
  assert.deepEqual(calls, { validate: 1, update: 0, reinstall: 0, profiles: 0 });
});

test('non-isolated automatic install, repair, and QQ profile loading retain their existing behavior', async () => {
  const missing = makeUpdaterHarness({ isolated: false });
  assert.equal(await missing.updater.ensureInstalled('netease'), path.resolve('stub-connector.exe'));
  assert.equal(missing.calls.update, 1);
  const unhealthy = makeUpdaterHarness({
    isolated: false, active: { executable: path.resolve('stub-connector.exe'), version: '1.2.3' },
    validationFails: true
  });
  assert.equal(await unhealthy.updater.ensureInstalled('netease'), path.resolve('stub-connector.exe'));
  assert.equal(unhealthy.calls.reinstall, 1);
  const environment = await unhealthy.updater.getLaunchEnvironment('qqmusic');
  assert.equal(environment.BILINCM_QQMUSIC_PROFILE_DIR, 'stub-profiles');
  assert.equal(unhealthy.calls.profiles, 1);
});

test('isolated connector roots cannot inherit a production path while ordinary overrides remain supported', () => {
  const isolated = makeUpdaterHarness();
  const ordinary = makeUpdaterHarness({ isolated: false });
  for (const player of ['netease', 'qqmusic', 'kugou', 'folia']) {
    assert.equal(isolated.updater.getConnectorRoot(player), path.resolve('isolated-data', 'player-connectors', player));
    assert.equal(ordinary.updater.getConnectorRoot(player), path.resolve('production-connectors', player));
  }
});

test('an allowed override returns a normalized native absolute path without mutating input', () => {
  const requestedPath = path.join(path.parse(process.cwd()).root, 'awoo test data', 'cache', '..', 'isolated');
  const env = Object.freeze({ AWOO_DEV_USER_DATA_DIR: `  ${requestedPath}  ` });
  assert.equal(resolveDevUserDataDir(env, true), path.normalize(requestedPath));
  assert.equal(env.AWOO_DEV_USER_DATA_DIR, `  ${requestedPath}  `);
});

test('production refuses an explicitly requested override instead of falling back', () => {
  assert.throws(() => resolveDevUserDataDir({
    AWOO_DEV_USER_DATA_DIR: path.resolve('isolated-data')
  }, false), /requires development or multiple-instance mode/);
  assert.throws(() => resolveDevUserDataDir({
    AWOO_DEV_USER_DATA_DIR: 'relative-data'
  }, false), /requires development or multiple-instance mode/);
});

test('relative and drive-relative paths fail even when development is allowed', () => {
  for (const value of ['relative-data', './isolated', '../isolated', 'C:isolated', 'C:']) {
    assert.throws(() => resolveDevUserDataDir({
      AWOO_DEV_USER_DATA_DIR: value
    }, true), /fully qualified absolute path/, value);
  }
});

test('an embedded NUL is rejected before it can reach the filesystem', () => {
  assert.throws(() => resolveDevUserDataDir({
    AWOO_DEV_USER_DATA_DIR: path.resolve('isolated\0data')
  }, true), /fully qualified absolute path/);
});

test('Windows accepts explicit drive and UNC paths but not current-drive roots', {
  skip: process.platform !== 'win32'
}, () => {
  for (const value of ['C:\\Awoo Test\\isolated', 'D:/Awoo Test/isolated', '\\\\server\\share\\isolated']) {
    assert.equal(resolveDevUserDataDir({ AWOO_DEV_USER_DATA_DIR: value }, true), path.normalize(value));
  }
  for (const value of ['\\isolated', '/isolated', '\\', '/', '\\\\server']) {
    assert.throws(() => resolveDevUserDataDir({
      AWOO_DEV_USER_DATA_DIR: value
    }, true), /fully qualified absolute path/, value);
  }
});

test('non-Windows hosts do not mistake a Windows drive path for a native absolute path', {
  skip: process.platform === 'win32'
}, () => {
  assert.throws(() => resolveDevUserDataDir({
    AWOO_DEV_USER_DATA_DIR: 'C:\\Awoo Test\\isolated'
  }, true), /fully qualified absolute path/);
});
