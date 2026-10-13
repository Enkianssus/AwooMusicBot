import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as policy from '../electron/qq-native-compatibility-policy.ts';

const capabilities = {
  search: true, playSelected: true, previous: true, pause: true, resume: true,
  toggle: false, next: true, insertNext: true, insertNextLevel: 'native'
};
const snapshot = (supported, extra = {}) => ({
  connected: true, player: 'QQ 音乐', processId: 7, version: '22.76',
  status: 'connected', observedAt: new Date().toISOString(),
  capabilities: { ...capabilities, playSelected: supported, insertNext: supported },
  compatibilityFailureCode: supported ? null : 'player-version-unsupported', ...extra
});
const queueCommands = ['PlaySelected', 'InterruptSelected', 'InsertNext', 'ArmNextGuard'];

function compileModule(relative, require) {
  const source = fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, { module, exports: module.exports, require, console, setTimeout, clearTimeout });
  return module.exports;
}

test('unsupported native queue leaves manual controls, search and other players available', () => {
  for (const command of queueCommands) {
    assert.equal(policy.rejectUnsupportedQqCommand('qqmusic', command, snapshot(false))?.failureCode,
      'player-version-unsupported');
    assert.equal(policy.rejectUnsupportedQqCommand('netease', command, snapshot(false)), null);
    assert.equal(policy.rejectUnsupportedQqCommand('qqmusic', command, snapshot(true)), null);
  }
  for (const command of ['Next', 'Previous', 'Pause', 'Resume', 'Search']) {
    assert.equal(policy.rejectUnsupportedQqCommand('qqmusic', command, snapshot(false)), null);
  }
  assert.match(policy.qqNativeCompatibilityMessage('22.76'), /尚未适配/);
  assert.doesNotMatch(policy.qqNativeCompatibilityMessage('22.76'), /升级播放器|降级/);
  assert.equal(policy.isQqNativeQueueUnavailable('qqmusic', snapshot(true, {
    compatibilityFailureCode: 'player-version-unsupported'
  })), true);
});

function bridgeHarness() {
  const { PlayerBridgeClient } = compileModule('../electron/player-bridge-client.ts', name => {
    if (name === './qq-native-compatibility-policy') return policy;
    return {};
  });
  const bridge = Object.create(PlayerBridgeClient.prototype);
  const requests = [];
  const events = [];
  Object.assign(bridge, {
    activePlayer: 'qqmusic', activeCapabilities: capabilities, latestSnapshot: null,
    start: async () => {}, onLog: () => {}, onEvent: event => events.push(event),
    request: async payload => { requests.push(payload); return bridge.response; }
  });
  return { bridge, requests, events };
}

test('actual bridge probe, event and command receipts preserve true → false → true capabilities', async () => {
  const { bridge, requests, events } = bridgeHarness();
  bridge.response = snapshot(true);
  assert.equal((await bridge.probe('qqmusic')).capabilities.insertNext, true);
  bridge.consumeLine(JSON.stringify({ type: 'event', event: 'snapshot', player: 'qqmusic',
    sequence: 1, snapshot: snapshot(false) }));
  assert.equal(events[0].snapshot.capabilities.insertNext, false);
  const before = requests.length;
  for (const command of queueCommands) {
    assert.equal((await bridge.execute('qqmusic', command)).outcome, 'rejected');
  }
  assert.equal(requests.length, before, 'no queue command RPC after unsupported event');
  bridge.response = { outcome: 'verified', snapshot: snapshot(true) };
  const manual = await bridge.execute('qqmusic', 'Next');
  assert.equal(manual.snapshot.capabilities.insertNext, true);
  await bridge.execute('qqmusic', 'InsertNext');
  assert.equal(requests.at(-1).command, 'InsertNext', 'recovery needs no core restart');
  bridge.response = snapshot(false);
  assert.equal((await bridge.probe('qqmusic')).capabilities.playSelected, false);
});

test('old connector snapshots and receipts without capabilities retain ping fallback', async () => {
  const { bridge, events } = bridgeHarness();
  const legacy = snapshot(true);
  delete legacy.capabilities;
  delete legacy.compatibilityFailureCode;
  bridge.response = legacy;
  assert.equal((await bridge.probe('qqmusic')).capabilities, capabilities);
  bridge.consumeLine(JSON.stringify({ type: 'event', event: 'snapshot', player: 'qqmusic',
    sequence: 1, snapshot: legacy }));
  assert.equal(events[0].snapshot.capabilities, capabilities);
  bridge.response = { outcome: 'accepted', snapshot: legacy };
  assert.equal((await bridge.execute('qqmusic', 'InsertNext')).snapshot.capabilities, capabilities);
});

test('actual manager consumes command compatibility state and rejects before backend RPC', async () => {
  const { PlayerManager } = compileModule('../electron/players/player-manager.ts', name => {
    if (name === '../qq-native-compatibility-policy') return policy;
    if (name === './types') return { isSuccessfulPlayerResult: r => r.outcome === 'verified' };
    return {};
  });
  const manager = Object.create(PlayerManager.prototype);
  const changes = [];
  let calls = 0;
  Object.assign(manager, {
    options: { getSelectedKey: () => 'qqmusic', log: () => {},
      onStateChanged: state => changes.push(state) },
    operationTail: Promise.resolve(), state: { connected: true, connecting: false, snapshot: snapshot(true) },
    backends: { qqmusic: { label: 'QQ 音乐', execute: async () => {
      calls++; return { outcome: 'verified', snapshot: snapshot(false) };
    } } },
    queueObservation: () => {}
  });
  await manager.execute('Next');
  assert.equal(changes.at(-1).snapshot.capabilities.insertNext, false);
  for (const command of queueCommands) await manager.execute(command);
  assert.equal(calls, 1);
  manager.handleBridgeEvent({ player: 'qqmusic', event: 'snapshot', snapshot: snapshot(true) });
  await manager.execute('InsertNext');
  assert.equal(calls, 2);
});

test('actual main queue entry points keep requests and avoid correction/dispatch while unsupported', async () => {
  const text = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const source = ts.createSourceFile('main.ts', text, ts.ScriptTarget.Latest, true);
  const names = ['holdUnsupportedQqQueue', 'syncTrackChangeLogic', 'guardNextSong', 'armNextGuardOnly', 'playSongNow'];
  const bodies = source.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text))
    .map(n => n.getText(source)).join('\n');
  const requests = [{ SongName: 'pending' }];
  const logs = [];
  const context = {
    ...policy, activePlayerSnapshot: snapshot(false), getSelectedPlayerKey: () => 'qqmusic',
    playerControlNotice: null, qqAutoplayGeneration: 0, targetQueue: requests,
    clearRegisteredNextGuard() {}, clearDeferredQqInsert() {}, clearRecentQqGuardedCompletion() {},
    clearSkipForcePlayOnce() {}, queueHeadNeedsGuardOnlyAfterCurrentChange: true,
    activeManagedPlayerAction: null, playerPausedAfterRequests: false,
    updatePlayerCurrentTrack() {}, writeLog: message => logs.push(message), setGlobalStatus() {},
    serializeNextGuardOperation: async action => action(),
    executePlayerCommand: () => assert.fail('unsupported queue must not dispatch'),
    Date
  };
  vm.createContext(context);
  vm.runInContext(ts.transpileModule(bodies, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText, context);
  assert.equal(await context.guardNextSong(requests[0]), false);
  assert.equal(await context.armNextGuardOnly(requests[0]), false);
  assert.equal(await context.playSongNow(requests[0]), false);
  await context.syncTrackChangeLogic('1', 'manual', null, 'unknown');
  await context.syncTrackChangeLogic('2', 'manual again', null, 'unknown');
  assert.equal(requests.length, 1);
  assert.equal(logs.length, 1, 'one compatibility notice, no repeated fallback logs');
  context.activePlayerSnapshot = snapshot(true);
  assert.equal(context.holdUnsupportedQqQueue(), false);
});
