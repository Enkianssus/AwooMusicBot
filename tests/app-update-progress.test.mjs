import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const rendererSource = fs.readFileSync(
  path.join(root, 'src', 'App.tsx'),
  'utf8'
);
const handlerStart = rendererSource.indexOf('const handleApplyUpdate');
const handlerEnd = rendererSource.indexOf('const startQrLogin', handlerStart);
const updateHandler = rendererSource.slice(handlerStart, handlerEnd);

test('desktop update UI reports Velopack progress instead of simulating it', () => {
  const mainSource = fs.readFileSync(
    path.join(root, 'electron', 'main.ts'),
    'utf8'
  );
  const updaterSource = fs.readFileSync(
    path.join(root, 'electron', 'app-updater.ts'),
    'utf8'
  );

  assert.match(updaterSource, /downloadUpdateAsync\([\s\S]*rawProgress/);
  assert.match(mainSource, /url\.pathname === '\/api\/update\/status'/);
  assert.match(updateHandler, /\/api\/update\/status/);
  assert.doesNotMatch(updateHandler, /Math\.random|setInterval/);
  assert.doesNotMatch(updateHandler, /模拟进度|卡在 95/);
});

test('a reopened admin window resumes the running core update', () => {
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const outsideHandler = rendererSource.slice(0, handlerStart) + rendererSource.slice(handlerEnd);
  // The mount-time resume reads the same status endpoint outside handleApplyUpdate.
  assert.match(outsideHandler, /\/api\/update\/status/);
  assert.match(outsideHandler, /isCoreUpdateActive\(status\.state\)[\s\S]{0,120}resumeCoreUpdate\(status\)/);

  const pollStart = rendererSource.indexOf('const pollCoreUpdateStatus');
  assert.ok(pollStart >= 0 && (pollStart < handlerStart || pollStart >= handlerEnd));
  const pollEnd = rendererSource.indexOf('const resumeCoreUpdate', pollStart);
  const poll = rendererSource.slice(pollStart, pollEnd);
  assert.ok(pollEnd > pollStart);
  assert.match(poll, /\/api\/update\/status/);
  assert.match(poll, /setTimeout\(/);
  assert.doesNotMatch(poll, /setInterval|Math\.random/);
  assert.match(updateHandler, /pollCoreUpdateStatus\(\)/);
});

test('the core update asks inside the app and keeps the dialog closable during a download', () => {
  assert.doesNotMatch(updateHandler, /\bconfirm\(/);
  assert.match(updateHandler, /await confirmCoreUpdate\(/);
  assert.match(updateHandler, /readPendingRequestCount\(\)/);
  assert.match(updateHandler, /throw new Error\('请等待连接器更新完成后再更新点歌机。'\)/);
  assert.match(updateHandler, /throw new Error\('更新任务已在进行，请等待唯一一次最终重启。'\)/);
  assert.match(rendererSource, /busy=\{connectorUpdating !== null \|\| updateDownloadStatus\?\.state === 'applying'\}/);
  assert.doesNotMatch(rendererSource, /正在检查 GitHub/);
});
