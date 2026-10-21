import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { extractFunctions, readSource, sliceBetween } from './helpers/source.mjs';
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
  const updaterSource = fs.readFileSync(
    path.join(root, 'electron', 'app-updater.ts'),
    'utf8'
  );
  const rendererSource = fs.readFileSync(
    path.join(root, 'src', 'App.tsx'),
    'utf8'
  );
  const applyCalls = source => (source.match(/waitExitThenApplyUpdate\(/g) || []).length;

  assert.equal(applyCalls(mainSource) + applyCalls(updaterSource), 1);
  assert.equal((mainSource.match(/app\.quit\(/g) || []).length, 1);
  assert.match(mainSource, /requestSingleInstanceLock\(\)/);
  assert.match(
    updaterSource,
    /markAppUpdateExitRequested\(\);[\s\S]{0,120}requestQuit\(\)/
  );
  assert.match(mainSource, /requestQuit: requestApplicationQuit,/);
  assert.doesNotMatch(mainSource, /app\.relaunch\(/);
  assert.match(rendererSource, /updateApplyRequestInFlightRef/);
  assert.match(rendererSource, /result\.alreadyRunning/);
});

test('every core update path goes through the one feed factory and AppUpdater', () => {
  const main = readSource('electron/main.ts');
  assert.doesNotMatch(main, /new UpdateManager\(/);
  assert.doesNotMatch(main, /app\.enkianss\.us\/update\/awoo/);
  assert.doesNotMatch(main, /startAppUpdateOperation|appUpdateDownloadStatus|appUpdatePhase/);
  assert.equal((main.match(/new AppUpdater\(/g) || []).length, 1);
  assert.match(main, /createManager: \(\) => createAppUpdateManager\(UpdateManager\),/);
  assert.match(
    main,
    /onFinished: outcome => getUpdateAnnouncementService\(\)\.invalidate\(outcome === 'no-update' \? 'core' : undefined\)/
  );
  const announcement = sliceBetween(main, 'async function checkCoreUpdateAnnouncement', '\n}\n');
  assert.match(
    announcement,
    /withTimeout\(\s*createAppUpdateManager\(UpdateManager\)\.checkForUpdatesAsync\(\), 15_000, '更新检查超时'\s*\)/
  );
  assert.match(announcement, /notes: info\.TargetFullRelease\?\.NotesMarkdown/);
  assert.match(announcement, /typeof size === 'number' && Number\.isFinite\(size\) && size > 0 \? \{ sizeBytes: size \}/);

  const check = sliceBetween(main, "url.pathname === '/api/update/check'", "url.pathname === '/api/update/status'");
  assert.match(check, /if \(req\.method !== 'GET'\) \{\s*res\.writeHead\(405/);
  assert.ok(check.indexOf("req.method !== 'GET'") < check.indexOf('getAppUpdater().check()'));
  assert.match(check, /catch \{\s*res\.end\(JSON\.stringify\(\{ error: '无法连接更新服务器' \}\)\);/);
  const status = sliceBetween(main, "url.pathname === '/api/update/status'", "url.pathname === '/api/update/apply'");
  assert.match(status, /success: true,\s*status: updater\.getStatus\(\),\s*phase: updater\.phase/);
  const apply = sliceBetween(main, "url.pathname === '/api/update/apply'", 'if (url.pathname ===');
  assert.ok(apply.indexOf('allowMultipleInstances') < apply.indexOf('updater.start()'));
  assert.ok(apply.indexOf("updateInstallationGuard.componentId !== 'core'") < apply.indexOf('updater.start()'));
  assert.equal((apply.match(/res\.writeHead\(409/g) || []).length, 2);
  assert.match(apply, /alreadyRunning: !started,\s*status: updater\.getStatus\(\),\s*phase: updater\.phase/);
});

test('Velopack logs from startup on reach the log, without delaying its bootstrap', () => {
  const main = readSource('electron/main.ts');
  const bootstrap = main.indexOf(
    'VelopackApp.build().setLogger(recordVelopackLog).setAutoApplyOnStartup(false).run();'
  );
  assert.ok(bootstrap > 0);
  for (const later of ['const allowMultipleInstances =', 'requestSingleInstanceLock()', 'const sysLogs', 'const CONFIG_PATH =']) {
    assert.ok(bootstrap < main.indexOf(later), later);
  }
  // writeLog needs sysLogs; its temporal dead zone ends only after run().
  const flush = main.indexOf('velopackLogTarget = writeVelopackLog;');
  assert.ok(flush > main.indexOf('const sysLogs'));

  const logs = [];
  const context = vm.createContext({
    VELOPACK_LOG_BUFFER_LIMIT: 200,
    velopackLogBuffer: [],
    velopackLogTarget: null,
    writeLog: (message, color) => logs.push([message, color])
  });
  vm.runInContext(ts.transpileModule(
    extractFunctions('electron/main.ts', ['recordVelopackLog', 'writeVelopackLog']),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
  ).outputText, context);
  for (let index = 0; index < 250; index++) context.recordVelopackLog('info', `line ${index}`);
  context.recordVelopackLog('trace', 'noise');
  assert.equal(context.velopackLogBuffer.length, 200);
  assert.equal(context.velopackLogBuffer[0].message, 'line 50', 'the newest lines are kept');
  assert.deepEqual(logs, [], 'nothing is written before the log exists');

  context.velopackLogTarget = context.writeVelopackLog;
  context.recordVelopackLog('error', 'Failed to apply update');
  context.recordVelopackLog('warn', 'Retrying operation');
  context.recordVelopackLog('debug', 'Checking package');
  context.recordVelopackLog('trace', 'noise');
  assert.deepEqual(logs, [
    ['[Velopack] Failed to apply update', 'Red'],
    ['[Velopack] Retrying operation', 'Yellow'],
    ['[Velopack] Checking package', 'DarkGray']
  ]);
});
