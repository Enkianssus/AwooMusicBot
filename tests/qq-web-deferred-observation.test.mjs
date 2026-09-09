import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import * as queuePolicy from '../electron/queue-head-policy.ts';
import * as playerTypes from '../electron/players/types.ts';

// Run the actual manager methods with inert bridge/backend constructors. No
// Electron module, connector process, media session, network or UI is loaded.
const managerSource = fs.readFileSync(
  new URL('../electron/players/player-manager.ts', import.meta.url), 'utf8'
);
const compiled = ts.transpileModule(managerSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
}).outputText;
class InertBackend {}
const imports = {
  '../player-bridge-client': { PlayerBridgeClient: InertBackend },
  '../queue-head-policy': queuePolicy,
  '../player-process-inspector': {
    inspectPlayerProcess() { throw new Error('Pure tests must not inspect processes'); }
  },
  './folia-player': { FoliaPlayerBackend: InertBackend },
  './kugou-player': { KugouPlayerBackend: InertBackend },
  './netease-player': { NeteasePlayerBackend: InertBackend },
  './qqmusic-player': { QQMusicPlayerBackend: InertBackend },
  './types': playerTypes
};
const module = { exports: {} };
new vm.Script(`(function(require, module, exports) { ${compiled}\n})`)
  .runInNewContext()(
    name => {
      assert.ok(Object.hasOwn(imports, name), `Unexpected manager dependency: ${name}`);
      return imports[name];
    }, module, module.exports
  );
const { PlayerManager } = module.exports;

function snapshot(title, nextTitle, extra = {}) {
  return {
    connected: true,
    player: 'QQ Music',
    processId: 123,
    version: 'experimental-web',
    status: title,
    current: { id: title, title, artist: 'Artist', album: '' },
    next: nextTitle
      ? { id: nextTitle, title: nextTitle, artist: 'Artist', album: '' }
      : null,
    nextSource: nextTitle ? 'qq-logical-guard' : '',
    nextObservation: nextTitle ? 'track' : 'unknown',
    ownsLogicalNext: true,
    requiresPlaybackAnchor: false,
    observedAt: '2026-09-09T00:00:02Z',
    ...extra
  };
}

function fixture(player = 'qqmusic') {
  const states = [];
  const observations = [];
  const manager = new PlayerManager({
    getSelectedKey: () => player,
    getFoliaToken: () => '',
    log() {},
    setStatus() {},
    onStateChanged(state) { states.push(state); },
    async onTrackChanged(track, observation) {
      observations.push({ kind: 'change', track, observation });
    },
    async onTrackUpdated(track, observation) {
      observations.push({ kind: 'update', track, observation });
    }
  });
  return {
    manager, states, observations,
    async accept(value) {
      manager.acceptSnapshot(player, value, true);
      await manager.observationTail;
    }
  };
}

test('busy old A arriving after observed B cannot roll back Current or Next or enqueue observation', async () => {
  const f = fixture();
  const fresh = snapshot('B', 'C');
  await f.accept(fresh);
  assert.equal(f.observations.length, 1);
  const busy = snapshot('A', 'B', {
    observationDeferred: true,
    observedAt: '2026-09-09T00:00:01Z',
    status: 'busy; historical observation'
  });
  await f.accept(busy);
  await f.accept(busy);
  assert.equal(f.manager.connectionState.snapshot, fresh);
  assert.equal(f.manager.connectionState.snapshot.current.title, 'B');
  assert.equal(f.manager.connectionState.snapshot.next.title, 'C');
  assert.equal(f.observations.length, 1);
  assert.equal(f.states.length, 1);
});

test('first deferred snapshot is display-only and a later real observation starts queue processing once', async () => {
  const f = fixture();
  const busy = snapshot('A', 'B', { observationDeferred: true });
  await f.accept(busy);
  assert.equal(f.manager.connectionState.snapshot, busy);
  assert.equal(f.manager.connectionState.connected, true);
  assert.equal(f.observations.length, 0);
  await f.accept(busy);
  assert.equal(f.observations.length, 0);
  const fresh = snapshot('B', 'C', { observationDeferred: false });
  await f.accept(fresh);
  assert.equal(f.manager.connectionState.snapshot, fresh);
  assert.equal(f.observations.length, 1);
  assert.equal(f.observations[0].kind, 'change');
  assert.equal(f.observations[0].track.title, 'B');
});

test('deferred QQ snapshot is ignored even with equal/newer timestamps or missing Current', async () => {
  for (const observedAt of ['2026-09-09T00:00:02Z', '2026-09-09T00:00:03Z']) {
    const f = fixture();
    const fresh = snapshot('B', 'C');
    await f.accept(fresh);
    for (let i = 0; i < 3; i++) {
      await f.accept(snapshot('A', null, { current: null, observationDeferred: true, observedAt }));
    }
    assert.equal(f.manager.connectionState.snapshot, fresh);
    assert.equal(f.observations.length, 1);
  }
});

test('other players and QQ without both explicit flags retain ordinary observation behavior', async () => {
  for (const [player, extra] of [
    ['netease', { observationDeferred: true }],
    ['kugou', { observationDeferred: true }],
    ['folia', { observationDeferred: true }],
    ['qqmusic', { observationDeferred: true, ownsLogicalNext: false }],
    ['qqmusic', { observationDeferred: true, ownsLogicalNext: undefined }],
    ['qqmusic', { observationDeferred: false }],
    ['qqmusic', { observationDeferred: undefined }],
    ['qqmusic', { observationDeferred: 'true' }]
  ]) {
    const f = fixture(player);
    const value = snapshot('A', 'B', extra);
    await f.accept(value);
    assert.equal(f.manager.connectionState.snapshot, value);
    assert.equal(f.observations.length, 1, `${player}: ${JSON.stringify(extra)}`);
  }
});
