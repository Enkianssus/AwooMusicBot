import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const mainSource = fs.readFileSync(
  path.join(root, 'electron', 'main.ts'),
  'utf8'
);

test('startup gives the first transparent render priority over background work', () => {
  const startupStart = mainSource.indexOf('app.whenReady().then');
  const startupEnd = mainSource.indexOf("app.on('before-quit'", startupStart);
  const startup = mainSource.slice(startupStart, startupEnd);
  const schedulerStart = mainSource.indexOf(
    'function scheduleStartupBackgroundServices'
  );
  const schedulerEnd = mainSource.indexOf(
    'async function reconnectPlayerBridge',
    schedulerStart
  );
  const scheduler = mainSource.slice(schedulerStart, schedulerEnd);

  assert.ok(startupStart >= 0 && startupEnd > startupStart);
  assert.ok(schedulerStart >= 0 && schedulerEnd > schedulerStart);
  assert.ok(
    startup.indexOf('createOverlayWindow()')
      < startup.indexOf('scheduleStartupBackgroundServices(overlayWindow)')
  );
  assert.doesNotMatch(startup, /loadConfig\(\);\s*void startPlayerBridge\(\)/);
  assert.match(scheduler, /once\('ready-to-show', schedule\)/);
  assert.match(scheduler, /did-fail-load/);
  assert.match(scheduler, /STARTUP_BACKGROUND_FALLBACK_MS/);
});

test('startup does not synchronously launch a console code-page process', () => {
  assert.doesNotMatch(mainSource, /execSync\(['"]chcp 65001/);
});

test('transparent overlay is shown only when its first render is ready', () => {
  const createStart = mainSource.indexOf('function createOverlayWindow');
  const createEnd = mainSource.indexOf(
    'function createAdminWindow',
    createStart
  );
  const createWindow = mainSource.slice(createStart, createEnd);

  assert.match(createWindow, /show: false/);
  assert.match(createWindow, /once\('ready-to-show'/);
  assert.match(createWindow, /initialWindow\.show\(\)/);
});
