import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectorLifecycleGate } from '../electron/connector-lifecycle-gate.ts';

test('deduplicates connector stops and blocks starts until cleanup finishes', async () => {
  const gate = new ConnectorLifecycleGate();
  let stopCalls = 0;
  let releaseStop;
  const stopBlocked = new Promise(resolve => {
    releaseStop = resolve;
  });

  const firstStop = gate.runStop(async () => {
    stopCalls++;
    await stopBlocked;
  });
  const secondStop = gate.runStop(async () => {
    stopCalls++;
  });
  assert.equal(firstStop, secondStop);
  assert.equal(gate.stopping, true);

  let startContinued = false;
  const start = (async () => {
    await gate.waitForStop();
    startContinued = true;
  })();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopCalls, 1);
  assert.equal(startContinued, false);

  releaseStop();
  await Promise.all([firstStop, secondStop, start]);
  assert.equal(startContinued, true);
  assert.equal(gate.stopping, false);
});
