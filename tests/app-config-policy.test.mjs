import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import path from 'node:path';
import { extractFunctions, readSource, sliceBetween } from './helpers/source.mjs';
import {
  COOLDOWN_TIERS,
  MAX_SUPER_USERS,
  PERMISSION_KEYS,
  createDefaultAppConfig,
  createDefaultPermission,
  createDefaultSysConfig,
  normalizeRoomId,
  normalizeSysConfig,
  normalizeUiColorMode
} from '../electron/app-config-policy.ts';

const ENV = { envInternalPort: 6100 };

test('defaults are complete, include the dynamic cover switch and are never shared', () => {
  const defaults = createDefaultSysConfig(ENV);
  assert.deepEqual(defaults, {
    PlayerType: 'NCM',
    FoliaToken: '',
    Cooldowns: { Normal: 0, Captain: 0, Admiral: 0, Governor: 0 },
    GiftRequestRequirements: {
      Normal: { giftName: '', giftId: '' },
      Captain: { giftName: '', giftId: '' },
      Admiral: { giftName: '', giftId: '' },
      Governor: { giftName: '', giftId: '' }
    },
    IdleWaitNext: true,
    ShowPlayerCurrentTrack: true,
    PauseAfterRequests: false,
    RequestedSongArtwork: 'bili_avatar',
    DynamicCoverEnabled: true,
    ShowAllDanmaku: false,
    SuperUsers: [],
    ExternalHttpEnabled: false,
    ExternalWebSocketEnabled: false,
    ExternalApiPort: 5556,
    InternalApiPort: 6100
  });
  assert.equal(createDefaultSysConfig().InternalApiPort, 5555);
  assert.equal(createDefaultSysConfig({ envInternalPort: 80 }).InternalApiPort, 5555);

  const other = createDefaultSysConfig(ENV);
  other.Cooldowns.Normal = 9;
  other.SuperUsers.push('someone');
  other.GiftRequestRequirements.Normal.giftId = '1';
  assert.deepEqual(createDefaultSysConfig(ENV), defaults);

  // Normalizing the defaults changes nothing.
  assert.deepEqual(normalizeSysConfig(defaults, ENV), defaults);
});

test('the default app config holds the default settings and no room', () => {
  assert.deepEqual(createDefaultAppConfig(ENV), {
    roomId: 0,
    roomConnectionEnabled: false,
    myRoomId: 0,
    biliCookie: '',
    biliUid: 0,
    learnedGifts: [],
    widgetStyle: null,
    sysConfig: createDefaultSysConfig(ENV)
  });
});

test('missing keys of an older config are filled with the defaults', () => {
  const normalized = normalizeSysConfig({ PlayerType: 'QQMusic' }, ENV);
  assert.deepEqual(normalized, { ...createDefaultSysConfig(ENV), PlayerType: 'QQMusic' });
  assert.equal(normalized.DynamicCoverEnabled, true);
});

test('a missing or broken sysConfig starts from the defaults and adopts legacy super users', () => {
  for (const raw of [undefined, null, 0, '', 'text', [], [1, 2]]) {
    assert.deepEqual(normalizeSysConfig(raw, ENV), createDefaultSysConfig(ENV), String(raw));
  }
  assert.deepEqual(
    normalizeSysConfig(null, { ...ENV, legacySuperUsers: ['主播', 42, ''] }).SuperUsers,
    ['主播', '42']
  );
  // An existing sysConfig keeps its own list.
  assert.deepEqual(
    normalizeSysConfig({ SuperUsers: ['current'] }, { ...ENV, legacySuperUsers: ['old'] }).SuperUsers,
    ['current']
  );
});

test('cooldowns become whole seconds that never shorten the wait the raw value imposed', () => {
  const { Cooldowns } = normalizeSysConfig({
    Cooldowns: { Normal: '5', Captain: -1, Admiral: Number.NaN, Governor: 2.1, Future: 'kept' }
  }, ENV);
  // 2.1 s rounds up: the request check compares with `passed < cooldown`.
  assert.deepEqual(Cooldowns, { Normal: 5, Captain: 0, Admiral: 0, Governor: 3, Future: 'kept' });

  for (const value of [-Infinity, '', ' ', 'abc', '5s', null, false, {}, [], -0.5]) {
    assert.equal(
      normalizeSysConfig({ Cooldowns: { Normal: value } }, ENV).Cooldowns.Normal,
      0,
      String(value)
    );
  }
  // JavaScript compares true as 1 and a one-element array as its element.
  assert.equal(normalizeSysConfig({ Cooldowns: { Normal: true } }, ENV).Cooldowns.Normal, 1);
  assert.equal(normalizeSysConfig({ Cooldowns: { Normal: [30] } }, ENV).Cooldowns.Normal, 30);
  // A wait too long for JSON stays practically endless instead of becoming none.
  for (const value of [Infinity, 2 ** 60]) {
    assert.equal(
      normalizeSysConfig({ Cooldowns: { Normal: value } }, ENV).Cooldowns.Normal,
      Number.MAX_SAFE_INTEGER,
      String(value)
    );
  }
  assert.equal(normalizeSysConfig({ Cooldowns: { Normal: ' 30 ' } }, ENV).Cooldowns.Normal, 30);
  for (const value of [null, 'x', 5, []]) {
    assert.deepEqual(
      normalizeSysConfig({ Cooldowns: value }, ENV).Cooldowns,
      { Normal: 0, Captain: 0, Admiral: 0, Governor: 0 }
    );
  }
  assert.deepEqual(COOLDOWN_TIERS, ['Normal', 'Captain', 'Admiral', 'Governor']);
});

test('the old per-minute cooldown migrates once into every tier', () => {
  const migrated = normalizeSysConfig({ CooldownMinutes: 2 }, ENV);
  assert.deepEqual(migrated.Cooldowns, { Normal: 120, Captain: 120, Admiral: 120, Governor: 120 });
  assert.equal(Object.hasOwn(migrated, 'CooldownMinutes'), false);

  assert.equal(normalizeSysConfig({ CooldownMinutes: '1' }, ENV).Cooldowns.Captain, 60);
  assert.equal(normalizeSysConfig({ CooldownMinutes: 'x' }, ENV).Cooldowns.Normal, 0);

  // Existing per-tier cooldowns win; the old value is left alone as before.
  const current = normalizeSysConfig({ CooldownMinutes: 2, Cooldowns: { Normal: 7 } }, ENV);
  assert.equal(current.Cooldowns.Normal, 7);
  assert.equal(current.CooldownMinutes, 2);
});

test('super users are kept exactly as written; only entries that cannot match are dropped', () => {
  const thirtyTwo = '字'.repeat(32);
  const normalized = normalizeSysConfig({
    SuperUsers: [
      '  主播  ', '主播', '主播', '', '   ', 12345, 0, -5, 1.5, null, undefined, {}, ['x'], true,
      thirtyTwo, `${thirtyTwo}多`, '😀'.repeat(32), '😀'.repeat(33)
    ]
  }, ENV);
  // The super user check compares names exactly, so '  主播  ' is not widened to '主播'.
  assert.deepEqual(normalized.SuperUsers, ['  主播  ', '主播', '12345', thirtyTwo, '😀'.repeat(32)]);

  const many = Array.from({ length: MAX_SUPER_USERS + 50 }, (_, index) => `user${index}`);
  const capped = normalizeSysConfig({ SuperUsers: many }, ENV).SuperUsers;
  assert.equal(capped.length, MAX_SUPER_USERS);
  assert.deepEqual(capped, many.slice(0, MAX_SUPER_USERS));

  for (const value of [null, 'user', 5, { 0: 'user' }]) {
    assert.deepEqual(normalizeSysConfig({ SuperUsers: value }, ENV).SuperUsers, []);
  }
});

test('every permission key: unsaved stays absent, a non-object takes the default, missing fields stay as strict as today', () => {
  const unsaved = normalizeSysConfig({}, ENV);
  for (const key of PERMISSION_KEYS) assert.equal(Object.hasOwn(unsaved, key), false, key);
  assert.equal(PERMISSION_KEYS.length, 6);

  for (const key of PERMISSION_KEYS) {
    const managersOnly = key === 'ForceControlPermission';
    const defaults = createDefaultPermission(key);
    assert.deepEqual(defaults, { AllowManager: true, MinGuardType: managersOnly ? -1 : 0, MinMedalLevel: 0 }, key);
    for (const raw of [null, 0, '', false, 'yes', 5, true, [], [3]]) {
      assert.deepEqual(normalizeSysConfig({ [key]: raw }, ENV)[key], defaults, `${key} ${JSON.stringify(raw)}`);
    }
    // The check reads a missing AllowManager as false. A missing guard
    // requirement means none, except where the default (managers only) is stricter.
    assert.deepEqual(normalizeSysConfig({ [key]: {} }, ENV)[key], {
      AllowManager: false, MinGuardType: managersOnly ? -1 : 0, MinMedalLevel: 0
    }, key);
    assert.deepEqual(normalizeSysConfig({
      [key]: { AllowManager: 'false', MinGuardType: '3', MinMedalLevel: '10', Note: 'kept' }
    }, ENV)[key], { AllowManager: true, MinGuardType: 3, MinMedalLevel: 10, Note: 'kept' }, key);
    assert.deepEqual(normalizeSysConfig({
      [key]: { AllowManager: 0, MinGuardType: 2.5, MinMedalLevel: 7.2 }
    }, ENV)[key], { AllowManager: false, MinGuardType: 2, MinMedalLevel: 8 }, key);
    assert.deepEqual(normalizeSysConfig({
      [key]: { AllowManager: true, MinGuardType: 'abc', MinMedalLevel: -3 }
    }, ENV)[key], { AllowManager: true, MinGuardType: 0, MinMedalLevel: 0 }, key);
  }

  const guard = value => normalizeSysConfig({ OrderPermission: { MinGuardType: value } }, ENV).OrderPermission.MinGuardType;
  for (const [value, expected] of [[-1, -1], ['-1', -1], [0, 0], [1, 1], [2, 2], [3, 3], [5, 3], ['2', 2],
    [1.5, 1], [0.5, -1], [-2, 0], [null, 0], [true, 1], [Number.NaN, 0]]) {
    assert.equal(guard(value), expected, String(value));
  }
  for (const value of [Infinity, 2 ** 60]) {
    assert.equal(
      normalizeSysConfig({ OrderPermission: { MinMedalLevel: value } }, ENV).OrderPermission.MinMedalLevel,
      Number.MAX_SAFE_INTEGER
    );
  }
});

test('normalized permissions never admit a viewer the production check would refuse', () => {
  // The real checkPermission from main.ts, run against the raw and the normalized value.
  const context = vm.createContext({
    appConfig: { sysConfig: {} },
    isBiliLoginReady: () => true,
    isConfiguredSuperUser: () => false
  });
  vm.runInContext(ts.transpileModule(extractFunctions('electron/main.ts', ['checkPermission']), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText, context);
  const allowed = (sysConfig, user, key) => {
    context.appConfig = { sysConfig };
    return context.checkPermission(user, key).allowed;
  };

  const users = [];
  for (const isManager of [false, true]) {
    for (const guardLevel of [0, 1, 2, 3]) {
      for (const medalLevel of [0, 1, 7, 8, 10, 40]) {
        users.push({ uid: '1', uname: 'viewer', isManager, guardLevel, medalLevel });
      }
    }
  }
  // Values the normalizer deliberately reads more strictly than the check does.
  const stricter = (key, raw) => (key === 'ForceControlPermission'
      && (raw === null || typeof raw !== 'object' || Array.isArray(raw) || raw.MinGuardType === undefined))
    || (raw !== null && typeof raw === 'object' && raw.MinGuardType === '-1');
  const raws = [undefined, null, 0, '', false, 'yes', 5, true, [], [3], {}, { AllowManager: true },
    { AllowManager: 'false' }, { AllowManager: 0, MinGuardType: 3 }, { MinGuardType: '-1', AllowManager: true },
    { MinGuardType: -1, AllowManager: true }, { MinGuardType: -1 }, { MinGuardType: 0.5, AllowManager: true },
    { MinGuardType: 1.5 }, { MinGuardType: 2.5, MinMedalLevel: 7.2 }, { MinGuardType: 5, AllowManager: true },
    { MinGuardType: '3', MinMedalLevel: '10' }, { MinGuardType: true }, { MinGuardType: 'abc' },
    { MinGuardType: null }, { MinMedalLevel: Infinity }, { MinMedalLevel: 2 ** 60 }, { MinMedalLevel: -3 },
    { AllowManager: true, MinGuardType: -1, MinMedalLevel: 10 }, { AllowManager: 1, MinGuardType: 2, MinMedalLevel: 8 }];

  let compared = 0;
  for (const key of PERMISSION_KEYS) {
    for (const raw of raws) {
      const rawConfig = raw === undefined ? {} : { [key]: raw };
      const normalized = normalizeSysConfig(rawConfig, ENV);
      for (const user of users) {
        const before = allowed(rawConfig, user, key);
        const after = allowed(normalized, user, key);
        const label = `${key} ${JSON.stringify(raw)} ${JSON.stringify(user)}`;
        if (after) assert.equal(before, true, `normalization admitted more: ${label}`);
        if (!stricter(key, raw)) assert.equal(after, before, `normalization changed the result: ${label}`);
        compared += 1;
      }
    }
  }
  assert.equal(compared, PERMISSION_KEYS.length * raws.length * users.length);
});

test('enums, the Folia token, booleans and ports keep the meaning the app gives them', () => {
  const normalized = normalizeSysConfig({
    PlayerType: 'Spotify',
    FoliaToken: undefined,
    RequestedSongArtwork: 'cover',
    IdleWaitNext: 'no',
    ShowPlayerCurrentTrack: null,
    PauseAfterRequests: 'true',
    DynamicCoverEnabled: 0,
    ShowAllDanmaku: 1,
    ExternalHttpEnabled: 1,
    ExternalWebSocketEnabled: true,
    ExternalApiPort: '6001',
    InternalApiPort: 80
  }, ENV);
  assert.equal(normalized.PlayerType, 'NCM');
  assert.equal(normalized.FoliaToken, '');
  assert.equal(normalized.RequestedSongArtwork, 'bili_avatar');
  assert.equal(normalized.IdleWaitNext, true);
  assert.equal(normalized.ShowPlayerCurrentTrack, true);
  assert.equal(normalized.PauseAfterRequests, false);
  assert.equal(normalized.DynamicCoverEnabled, true);
  assert.equal(normalized.ShowAllDanmaku, true);
  assert.equal(normalized.ExternalHttpEnabled, false);
  assert.equal(normalized.ExternalWebSocketEnabled, true);
  assert.equal(normalized.ExternalApiPort, 6001);
  assert.equal(normalized.InternalApiPort, 6100);

  for (const type of ['NCM', 'Kugou', 'QQMusic', 'Folia']) {
    assert.equal(normalizeSysConfig({ PlayerType: type }, ENV).PlayerType, type);
  }
  assert.equal(normalizeSysConfig({ RequestedSongArtwork: 'song_cover' }, ENV).RequestedSongArtwork, 'song_cover');
  assert.equal(normalizeSysConfig({ FoliaToken: ' token ' }, ENV).FoliaToken, ' token ');
  assert.equal(normalizeSysConfig({ FoliaToken: { value: 1 } }, ENV).FoliaToken, '');
  assert.equal(normalizeSysConfig({ DynamicCoverEnabled: false }, ENV).DynamicCoverEnabled, false);
  assert.equal(normalizeSysConfig({ IdleWaitNext: false }, ENV).IdleWaitNext, false);
  assert.equal(normalizeSysConfig({ ShowPlayerCurrentTrack: false }, ENV).ShowPlayerCurrentTrack, false);
  assert.equal(normalizeSysConfig({ PauseAfterRequests: true }, ENV).PauseAfterRequests, true);
  for (const port of [1023, 65536, 6000.5, 'x', null]) {
    assert.equal(normalizeSysConfig({ ExternalApiPort: port }, ENV).ExternalApiPort, 5556, String(port));
  }
  assert.equal(normalizeSysConfig({ InternalApiPort: '7000' }, ENV).InternalApiPort, 7000);
});

test('gift requirements go through the existing gift normalizer', () => {
  const normalized = normalizeSysConfig({
    GiftRequestRequirements: { Normal: { GiftName: '  牛哇牛哇  ', GiftId: 123 }, Captain: 'invalid' }
  }, ENV);
  assert.deepEqual(normalized.GiftRequestRequirements, {
    Normal: { giftName: '牛哇牛哇', giftId: '123' },
    Captain: { giftName: '', giftId: '' },
    Admiral: { giftName: '', giftId: '' },
    Governor: { giftName: '', giftId: '' }
  });
});

test('unknown keys are preserved unchanged and the input is not modified', () => {
  const nested = { mode: 'neon', list: [1, { a: true }] };
  const raw = {
    FutureFeature: nested,
    FutureFlag: false,
    FutureText: '  spaced  ',
    PlayerType: 'Kugou',
    Cooldowns: { Normal: '5' },
    SuperUsers: [' a ']
  };
  const snapshot = structuredClone(raw);
  const normalized = normalizeSysConfig(raw, ENV);
  assert.equal(normalized.FutureFeature, nested);
  assert.deepEqual(normalized.FutureFeature, snapshot.FutureFeature);
  assert.equal(normalized.FutureFlag, false);
  assert.equal(normalized.FutureText, '  spaced  ');
  assert.deepEqual(raw, snapshot);
  assert.notEqual(normalized, raw);
  // Saved keys keep their order; missing defaults follow them.
  assert.deepEqual(Object.keys(normalized).slice(0, 6), [
    'FutureFeature', 'FutureFlag', 'FutureText', 'PlayerType', 'Cooldowns', 'SuperUsers'
  ]);
});

test('normalizing twice gives the same result, so saving and loading never drift', () => {
  const messy = {
    PlayerType: 'x', FoliaToken: 42, Cooldowns: { Normal: '5', Captain: -2, Extra: true },
    SuperUsers: [' a ', 'a', 7], OrderPermission: { MinGuardType: '2' }, ForceControlPermission: null,
    CooldownMinutes: 3, ExternalApiPort: '70000', InternalApiPort: '6200', EnableCDP: true,
    GiftRequestRequirements: { Governor: { GiftName: 'x' } }, Future: { nested: [1] }
  };
  const once = normalizeSysConfig(messy, ENV);
  const twice = normalizeSysConfig(JSON.parse(JSON.stringify(once)), ENV);
  assert.deepEqual(twice, once);
  assert.equal(once.FoliaToken, '42');
  assert.equal(once.InternalApiPort, 6200);
  assert.equal(once.ExternalApiPort, 5556);
});

test('legacy and derived keys are removed', () => {
  const normalized = normalizeSysConfig({
    EnableCDP: true,
    CdpPort: 9222,
    NcmExePath: 'C:\\cloudmusic.exe',
    FoliaTokenConfigured: true,
    FoliaToken: 'secret'
  }, ENV);
  for (const key of ['EnableCDP', 'CdpPort', 'NcmExePath', 'FoliaTokenConfigured']) {
    assert.equal(Object.hasOwn(normalized, key), false, key);
  }
  assert.equal(normalized.FoliaToken, 'secret');
});

test('room IDs must be safe positive integers, otherwise the previous room is kept', () => {
  assert.equal(normalizeRoomId(123, 0), 123);
  assert.equal(normalizeRoomId('456', 1), 456);
  assert.equal(normalizeRoomId(' 789 ', 1), 789);
  for (const value of [0, -1, 1.5, '1.5', '-3', 'abc', '', ' ', null, undefined, NaN, Infinity,
    2 ** 53, '9007199254740993', {}, [123], true]) {
    assert.equal(normalizeRoomId(value, 321), 321, String(value));
  }
  assert.equal(normalizeRoomId('x', '654'), 654);
  for (const previous of [undefined, null, -1, 'x', 1.5]) {
    assert.equal(normalizeRoomId('x', previous), 0, String(previous));
  }
  assert.equal(normalizeRoomId('x'), 0);
});

test('the control panel colour mode is light only when light was reported', () => {
  assert.equal(normalizeUiColorMode('light'), 'light');
  for (const value of ['dark', 'LIGHT', '', null, undefined, 1]) {
    assert.equal(normalizeUiColorMode(value), 'dark', String(value));
  }
});

test('the control panel reopens in the last colour mode it reported, with a 36 px caption', () => {
  const main = readSource('electron/main.ts');
  const source = [
    sliceBetween(main, '/** The height of .studio-titlebar', '/** Caption buttons'),
    extractFunctions('electron/main.ts', ['adminTitleBarOverlay', 'createAdminWindow']),
    sliceBetween(main, "ipcMain.on('set-window-color-mode'", "ipcMain.handle('open-external'")
  ].join('\n');

  const windowsByContents = new Map();
  const created = [];
  class FakeBrowserWindow {
    static fromWebContents(contents) { return windowsByContents.get(contents) || null; }
    constructor(options) {
      this.options = options;
      this.webContents = {};
      this.calls = [];
      windowsByContents.set(this.webContents, this);
      created.push(this);
    }
    once() {}
    on() {}
    isDestroyed() { return false; }
    setBackgroundColor(color) { this.calls.push(['background', color]); }
    setTitleBarOverlay(options) { this.calls.push(['caption', options]); }
  }
  const overlay = new FakeBrowserWindow({ transparent: true });
  const handlers = {};
  let saves = 0;
  const context = vm.createContext({
    BrowserWindow: FakeBrowserWindow,
    adminWindow: null,
    overlayWindow: overlay,
    appConfig: {},
    normalizeUiColorMode, path, __dirname: '/app',
    presentAdminWindow() {}, trustRendererWindow() {}, watchRendererHealth() {}, loadWindow() {},
    setAdminWindowTopmost() {}, syncOverlayAlwaysOnTop() {}, applicationQuitRequested: false,
    flushAdminPendingSaves: async () => {}, flushPendingWritesAtSessionEnd() {},
    ipcMain: { on: (name, handler) => { handlers[name] = handler; } },
    process: { platform: 'win32' },
    saveConfig: () => { saves += 1; }
  });
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);

  context.createAdminWindow();
  const panel = created[1];
  assert.equal(panel.options.backgroundColor, '#0c1423');
  assert.deepEqual({ ...panel.options.titleBarOverlay }, { color: '#0c1423', symbolColor: '#d9e8f8', height: 36 });

  const report = (win, mode) => handlers['set-window-color-mode']({ sender: win.webContents }, mode);
  report(panel, 'light');
  assert.deepEqual(JSON.parse(JSON.stringify(panel.calls)), [
    ['background', '#f5faff'],
    ['caption', { color: '#f5faff', symbolColor: '#244766', height: 36 }]
  ]);
  assert.equal(context.appConfig.uiColorMode, 'light');
  assert.equal(saves, 1);
  report(panel, 'light');
  assert.equal(saves, 1, 'an unchanged mode is not saved again');

  // The overlay window, and anything that is not a mode, never changes the preference.
  report(overlay, 'dark');
  report(panel, 'blue');
  assert.equal(context.appConfig.uiColorMode, 'light');
  assert.equal(saves, 1);
  assert.deepEqual(overlay.calls, []);

  // Reopening the panel uses the remembered mode from the start.
  context.adminWindow = null;
  context.createAdminWindow();
  const reopened = created[2];
  assert.equal(reopened.options.backgroundColor, '#f5faff');
  assert.deepEqual({ ...reopened.options.titleBarOverlay }, { color: '#f5faff', symbolColor: '#244766', height: 36 });

  // The close guard that sends pending edits first is untouched.
  const admin = extractFunctions('electron/main.ts', ['createAdminWindow']);
  assert.match(admin, /void flushAdminPendingSaves\(closingWindow\)\.finally\(/);
  assert.match(admin, /if \(pendingSavesFlush === 'done' \|\| applicationQuitRequested\) return;/);
});
