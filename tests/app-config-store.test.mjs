import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { createAppConfigStore } from '../electron/app-config-store.ts';
import {
  createDefaultAppConfig,
  normalizeRoomId,
  normalizeSysConfig
} from '../electron/app-config-policy.ts';
import { shouldRequestAppQuit } from '../electron/app-update-policy.ts';
import { createBiliRoomConnectionState } from '../electron/bili-room-connection-policy.ts';
import { normalizeOverlayAlwaysOnTop } from '../electron/overlay-window-policy.ts';
import { normalizeLearnedGifts } from '../electron/gift-request-credit-policy.ts';
import { createLogSink, describeErrorForLog } from '../electron/log-sink.ts';
import { extractFunctions, readSource, sliceBetween } from './helpers/source.mjs';

const FIXED_NOW = Date.UTC(2026, 9, 21, 8, 30, 0, 123);
const STAMP = '2026-10-21T08-30-00-123Z';

function tempConfig(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awoo-config-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, 'bili_bot_config.json');
}

function fsError(code) {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

function recordingLog() {
  const entries = [];
  return { entries, log: (message, color) => entries.push({ message, color }) };
}

/** Counts completed config writes: one per rename of the temporary file or direct write. */
function countingFs(filePath) {
  const writes = [];
  return {
    writes,
    fsImpl: {
      ...fs,
      writeFileSync(target, data, options) {
        if (target === filePath) writes.push({ direct: true, data: String(data) });
        return fs.writeFileSync(target, data, options);
      },
      renameSync(from, to) {
        fs.renameSync(from, to);
        if (to === filePath) writes.push({ direct: false, data: fs.readFileSync(to, 'utf8') });
      }
    }
  };
}

test('ten scheduled saves inside the quiet period produce one write of the latest state', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const filePath = tempConfig(t);
  const { writes, fsImpl } = countingFs(filePath);
  let now = FIXED_NOW;
  const store = createAppConfigStore({ filePath, fsImpl, now: () => now });
  let serializeCalls = 0;

  for (let index = 1; index <= 10; index += 1) {
    store.scheduleSave(() => {
      serializeCalls += 1;
      return JSON.stringify({ revision: index });
    });
    now += 25;
    t.mock.timers.tick(25);
  }
  assert.equal(writes.length, 0);
  assert.equal(store.pending, true);

  now += 299;
  t.mock.timers.tick(299 - 25);
  assert.equal(writes.length, 0);
  t.mock.timers.tick(1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].direct, false);
  assert.equal(serializeCalls, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { revision: 10 });
  assert.equal(store.pending, false);
  assert.equal(fs.existsSync(`${filePath}.tmp`), false);
});

test('a continuous burst of saves still writes once the maximum wait is reached', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const filePath = tempConfig(t);
  const { writes, fsImpl } = countingFs(filePath);
  let now = FIXED_NOW;
  const store = createAppConfigStore({ filePath, fsImpl, now: () => now, debounceMs: 300, maxWaitMs: 2000 });

  for (let elapsed = 0; elapsed < 2500; elapsed += 100) {
    store.scheduleSave(() => JSON.stringify({ elapsed }));
    now += 100;
    t.mock.timers.tick(100);
  }
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(writes[0].data), { elapsed: 1900 });
  t.mock.timers.tick(300);
  assert.equal(writes.length, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { elapsed: 2400 });
});

test('flushSync writes a scheduled save immediately and only once', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const filePath = tempConfig(t);
  const { writes, fsImpl } = countingFs(filePath);
  const store = createAppConfigStore({ filePath, fsImpl, now: () => FIXED_NOW });

  assert.equal(store.flushSync(), false);
  store.scheduleSave(() => '{"saved":true}');
  assert.equal(store.flushSync(), true);
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { saved: true });
  t.mock.timers.tick(1000);
  assert.equal(writes.length, 1);
  assert.equal(store.flushSync(), false);
});

test('saveNow writes at once and replaces a scheduled save', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const filePath = tempConfig(t);
  const { writes, fsImpl } = countingFs(filePath);
  const store = createAppConfigStore({ filePath, fsImpl, now: () => FIXED_NOW });

  store.scheduleSave(() => '{"stale":true}');
  assert.equal(store.saveNow(() => '{"login":"cookie"}'), true);
  assert.equal(store.pending, false);
  t.mock.timers.tick(1000);
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { login: 'cookie' });
});

test('a missing file loads as missing and a valid one is backed up', t => {
  const filePath = tempConfig(t);
  const store = createAppConfigStore({ filePath, now: () => FIXED_NOW });
  assert.deepEqual(store.load(), { status: 'missing', config: null, quarantinePath: null, error: '' });
  assert.equal(fs.existsSync(store.backupPath), false);

  const text = JSON.stringify({ roomId: 42, sysConfig: { PlayerType: 'NCM' }, futureKey: [1] }, null, 2);
  fs.writeFileSync(filePath, text);
  const result = store.load();
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.config, JSON.parse(text));
  assert.equal(fs.readFileSync(`${filePath}.bak`, 'utf8'), text);
  assert.equal(fs.existsSync(`${filePath}.bak.tmp`), false);
  assert.equal(store.writable, true);
});

test('a byte order mark written by a text editor is accepted', t => {
  const filePath = tempConfig(t);
  fs.writeFileSync(filePath, String.fromCharCode(0xfeff) + JSON.stringify({ roomId: 7 }));
  assert.deepEqual([...fs.readFileSync(filePath).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const result = createAppConfigStore({ filePath, now: () => FIXED_NOW }).load();
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.config, { roomId: 7 });
});

test('a corrupt file is quarantined and the last good copy is restored from the backup', t => {
  const filePath = tempConfig(t);
  const store = createAppConfigStore({ filePath, now: () => FIXED_NOW });
  const good = JSON.stringify({ roomId: 42, biliCookie: 'SESSDATA=kept' });
  fs.writeFileSync(filePath, good);
  assert.equal(store.load().status, 'ok');

  const corrupt = '{"roomId": 42, "biliCookie": "SESS';
  fs.writeFileSync(filePath, corrupt);
  const result = store.load();
  assert.equal(result.status, 'recovered-from-backup');
  assert.deepEqual(result.config, JSON.parse(good));
  assert.equal(result.quarantinePath, `${filePath}.corrupt-${STAMP}`);
  assert.equal(fs.readFileSync(result.quarantinePath, 'utf8'), corrupt);
  assert.match(result.error, /JSON/);
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(fs.readFileSync(`${filePath}.bak`, 'utf8'), good);
  assert.equal(store.writable, true);

  // Saving the recovered settings recreates the file; the quarantined copy stays.
  assert.equal(store.saveNow(() => JSON.stringify(result.config)), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), JSON.parse(good));
  assert.equal(fs.readFileSync(result.quarantinePath, 'utf8'), corrupt);
});

test('without a usable backup a corrupt file resets to defaults and the corrupt copy is kept', t => {
  for (const [label, content] of [['truncated', '{"roomId":'], ['empty', ''], ['array', '[1,2]'],
    ['null', 'null'], ['number', '42']]) {
    const filePath = tempConfig(t);
    fs.writeFileSync(filePath, content);
    if (label === 'array') fs.writeFileSync(`${filePath}.bak`, 'not json either');
    const store = createAppConfigStore({ filePath, now: () => FIXED_NOW });
    const result = store.load();
    assert.equal(result.status, 'corrupt-reset', label);
    assert.equal(result.config, null, label);
    assert.equal(fs.readFileSync(result.quarantinePath, 'utf8'), content, label);
    assert.equal(fs.existsSync(filePath), false, label);
    assert.equal(store.writable, true, label);
    assert.equal(store.saveNow(() => '{"roomId":0}'), true, label);
    assert.equal(fs.readFileSync(result.quarantinePath, 'utf8'), content, label);
  }
});

test('an earlier quarantined copy is never replaced', t => {
  const filePath = tempConfig(t);
  const earlier = `${filePath}.corrupt-${STAMP}`;
  fs.writeFileSync(earlier, 'first damage');
  fs.writeFileSync(filePath, 'second damage');
  const result = createAppConfigStore({ filePath, now: () => FIXED_NOW }).load();
  assert.equal(result.quarantinePath, `${earlier}-1`);
  assert.equal(fs.readFileSync(earlier, 'utf8'), 'first damage');
  assert.equal(fs.readFileSync(result.quarantinePath, 'utf8'), 'second damage');
});

test('a corrupt file that cannot be moved is copied aside before it may be overwritten', t => {
  const filePath = tempConfig(t);
  fs.writeFileSync(filePath, '{broken');
  const fsImpl = {
    ...fs,
    renameSync(from, to) {
      if (from === filePath) throw fsError('EPERM');
      return fs.renameSync(from, to);
    }
  };
  const store = createAppConfigStore({ filePath, fsImpl, now: () => FIXED_NOW });
  const result = store.load();
  assert.equal(result.status, 'corrupt-reset');
  assert.equal(fs.readFileSync(result.quarantinePath, 'utf8'), '{broken');
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{broken');
  assert.equal(store.writable, true);
});

test('saving is refused for the run when a corrupt file could not be preserved', t => {
  const filePath = tempConfig(t);
  fs.writeFileSync(filePath, '{broken');
  const { entries, log } = recordingLog();
  const fsImpl = {
    ...fs,
    renameSync(from, to) {
      if (from === filePath) throw fsError('EPERM');
      return fs.renameSync(from, to);
    },
    writeFileSync(target, data, options) {
      if (String(target).includes('.corrupt-')) throw fsError('EACCES');
      return fs.writeFileSync(target, data, options);
    }
  };
  const store = createAppConfigStore({ filePath, fsImpl, now: () => FIXED_NOW, log });
  const result = store.load();
  assert.equal(result.status, 'corrupt-reset');
  assert.equal(result.quarantinePath, null);
  assert.equal(store.writable, false);
  assert.equal(store.saveNow(() => '{"roomId":0}'), false);
  assert.equal(store.saveNow(() => '{"roomId":0}'), false);
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{broken');
  assert.equal(entries.filter(entry => entry.color === 'Red').length, 1);
});

test('a file that exists but cannot be read is never overwritten', t => {
  const filePath = tempConfig(t);
  fs.writeFileSync(filePath, JSON.stringify({ roomId: 1, biliCookie: 'real' }));
  fs.writeFileSync(`${filePath}.bak`, JSON.stringify({ roomId: 1 }));
  const { entries, log } = recordingLog();
  const sleeps = [];
  const fsImpl = {
    ...fs,
    readFileSync(target, options) {
      if (target === filePath) throw fsError('EACCES');
      return fs.readFileSync(target, options);
    }
  };
  const store = createAppConfigStore({
    filePath, fsImpl, now: () => FIXED_NOW, log, sleepSync: milliseconds => sleeps.push(milliseconds)
  });
  const result = store.load();
  assert.equal(result.status, 'unreadable');
  assert.deepEqual(result.config, { roomId: 1 });
  assert.match(result.error, /EACCES/);
  assert.deepEqual(sleeps, [25, 50, 100, 200]);
  assert.equal(store.writable, false);
  store.scheduleSave(() => '{}');
  assert.equal(store.flushSync(), false);
  assert.equal(fs.readFileSync(filePath, 'utf8'), JSON.stringify({ roomId: 1, biliCookie: 'real' }));
  assert.equal(entries.filter(entry => entry.color === 'Red').length, 1);
});

test('a briefly locked file is read after a short retry', t => {
  const filePath = tempConfig(t);
  fs.writeFileSync(filePath, JSON.stringify({ roomId: 3 }));
  const sleeps = [];
  let failures = 2;
  const fsImpl = {
    ...fs,
    readFileSync(target, options) {
      if (target === filePath && failures-- > 0) throw fsError('EBUSY');
      return fs.readFileSync(target, options);
    }
  };
  const store = createAppConfigStore({
    filePath, fsImpl, now: () => FIXED_NOW, sleepSync: milliseconds => sleeps.push(milliseconds)
  });
  const result = store.load();
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.config, { roomId: 3 });
  assert.deepEqual(sleeps, [25, 50]);
  assert.equal(store.writable, true);
});

test('saves go through the temporary file and retry a rename refused with EPERM', t => {
  const filePath = tempConfig(t);
  fs.writeFileSync(filePath, '{"old":true}');
  const renames = [];
  const directWrites = [];
  let refuse = true;
  const fsImpl = {
    ...fs,
    renameSync(from, to) {
      renames.push([from, to]);
      if (refuse) {
        refuse = false;
        throw fsError('EPERM');
      }
      return fs.renameSync(from, to);
    },
    writeFileSync(target, data, options) {
      if (target === filePath) directWrites.push(target);
      return fs.writeFileSync(target, data, options);
    }
  };
  const { entries, log } = recordingLog();
  const store = createAppConfigStore({ filePath, fsImpl, now: () => FIXED_NOW, log });
  assert.equal(store.saveNow(() => '{"new":true}'), true);
  assert.deepEqual(renames, [[`${filePath}.tmp`, filePath], [`${filePath}.tmp`, filePath]]);
  assert.deepEqual(directWrites, []);
  assert.deepEqual(entries, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { new: true });
  assert.equal(fs.existsSync(`${filePath}.tmp`), false);
});

test('a rename that keeps failing falls back to writing the file directly and says so', t => {
  const filePath = tempConfig(t);
  fs.writeFileSync(filePath, '{"old":true}');
  let renameAttempts = 0;
  const fsImpl = {
    ...fs,
    renameSync() {
      renameAttempts += 1;
      throw fsError('EBUSY');
    }
  };
  const { entries, log } = recordingLog();
  const store = createAppConfigStore({ filePath, fsImpl, now: () => FIXED_NOW, log });
  assert.equal(store.saveNow(() => '{"new":true}'), true);
  assert.equal(renameAttempts, 5);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { new: true });
  assert.equal(fs.existsSync(`${filePath}.tmp`), false);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].color, 'Yellow');
  assert.match(entries[0].message, /EBUSY/);
});

test('a failed serialization or temporary write leaves the saved file untouched', t => {
  const filePath = tempConfig(t);
  fs.writeFileSync(filePath, '{"old":true}');
  const { entries, log } = recordingLog();
  const store = createAppConfigStore({ filePath, now: () => FIXED_NOW, log });
  assert.equal(store.saveNow(() => { throw new Error('circular'); }), false);

  const full = createAppConfigStore({
    filePath,
    now: () => FIXED_NOW,
    log,
    fsImpl: {
      ...fs,
      writeFileSync(target, data, options) {
        if (target === `${filePath}.tmp`) throw fsError('ENOSPC');
        return fs.writeFileSync(target, data, options);
      }
    }
  });
  assert.equal(full.saveNow(() => '{"new":true}'), false);
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{"old":true}');
  assert.deepEqual(entries.map(entry => entry.color), ['Red', 'Red']);
  assert.match(entries[1].message, /ENOSPC/);
});

test('a save creates the settings directory when it is missing', t => {
  const filePath = path.join(path.dirname(tempConfig(t)), 'nested', 'bili_bot_config.json');
  const store = createAppConfigStore({ filePath, now: () => FIXED_NOW });
  assert.equal(store.saveNow(() => '{"roomId":5}'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { roomId: 5 });
});

// ---------------------------------------------------------------------------
// main.ts: loadConfig and the save functions, run against a real store
// ---------------------------------------------------------------------------

const mainConfigJavascript = ts.transpileModule(extractFunctions('electron/main.ts', [
  'loadConfig', 'reportConfigLoadProblem', 'serializeAppConfig', 'saveConfig', 'saveConfigNow'
]), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function loadConfigHarness(filePath, fsImpl) {
  const logs = [];
  const writeLog = (message, color) => logs.push({ message, color });
  const context = vm.createContext({
    appConfig: createDefaultAppConfig({ envInternalPort: 5555 }),
    appConfigStore: createAppConfigStore({ filePath, fsImpl, now: () => FIXED_NOW, log: writeLog }),
    writeLog, path, JSON, Object,
    normalizeRoomId, normalizeSysConfig, createBiliRoomConnectionState,
    normalizeOverlayAlwaysOnTop, normalizeLearnedGifts, describeErrorForLog,
    ENV_INTERNAL_API_PORT: 5555, configuredInternalApiPort: 0, requestedInternalApiPort: 0,
    overlayAlwaysOnTop: true, biliRoomState: null, biliCookie: '', biliUid: 0
  });
  vm.runInContext(mainConfigJavascript, context);
  return { context, logs };
}

test('main restores a damaged config from the backup, says where the damaged copy is, and rewrites it', t => {
  const filePath = tempConfig(t);
  const good = { roomId: 42, roomConnectionEnabled: true, biliCookie: 'SESSDATA=kept', biliUid: 7, sysConfig: { PlayerType: 'QQMusic' } };
  fs.writeFileSync(filePath, JSON.stringify(good));
  createAppConfigStore({ filePath, now: () => FIXED_NOW }).load();
  fs.writeFileSync(filePath, '{"roomId": 42, "biliCookie": "SESS');

  const { context, logs } = loadConfigHarness(filePath);
  context.loadConfig();
  const warning = logs.find(log => log.color === 'Yellow');
  assert.match(warning.message, new RegExp(`bili_bot_config\\.json\\.corrupt-${STAMP}`));
  assert.match(warning.message, /备份恢复/);
  assert.equal(context.appConfig.roomId, 42);
  assert.equal(context.biliCookie, 'SESSDATA=kept');
  assert.equal(context.appConfig.sysConfig.PlayerType, 'QQMusic');
  const rewritten = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(rewritten.biliCookie, 'SESSDATA=kept');
  assert.equal(rewritten.sysConfig.DynamicCoverEnabled, true);
  assert.equal(fs.readFileSync(`${filePath}.corrupt-${STAMP}`, 'utf8'), '{"roomId": 42, "biliCookie": "SESS');
});

test('main keeps the defaults for a damaged config without a backup and writes nothing over it', t => {
  const filePath = tempConfig(t);
  fs.writeFileSync(filePath, '');
  const { context, logs } = loadConfigHarness(filePath);
  context.loadConfig();
  const error = logs.find(log => log.color === 'Red');
  assert.match(error.message, /没有可用的备份/);
  assert.match(error.message, new RegExp(`corrupt-${STAMP}`));
  assert.deepEqual(context.appConfig, createDefaultAppConfig({ envInternalPort: 5555 }));
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(fs.readFileSync(`${filePath}.corrupt-${STAMP}`, 'utf8'), '');
  assert.match(error.message, /请重新扫码登录并设置直播间/);
});

test('main says nothing of this run is saved when a damaged config could not be preserved', t => {
  const filePath = tempConfig(t);
  fs.writeFileSync(filePath, '{broken');
  const fsImpl = {
    ...fs,
    renameSync(from, to) {
      if (from === filePath) throw fsError('EPERM');
      return fs.renameSync(from, to);
    },
    writeFileSync(target, data, options) {
      if (String(target).includes('.corrupt-')) throw fsError('EACCES');
      return fs.writeFileSync(target, data, options);
    }
  };
  const { context, logs } = loadConfigHarness(filePath, fsImpl);
  context.loadConfig();
  const [error] = logs.filter(log => log.color === 'Red');
  assert.match(error.message, /没有可用的备份，原文件也无法另存/);
  assert.match(error.message, /本次运行中的设置更改都不会保存/);
  assert.match(error.message, /请修复或移走 bili_bot_config\.json 后重启点歌机/);
  assert.doesNotMatch(error.message, /重新扫码|设置直播间/, 'setting things up again would be lost');
  context.saveConfigNow();
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{broken');
});

test('main never overwrites a config it cannot read', t => {
  const filePath = tempConfig(t);
  fs.mkdirSync(filePath);
  const { context, logs } = loadConfigHarness(filePath);
  context.loadConfig();
  assert.match(logs.find(log => log.color === 'Red').message, /无法读取配置文件（EISDIR）/);
  context.saveConfigNow();
  assert.equal(fs.statSync(filePath).isDirectory(), true);
  assert.equal(logs.filter(log => log.color === 'Red').length, 2);
});

test('main migrates an old config at once, normalizes it and keeps unknown keys', t => {
  const filePath = tempConfig(t);
  fs.writeFileSync(filePath, JSON.stringify({
    roomId: '123',
    futureTopLevel: { kept: true },
    widgetStyle: { theme: 'neon' },
    sysConfig: {
      PlayerType: 'Kugou', Cooldowns: { Normal: '5' }, SuperUsers: ['主播', 7],
      ForceControlPermission: { AllowManager: true }, EnableCDP: true, FutureSetting: 'kept'
    }
  }));
  const { context } = loadConfigHarness(filePath);
  context.loadConfig();
  const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(saved.roomId, 123);
  assert.equal(saved.roomConnectionEnabled, true);
  assert.deepEqual(saved.futureTopLevel, { kept: true });
  assert.equal(saved.widgetStyle.theme, 'neon');
  assert.equal(saved.widgetStyle.alwaysOnTop, true);
  assert.equal(saved.sysConfig.FutureSetting, 'kept');
  assert.equal(saved.sysConfig.Cooldowns.Normal, 5);
  assert.deepEqual(saved.sysConfig.SuperUsers, ['主播', '7']);
  assert.deepEqual(saved.sysConfig.ForceControlPermission, { AllowManager: true, MinGuardType: -1, MinMedalLevel: 0 });
  assert.equal(Object.hasOwn(saved.sysConfig, 'EnableCDP'), false);
  assert.equal(context.biliRoomState.requestedRoomId, 123);
});

test('top-level super users of very old configs apply only to an empty saved sysConfig, as in 1.2.5', t => {
  const load = saved => {
    const filePath = tempConfig(t);
    fs.writeFileSync(filePath, JSON.stringify(saved));
    const { context } = loadConfigHarness(filePath);
    context.loadConfig();
    return [...context.appConfig.sysConfig.SuperUsers];
  };
  const superUsers = ['viewerA', 123];
  // A missing key keeps the defaults; anything that is not empty never widens the list.
  assert.deepEqual(load({ roomId: 1, superUsers }), [], 'no sysConfig key');
  for (const sysConfig of [[], ['viewerA'], 'x', true, 1, {}, { PlayerType: 'NCM' }]) {
    assert.deepEqual(load({ roomId: 1, superUsers, sysConfig }), [], JSON.stringify(sysConfig));
  }
  assert.deepEqual(load({ roomId: 1, superUsers, sysConfig: { SuperUsers: ['主播'] } }), ['主播']);
  // An empty saved sysConfig adopts them.
  for (const sysConfig of [null, false, 0, '']) {
    assert.deepEqual(load({ roomId: 1, superUsers, sysConfig }), ['viewerA', '123'], JSON.stringify(sysConfig));
  }
  assert.deepEqual(load({ roomId: 1, sysConfig: null }), [], 'nothing to adopt');
});

test('main coalesces frequent saves and writes login, room and settings changes at once', () => {
  const main = readSource('electron/main.ts');
  assert.match(main, /const appConfigStore = createAppConfigStore\(\{ filePath: CONFIG_PATH, log: writeLog \}\);/);
  assert.ok(main.indexOf('const appConfigStore =') > main.indexOf('const CONFIG_PATH ='));
  assert.doesNotMatch(main, /writeFileSync\(CONFIG_PATH|giftLibrarySaveTimer/);
  assert.match(extractFunctions('electron/main.ts', ['saveConfig']), /appConfigStore\.scheduleSave\(serializeAppConfig\)/);
  assert.match(extractFunctions('electron/main.ts', ['saveConfigNow']), /appConfigStore\.saveNow\(serializeAppConfig\)/);
  for (const name of ['clearLearnedGiftLibrary', 'disconnectFromLiveRoom', 'logoutBiliAccount',
    'connectToLiveRoom', 'updateCurrentUserInfo']) {
    const body = extractFunctions('electron/main.ts', [name]);
    assert.match(body, /saveConfigNow\(\)/, name);
    assert.doesNotMatch(body, /\bsaveConfig\(\)/, name);
  }
  for (const name of ['setOverlayAlwaysOnTop', 'scheduleGiftLibrarySave']) {
    assert.match(extractFunctions('electron/main.ts', [name]), /\bsaveConfig\(\)/, name);
  }
  const resize = sliceBetween(main, "ipcMain.on('overlay-resize'", '\n});\n');
  assert.match(resize, /screen\.getDisplayMatching\(currentBounds\)\.workAreaSize/);
  assert.match(resize, /\bsaveConfig\(\)/);
  const config = sliceBetween(main, "if (url.pathname === '/api/config') {", "url.pathname === '/api/queue/action'");
  assert.match(config, /normalizeRoomId\(body\.roomId, appConfig\.roomId\)/);
  assert.match(config, /normalizeSysConfig\(appConfig\.sysConfig, \{\s*envInternalPort: ENV_INTERNAL_API_PORT\s*\}\)/);
  assert.match(config, /saveConfigNow\(\)/);
  assert.doesNotMatch(config, /delete appConfig\.sysConfig\.|\.includes\(appConfig\.sysConfig/);
  const quit = sliceBetween(main, "app.on('before-quit'", "app.on('window-all-closed'");
  // Last in before-quit, after everything that may still save or log.
  assert.match(quit, /flushPendingWrites\(\);\s*\}\);\s*$/);
  assert.match(main, /app\.on\('will-quit', flushPendingWrites\);/);
  assert.match(extractFunctions('electron/main.ts', ['flushPendingWrites']), /appConfigStore\.flushSync\(\);\s*logSink\.flushSync\(\);/);
});

// ---------------------------------------------------------------------------
// main.ts: what is still pending when the app quits or Windows ends the session
// ---------------------------------------------------------------------------

const mainQuitJavascript = ts.transpileModule(extractFunctions('electron/main.ts', [
  'requestApplicationQuit', 'flushAdminPendingSaves', 'flushPendingWritesAtSessionEnd', 'flushPendingWrites'
]), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

/** The ipcMain of the latest quitHarness, which the fake panel answers on. */
let ipc = null;

function fakeAdminPanel() {
  const contents = new EventEmitter();
  contents.sent = [];
  contents.send = (channel, id) => contents.sent.push([channel, id]);
  return {
    webContents: contents,
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    answer(id = contents.sent.at(-1)?.[1]) { ipc.emit('admin-pending-saves-flushed', { sender: contents }, id); }
  };
}

function quitHarness({ panel = null, store = { flushSync() {} }, sink = { flushSync() {} } } = {}) {
  const quits = [];
  ipc = new EventEmitter();
  const context = vm.createContext({
    shouldRequestAppQuit,
    applicationQuitRequested: false,
    adminWindow: panel,
    app: { quit: () => quits.push(context.applicationQuitRequested) },
    ipcMain: ipc,
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: timer => clearTimeout(timer),
    ADMIN_CLOSE_FLUSH_TIMEOUT_MS: 1500,
    adminFlushRequestSequence: 0,
    adminPendingSaveFlushes: new WeakMap(),
    appConfigStore: store,
    logSink: sink
  });
  vm.runInContext(mainQuitJavascript, context);
  return { context, quits };
}

const settled = () => new Promise(resolve => setImmediate(resolve));

test('quitting without an open control panel quits at once, and only once', () => {
  const { context, quits } = quitHarness();
  assert.equal(context.requestApplicationQuit(), true);
  assert.deepEqual(quits, [true]);
  assert.equal(context.requestApplicationQuit(), false);
  assert.deepEqual(quits, [true]);

  const closed = fakeAdminPanel();
  closed.destroyed = true;
  const destroyed = quitHarness({ panel: closed });
  destroyed.context.requestApplicationQuit();
  assert.deepEqual(destroyed.quits, [true], 'a destroyed panel is not asked');
  assert.deepEqual(closed.webContents.sent, []);
});

test('quitting lets an open control panel send its debounced edits first', async () => {
  const panel = fakeAdminPanel();
  const { context, quits } = quitHarness({ panel });
  assert.equal(context.requestApplicationQuit(), true);
  assert.equal(context.applicationQuitRequested, true, 'the close guard no longer waits');
  assert.deepEqual(panel.webContents.sent, [['admin-flush-pending-saves', 1]]);
  await settled();
  assert.deepEqual(quits, [], 'the internal API stays up until the panel answers');
  assert.equal(context.requestApplicationQuit(), false);

  panel.answer(99);
  await settled();
  assert.deepEqual(quits, [], 'only the answer to this request counts');
  panel.answer();
  await settled();
  assert.deepEqual(quits, [true]);
  assert.equal(ipc.listenerCount('admin-pending-saves-flushed'), 0);
  assert.equal(panel.webContents.listenerCount('destroyed'), 0);
});

test('a control panel that does not answer delays quitting by 1.5 s at most', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const panel = fakeAdminPanel();
  const { context, quits } = quitHarness({ panel });
  context.requestApplicationQuit();
  t.mock.timers.tick(1499);
  await settled();
  assert.deepEqual(quits, []);
  t.mock.timers.tick(1);
  await settled();
  assert.deepEqual(quits, [true]);

  // A panel that closes meanwhile ends the wait at once.
  const closing = fakeAdminPanel();
  const second = quitHarness({ panel: closing });
  second.context.requestApplicationQuit();
  closing.webContents.emit('destroyed');
  await settled();
  assert.deepEqual(second.quits, [true]);
});

test('closing the control panel and quitting share one flush', async () => {
  const panel = fakeAdminPanel();
  const { context, quits } = quitHarness({ panel });
  // The close guard asks first; the quit that follows joins it.
  const closing = context.flushAdminPendingSaves(panel);
  context.requestApplicationQuit();
  assert.deepEqual(panel.webContents.sent, [['admin-flush-pending-saves', 1]]);
  panel.answer();
  await closing;
  await settled();
  assert.deepEqual(quits, [true]);
  // A later flush is a new request.
  void context.flushAdminPendingSaves(panel);
  assert.deepEqual(panel.webContents.sent.map(([, id]) => id), [1, 2]);
});

test('a Windows session end writes the pending settings and log lines once, from either window', t => {
  const filePath = tempConfig(t);
  const store = createAppConfigStore({ filePath, now: () => FIXED_NOW });
  const sink = createLogSink({ dir: path.join(path.dirname(filePath), 'logs'), sanitize: line => line, now: () => FIXED_NOW });
  const { context } = quitHarness({ store, sink });
  const windows = [new EventEmitter(), new EventEmitter()];
  for (const win of windows) context.flushPendingWritesAtSessionEnd(win);

  store.scheduleSave(() => '{"roomId":7}');
  sink.write({ message: 'room changed' });
  windows[0].emit('session-end', { reasons: ['shutdown'] });
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { roomId: 7 });
  assert.equal(store.pending, false);
  const logged = fs.readFileSync(sink.filePath, 'utf8');
  assert.match(logged, /room changed/);

  windows[1].emit('session-end', { reasons: ['shutdown'] });
  assert.equal(fs.readFileSync(sink.filePath, 'utf8'), logged, 'the second window writes nothing again');
});

test('both windows flush at session end, and the quit path is declared before its first caller', () => {
  const main = readSource('electron/main.ts');
  assert.match(sliceBetween(main, 'function createOverlayWindow', 'function flushAdminPendingSaves'),
    /flushPendingWritesAtSessionEnd\(overlayWindow\);/);
  assert.match(sliceBetween(main, 'function createAdminWindow', 'function getInternalApiOrigin'),
    /flushPendingWritesAtSessionEnd\(adminWindow\);/);
  // A second instance calls requestApplicationQuit while the module is still
  // loading; the panel it reads must already be declared.
  const declared = main.indexOf('let adminWindow: BrowserWindow | null = null;');
  assert.ok(declared > 0 && declared < main.indexOf('if (!hasSingleInstanceLock) requestApplicationQuit();'));
  assert.equal((main.match(/let adminWindow\b/g) || []).length, 1);
  // The close guard still steps aside once a quit was requested.
  assert.match(extractFunctions('electron/main.ts', ['createAdminWindow']),
    /if \(pendingSavesFlush === 'done' \|\| applicationQuitRequested\) return;/);
});
