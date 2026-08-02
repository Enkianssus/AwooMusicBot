import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(
  new URL('../electron/connector-recovery-policy.ts', import.meta.url),
  'utf8'
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const module = { exports: {} };
vm.runInNewContext(compiled, {
  module,
  exports: module.exports
});
const { shouldAutoUpgradeConnectorAfterFailure } = module.exports;

const updateAvailable = {
  installed: true,
  compatible: true,
  updateAvailable: true,
  updating: false
};

test('does not upgrade when the connector returned a disconnected snapshot', () => {
  assert.equal(
    shouldAutoUpgradeConnectorAfterFailure({
      ...updateAvailable,
      connectorProbeResponded: true
    }),
    false
  );
});

test('upgrades when the connector itself failed before responding', () => {
  assert.equal(
    shouldAutoUpgradeConnectorAfterFailure({
      ...updateAvailable,
      connectorProbeResponded: false
    }),
    true
  );
});

test('does not upgrade without a compatible available update', () => {
  assert.equal(
    shouldAutoUpgradeConnectorAfterFailure({
      ...updateAvailable,
      connectorProbeResponded: false,
      updateAvailable: false
    }),
    false
  );
  assert.equal(
    shouldAutoUpgradeConnectorAfterFailure({
      ...updateAvailable,
      connectorProbeResponded: false,
      compatible: false
    }),
    false
  );
});
