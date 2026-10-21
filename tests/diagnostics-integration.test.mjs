import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import zlib from 'node:zlib';
import ts from 'typescript';

const read = file => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const main = ts.createSourceFile('main.ts', read('electron/main.ts'), ts.ScriptTarget.Latest, true);
const transpile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
}).outputText;

function loadPolicy(file) {
  const module = { exports: {} };
  vm.runInNewContext(transpile(read(file)), { module, exports: module.exports });
  return module.exports;
}

const policy = loadPolicy('electron/diagnostics-policy.ts');
const roomPolicy = loadPolicy('electron/bili-room-connection-policy.ts');
const functionNames = [
  'getDiagnosticsState', 'diagnosticError', 'collectDiagnostics', 'repairDiagnosticAction',
  'runDiagnostics', 'getBiliRoomConnectionInfo', 'isDiagnosticRoomCurrent', 'dispatchBiliRoomConnectionEvent',
  'parseBiliPacket', 'handleRawDanmaku'
];
const declarations = functionNames.map(name => {
  const node = main.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  assert.ok(node, `Missing production function ${name}`);
  return node.getText(main);
});
for (const name of ['diagnosticsState', 'diagnosticsKeyword']) {
  const node = main.statements.find(statement => ts.isVariableStatement(statement)
    && statement.declarationList.declarations.some(declaration => declaration.name.getText(main) === name));
  assert.ok(node, `Missing production state ${name}`);
  declarations.unshift(node.getText(main));
}
const javascript = transpile(declarations.join('\n'));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture({ connected = true, status: statusOverrides = {} } = {}) {
  const calls = { catalogs: [], searches: [], reconnects: [], updates: [], commands: [] };
  const status = {
    id: 'qqmusic', name: 'QQ 音乐', installed: true, currentVersion: '22.60.1',
    latestVersion: '22.60.1', minimumCoreVersion: '1.1.10', compatible: true,
    updateAvailable: false, autoUpdateAvailable: false, manualUpdateAvailable: false,
    updateKind: 'none', supportedPlayerVersion: '22.60', updating: false,
    checkedAt: '2026-10-17T12:00:00Z', error: null, ...statusOverrides
  };
  const tracker = new policy.DanmakuReceptionTracker();
  tracker.resetSession(1, 42);
  const forbidden = name => () => assert.fail(`Diagnostic unexpectedly called ${name}`);
  const manager = {
    connectionState: {
      connected, connecting: false,
      snapshot: connected ? { connected: true, version: '22.60', capabilities: { search: true, playSelected: true } } : null
    },
    async getConnectorStatuses(...args) { calls.catalogs.push(args); return [{ ...status }]; },
    async searchConnected(keyword) { calls.searches.push(keyword); return [{ id: 'song', title: keyword }]; },
    search: forbidden('ordinary search'),
    execute: forbidden('playback command'),
    reconnect: forbidden('uncoordinated reconnect'),
    installConnector: forbidden('installation during check'),
    async updateConnector(...args) { calls.updates.push(args); return { success: true, message: '连接器已更新' }; }
  };
  let context;
  context = vm.createContext({
    ...policy, ...roomPolicy, Buffer, zlib,
    playerManager: manager, selectedPlayerKey: 'qqmusic',
    getSelectedPlayerKey: () => context.selectedPlayerKey,
    PLAYER_LABELS: { qqmusic: 'QQ 音乐', netease: '网易云音乐' },
    biliRoomSession: 1,
    biliRoomState: { session: 1, requestedRoomId: 42, realRoomId: 42, status: 'connected', message: '已连接' },
    danmakuReceptionTracker: tracker,
    appConfig: { roomId: 42, roomConnectionEnabled: true, sysConfig: {} },
    isAccepting: true, requestedQueuePlaybackEnabled: true, danmakuCommandQueue: [],
    updateInstallationGuard: { componentId: null }, connectorMaintenanceRunning: false,
    connectorAutoRepairInFlight: null, connectorConnectionRecoveryInFlight: null,
    userInitiatedConnectorUpdates: new Set(),
    sanitizeFeedbackLog: value => String(value), isBiliLoginReady: () => true,
    getGiftRequirementForGuardLevel: () => ({ requirement: {} }),
    canRequestWithGiftCredits: () => true, describeGiftRequestRequirement: () => '',
    checkPermission: () => ({ allowed: true }),
    withPlayerConnectionRecoverySuppressed: operation => operation(),
    async reconnectPlayerBridge(...args) { calls.reconnects.push(args); return true; },
    connectToLiveRoom: forbidden('room connection during ordinary check'),
    writeLog() {}, isGiftLearningActive: () => false, reportGiftTransportIssue() {},
    handleGiftEvent() {},
    enqueueDanmakuCommand: (...args) => calls.commands.push(args)
  });
  vm.runInContext(javascript, context);
  const seedReport = (actions, overrides = {}) => {
    context.reportToSeed = {
      checkedAt: Date.now(), playerKey: 'qqmusic', playerLabel: 'QQ 音乐', roomId: 42,
      checks: actions.map(repair => ({ id: repair, status: 'warning', repair })), ...overrides
    };
    vm.runInContext('diagnosticsState.report = reportToSeed;', context);
  };
  return { context, manager, status, tracker, calls, seedReport, state: () => context.getDiagnosticsState() };
}

function extractMethod(file, className, methodName) {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === className);
  const method = declaration?.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === methodName);
  assert.ok(method, `${className}.${methodName}`);
  const context = vm.createContext({});
  vm.runInContext(transpile(`class Subject { ${method.getText(source)} } globalThis.Subject = Subject;`), context);
  return context.Subject;
}

test('ordinary diagnostics use only the connected search and never claim playback or reception success', async () => {
  const f = fixture();
  await f.context.runDiagnostics(false, '晴天');
  assert.deepEqual(f.calls.catalogs, [[true, 'qqmusic']]);
  assert.deepEqual(f.calls.searches, ['晴天']);
  assert.equal(f.calls.updates.length + f.calls.reconnects.length + f.calls.commands.length, 0);
  assert.equal(f.state().error, '');
  const checks = new Map(f.state().report.checks.map(check => [check.id, check]));
  assert.equal(checks.get('song-search').status, 'pass');
  assert.equal(checks.get('playback-verification').status, 'unknown');
  assert.equal(checks.get('danmaku-reception').status, 'unknown');
  assert.equal(f.tracker.observation.count, 0);
});

test('connected search refuses bridge startup and discards results after a manager connection change', async () => {
  const Bridge = extractMethod('electron/player-bridge-client.ts', 'PlayerBridgeClient', 'searchConnected');
  const bridge = new Bridge();
  const requests = [];
  Object.assign(bridge, {
    running: true, activePlayer: 'qqmusic', startPromise: null, stopping: false,
    start: () => assert.fail('Connected search must not start a bridge'),
    request: async (...args) => { requests.push(args); return ['song']; }
  });
  assert.deepEqual(await bridge.searchConnected('qqmusic', '晴天'), ['song']);
  assert.equal(requests[0][0].action, 'search');
  for (const patch of [{ running: false }, { activePlayer: 'netease' }, { startPromise: Promise.resolve() }, { stopping: true }]) {
    Object.assign(bridge, { running: true, activePlayer: 'qqmusic', startPromise: null, stopping: false }, patch);
    await assert.rejects(bridge.searchConnected('qqmusic', '晴天'), /连接已变化/);
  }
  assert.equal(requests.length, 1);

  const Manager = extractMethod('electron/players/player-manager.ts', 'PlayerManager', 'searchConnected');
  const manager = new Manager();
  const gate = deferred();
  Object.assign(manager, {
    selectedKey: 'qqmusic', selectionGeneration: 1, state: { connected: true, connecting: false },
    bridge: { searchConnected: () => gate.promise }
  });
  const search = manager.searchConnected('晴天');
  manager.selectionGeneration++;
  gate.resolve(['old result']);
  await assert.rejects(search, /连接已变化/);
});

test('repeated diagnostic requests share the pending run and cannot start a repair concurrently', async () => {
  const f = fixture();
  const gate = deferred();
  let catalogCalls = 0;
  f.manager.getConnectorStatuses = () => { catalogCalls++; return gate.promise; };
  const pending = f.context.runDiagnostics(false, '晴天');
  assert.equal(f.state().busy, true);
  await f.context.runDiagnostics(true, '另一首歌');
  assert.equal(catalogCalls, 1);
  gate.resolve([{ ...f.status }]);
  await pending;
  assert.deepEqual(f.calls.searches, ['晴天']);
  assert.equal(f.calls.updates.length + f.calls.reconnects.length, 0);
  assert.equal(f.state().busy, false);
});

test('an offline catalog still permits coordinated reconnect of an installed connector without compatibility upgrades', async () => {
  const f = fixture({ connected: false, status: { error: '更新服务暂时不可达', latestVersion: null, compatible: false } });
  const result = await f.context.repairDiagnosticAction('reconnect-player', 'qqmusic', 42);
  assert.equal(result.success, true);
  assert.deepEqual(f.calls.reconnects, [[false]]);
  assert.equal(f.calls.updates.length, 0);
});

test('maintenance beginning while the catalog is awaited prevents diagnostic reconnect', async () => {
  for (const flag of ['connectorMaintenanceRunning', 'connectorAutoRepairInFlight', 'connectorConnectionRecoveryInFlight', 'updateInstallationGuard']) {
    const f = fixture({ connected: false });
    const gate = deferred();
    f.manager.getConnectorStatuses = () => gate.promise;
    const pending = f.context.repairDiagnosticAction('reconnect-player', 'qqmusic', 42);
    if (flag === 'updateInstallationGuard') f.context.updateInstallationGuard.componentId = 'qqmusic';
    else f.context[flag] = true;
    gate.resolve([{ ...f.status }]);
    const result = await pending;
    assert.equal(result.success, false, flag);
    assert.equal(f.calls.reconnects.length + f.calls.updates.length, 0, flag);
  }
});

test('diagnostic updates reject manual player branches and pass false for a permitted same-branch update', async () => {
  const manual = fixture({ status: { updateAvailable: true, manualUpdateAvailable: true, updateKind: 'player' } });
  assert.equal((await manual.context.repairDiagnosticAction('update-connector', 'qqmusic', 42)).success, false);
  assert.equal(manual.calls.updates.length, 0);
  const sameBranch = fixture({ status: { updateAvailable: true, autoUpdateAvailable: true, latestVersion: '22.60.2', updateKind: 'patch' } });
  assert.equal((await sameBranch.context.repairDiagnosticAction('update-connector', 'qqmusic', 42)).success, true);
  assert.deepEqual(sameBranch.calls.updates, [['qqmusic', false]]);
});

test('repair executes only the intersection of the shown report and freshly detected actions', async () => {
  const f = fixture({ connected: false, status: { updateAvailable: true, autoUpdateAvailable: true, latestVersion: '22.60.2' } });
  f.seedReport(['reconnect-player']);
  await f.context.runDiagnostics(true, '晴天');
  assert.equal(f.state().error, '');
  assert.deepEqual(f.calls.reconnects, [[false]]);
  assert.equal(f.calls.updates.length, 0, 'A newly discovered update was not previously shown');
  assert.deepEqual(Array.from(f.state().repairResults, result => result.action), ['reconnect-player']);

  const resolved = fixture();
  resolved.seedReport(['update-connector']);
  await resolved.context.runDiagnostics(true, '晴天');
  assert.equal(resolved.calls.updates.length, 0, 'An update that is no longer needed must not run');
  assert.equal(resolved.state().repairResults.length, 0);

  const shortRoom = fixture({ connected: false });
  Object.assign(shortRoom.context.biliRoomState, { realRoomId: 0, status: 'error' });
  shortRoom.seedReport(['reconnect-room', 'reconnect-player']);
  shortRoom.context.connectToLiveRoom = async () => {
    shortRoom.context.biliRoomSession++;
    Object.assign(shortRoom.context.biliRoomState, { realRoomId: 1042, status: 'connected' });
    return true;
  };
  await shortRoom.context.runDiagnostics(true, '晴天');
  assert.equal(shortRoom.state().error, '');
  assert.deepEqual(shortRoom.calls.reconnects, [[false]], 'Resolving the same short room must not cancel approved player repair');
  assert.ok(shortRoom.state().repairResults.every(result => result.success));
});

test('changing player or room during either awaited diagnostic stage clears the report with an error', async () => {
  for (const stage of ['catalog', 'search']) {
    for (const target of ['player', 'room']) {
      const f = fixture();
      const gate = deferred();
      const entered = deferred();
      if (stage === 'catalog') f.manager.getConnectorStatuses = () => { entered.resolve(); return gate.promise; };
      else f.manager.searchConnected = () => { entered.resolve(); return gate.promise; };
      const pending = f.context.runDiagnostics(false, '晴天');
      await entered.promise;
      if (target === 'player') f.context.selectedPlayerKey = 'netease';
      else f.context.biliRoomSession++;
      gate.resolve(stage === 'catalog' ? [{ ...f.status }] : [{ id: 'song' }]);
      await pending;
      assert.equal(f.state().report, null, `${stage}/${target}`);
      assert.match(f.state().error, /播放器或直播间已切换/, `${stage}/${target}`);
      assert.equal(f.state().busy, false);
      assert.equal(f.calls.updates.length + f.calls.reconnects.length, 0);
    }
  }
});

test('repair without a current matching shown report cannot collect or mutate anything', async () => {
  for (const mismatch of ['missing', 'room', 'player']) {
    const f = fixture();
    if (mismatch !== 'missing') f.seedReport(['update-connector'], mismatch === 'room' ? { roomId: 99 } : { playerKey: 'netease' });
    await f.context.runDiagnostics(true, '晴天');
    assert.match(f.state().error, /请先重新检查/);
    assert.equal(f.state().report, null);
    assert.equal(f.calls.catalogs.length + f.calls.searches.length + f.calls.updates.length + f.calls.reconnects.length, 0);
  }
});

function packet(document, operation = 5) {
  const body = Buffer.from(JSON.stringify(document));
  const header = Buffer.alloc(16);
  header.writeInt32BE(16 + body.length);
  header.writeInt16BE(16, 4);
  header.writeInt16BE(0, 6);
  header.writeInt32BE(operation, 8);
  header.writeInt32BE(1, 12);
  return Buffer.concat([header, body]);
}

test('only an authenticated real DANMU_MSG proves reception and disconnect invalidates that proof', () => {
  const f = fixture();
  const phrase = '嗷呜测试a1b2c3';
  const message = { cmd: 'DANMU_MSG:4:0:2', info: [[], phrase, ['123', '观众', 0], [], [], [], [], 0] };
  f.tracker.start(1, 42, phrase);
  f.context.parseBiliPacket(packet(message, 3));
  f.context.parseBiliPacket(packet({ cmd: 'INTERACT_WORD', data: { msg: phrase } }));
  f.context.parseBiliPacket(packet({ cmd: 'DANMU_MSG', info: [[], phrase] }));
  assert.equal(f.tracker.getState().status, 'waiting');
  assert.equal(f.tracker.observation.count, 0);
  f.context.biliRoomState.status = 'connecting';
  f.context.parseBiliPacket(packet(message));
  assert.equal(f.tracker.getState().status, 'waiting');
  assert.equal(f.tracker.observation.count, 0);
  f.context.biliRoomState.status = 'connected';
  f.context.parseBiliPacket(packet(message));
  assert.equal(f.tracker.getState().status, 'received');
  assert.equal(f.tracker.observation.count, 1);
  f.context.dispatchBiliRoomConnectionEvent({ type: 'disconnect-requested', session: 2, requestedRoomId: 42 });
  assert.equal(f.tracker.getState().status, 'cancelled');
  assert.equal(f.tracker.getState().receivedAt, null);
  assert.equal(f.tracker.observation.count, 0);
});
