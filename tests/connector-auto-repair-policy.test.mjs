import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(
  new URL('../electron/connector-auto-repair-policy.ts', import.meta.url),
  'utf8'
);
const versionPolicySource = fs.readFileSync(
  new URL('../electron/connector-version-policy.ts', import.meta.url),
  'utf8'
);

function compileModule(moduleSource, requireImpl = () => {
  throw new Error('unexpected require');
}) {
  const compiled = ts.transpileModule(moduleSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, {
    module,
    exports: module.exports,
    require: requireImpl
  });
  return module.exports;
}

const versionPolicy = compileModule(versionPolicySource);
const policy = compileModule(
  source,
  request => {
    if (request === './connector-version-policy') return versionPolicy;
    throw new Error(`unexpected require: ${request}`);
  }
);
const {
  CONNECTOR_AUTO_REPAIR_MESSAGES,
  planConnectorAutoRepair,
  playerVersionMatchesCatalog
} = policy;

const base = {
  connectorId: 'qqmusic',
  playerRunning: true,
  playerVersion: '22.60.0.0',
  connectorInstalled: true,
  connectorCurrentVersion: '22.52.2',
  connectorLatestVersion: '22.60.1',
  connectorSupportedPlayerVersion: '22.22 / 22.41 / 22.51 / 22.52 / 22.60',
  connectorPlayerVersionPolicy: '22.*',
  connectorTestedPlayerVersion: '22.60',
  connectorCompatible: true,
  connectorUpdateAvailable: true,
  connectorAutoUpdateAvailable: false,
  connectorManualUpdateAvailable: true,
  connectorUpdateKind: 'player',
  connectorUpdating: false,
  catalogError: null,
  attempted: false
};

test('requires a real running player before considering a repair', () => {
  const planned = planConnectorAutoRepair({
    ...base,
    playerRunning: false
  });
  assert.equal(planned.action, 'player-not-running');
  assert.equal(planned.allowPlayerVersionChange, false);
  assert.equal(planned.message, CONNECTOR_AUTO_REPAIR_MESSAGES.playerNotRunning);
});

test('matches wildcard catalog branches and allows a player-branch repair', () => {
  assert.equal(
    playerVersionMatchesCatalog(
      'qqmusic',
      '22.60.0.0',
      '22.*',
      '22.60',
      ''
    ),
    true
  );
  const planned = planConnectorAutoRepair(base);
  assert.equal(planned.action, 'upgrade');
  assert.equal(planned.allowPlayerVersionChange, true);
  assert.equal(planned.message, CONNECTOR_AUTO_REPAIR_MESSAGES.upgrading);
});

test('same-player-branch patches stay with the ordinary update policy', () => {
  const planned = planConnectorAutoRepair({
    ...base,
    connectorCurrentVersion: '3.1.38.205386.1',
    connectorLatestVersion: '3.1.38.205386.2',
    connectorPlayerVersionPolicy: '3.1.*',
    connectorTestedPlayerVersion: '3.1.38.205386',
    connectorSupportedPlayerVersion: '3.1.38.205386',
    playerVersion: '3.1.38.205386',
    connectorUpdateKind: 'patch',
    connectorAutoUpdateAvailable: true,
    connectorManualUpdateAvailable: false,
    connectorId: 'netease'
  });
  assert.equal(planned.action, 'failed');
  assert.equal(planned.allowPlayerVersionChange, false);
});

test('does not auto-upgrade a branch that does not match the player', () => {
  const planned = planConnectorAutoRepair({
    ...base,
    playerVersion: '21.99.0.0',
    connectorPlayerVersionPolicy: '22.*'
  });
  assert.equal(planned.action, 'missing-connector');
  assert.equal(planned.message, CONNECTOR_AUTO_REPAIR_MESSAGES.missingConnector);
  assert.equal(planned.allowPlayerVersionChange, false);
});

test('does not inherit a broad policy for an untested future player build', () => {
  const planned = planConnectorAutoRepair({
    ...base,
    playerVersion: '22.99.0.0',
    connectorSupportedPlayerVersion: '22.22 / 22.41 / 22.51 / 22.52 / 22.60',
    connectorTestedPlayerVersion: '22.60',
    connectorPlayerVersionPolicy: '22.*'
  });
  assert.equal(planned.action, 'missing-connector');
  assert.equal(planned.message, CONNECTOR_AUTO_REPAIR_MESSAGES.missingConnector);
});

test('only a player branch newer than the installed connector can repair', () => {
  for (const playerVersion of ['22.52.0.0', '22.40.0.0']) {
    const planned = planConnectorAutoRepair({
      ...base,
      playerVersion,
      connectorSupportedPlayerVersion: '22.40 / 22.52 / 22.60',
      connectorTestedPlayerVersion: '22.40 / 22.52 / 22.60'
    });
    assert.equal(planned.action, 'failed');
    assert.equal(planned.allowPlayerVersionChange, false);
  }
});

test('a failed repair is one-shot for the same player session', () => {
  const planned = planConnectorAutoRepair({
    ...base,
    attempted: true
  });
  assert.equal(planned.action, 'failed');
  assert.equal(planned.message, CONNECTOR_AUTO_REPAIR_MESSAGES.failed);
  assert.equal(planned.allowPlayerVersionChange, false);
});

test('catalog or connector failures never turn into an unverified upgrade', () => {
  for (const patch of [
    { catalogError: '清单 HTTP 503' },
    { connectorCompatible: false },
    { connectorUpdating: true },
    { connectorUpdateAvailable: false },
    { playerVersion: '' }
  ]) {
    const planned = planConnectorAutoRepair({ ...base, ...patch });
    assert.notEqual(planned.action, 'upgrade');
    assert.equal(planned.allowPlayerVersionChange, false);
  }
});

test('Folia does not use local-player auto repair', () => {
  const planned = planConnectorAutoRepair({
    ...base,
    connectorId: 'folia'
  });
  assert.equal(planned.action, 'not-applicable');
  assert.equal(planned.message, CONNECTOR_AUTO_REPAIR_MESSAGES.failed);
});
