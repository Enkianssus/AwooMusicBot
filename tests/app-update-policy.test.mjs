import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  markAppUpdateApplying,
  markAppUpdateExitRequested,
  markAppUpdateRetryable,
  markAppUpdateStarted,
  planAppUpdateRequest,
  shouldAllowMultipleInstances,
  shouldRequestAppQuit
} from '../electron/app-update-policy.ts';

const root = path.resolve(import.meta.dirname, '..');

test('an application update remains a single task through final exit', () => {
  assert.equal(planAppUpdateRequest('idle'), 'start');
  assert.equal(markAppUpdateStarted(), 'running');
  assert.equal(planAppUpdateRequest('running'), 'already-running');
  assert.equal(markAppUpdateApplying(), 'applying');
  assert.equal(planAppUpdateRequest('applying'), 'already-running');
  assert.equal(markAppUpdateExitRequested(), 'exit-requested');
  assert.equal(planAppUpdateRequest('exit-requested'), 'already-running');
  assert.equal(markAppUpdateRetryable(), 'idle');
});

test('application quit is requested only once per process', () => {
  assert.equal(shouldRequestAppQuit(false), true);
  assert.equal(shouldRequestAppQuit(true), false);
});

test('production is single-instance while local development has an opt-in escape hatch', () => {
  const installed = 'C:\\Users\\user\\AppData\\Local\\AwooMusicBot\\current\\嗷呜点歌机.exe';
  const dev = 'E:\\repo\\dist_electron_dev_1.1.12\\win-unpacked\\嗷呜点歌机.exe';
  assert.equal(shouldAllowMultipleInstances([], {}, installed, true), false);
  assert.equal(shouldAllowMultipleInstances([], {}, dev, true), true);
  assert.equal(shouldAllowMultipleInstances([], {}, installed, false), true);
  assert.equal(shouldAllowMultipleInstances(
    ['--allow-multiple-instances'],
    {},
    installed,
    true
  ), true);
  assert.equal(shouldAllowMultipleInstances(
    [],
    { AWOO_ALLOW_MULTIPLE_INSTANCES: '1' },
    installed,
    true
  ), true);
});

test('host has one Velopack restart owner and one idempotent quit path', () => {
  const mainSource = fs.readFileSync(
    path.join(root, 'electron', 'main.ts'),
    'utf8'
  );
  const rendererSource = fs.readFileSync(
    path.join(root, 'src', 'App.tsx'),
    'utf8'
  );

  assert.equal(
    (mainSource.match(/waitExitThenApplyUpdate\(/g) || []).length,
    1
  );
  assert.equal((mainSource.match(/app\.quit\(/g) || []).length, 1);
  assert.match(mainSource, /requestSingleInstanceLock\(\)/);
  assert.match(
    mainSource,
    /markAppUpdateExitRequested\(\);[\s\S]{0,120}requestApplicationQuit\(\)/
  );
  assert.doesNotMatch(mainSource, /app\.relaunch\(/);
  assert.match(rendererSource, /updateApplyRequestInFlightRef/);
  assert.match(rendererSource, /result\.alreadyRunning/);
});
