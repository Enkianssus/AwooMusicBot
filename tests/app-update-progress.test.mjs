import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('desktop update UI reports Velopack progress instead of simulating it', () => {
  const mainSource = fs.readFileSync(
    path.join(root, 'electron', 'main.ts'),
    'utf8'
  );
  const rendererSource = fs.readFileSync(
    path.join(root, 'src', 'App.tsx'),
    'utf8'
  );
  const handlerStart = rendererSource.indexOf('const handleApplyUpdate');
  const handlerEnd = rendererSource.indexOf('const startQrLogin', handlerStart);
  const updateHandler = rendererSource.slice(handlerStart, handlerEnd);

  assert.match(mainSource, /downloadUpdateAsync\([\s\S]*rawProgress/);
  assert.match(mainSource, /url\.pathname === '\/api\/update\/status'/);
  assert.match(updateHandler, /\/api\/update\/status/);
  assert.doesNotMatch(updateHandler, /Math\.random|setInterval/);
  assert.doesNotMatch(updateHandler, /模拟进度|卡在 95/);
});
