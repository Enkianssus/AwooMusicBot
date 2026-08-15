import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('separates streamer artwork from per-Mod UI artwork settings', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8');
  const appearanceStart = source.indexOf("activeTab === 'appearance'");
  const settingsStart = source.indexOf("activeTab === 'settings'", appearanceStart);
  const appearancePanel = source.slice(appearanceStart, settingsStart);
  const settingsPanel = source.slice(settingsStart);

  assert.ok(appearanceStart >= 0 && settingsStart > appearanceStart);
  assert.match(appearancePanel, /aria-label="主播控制 UI 点歌歌曲图片"/);
  assert.match(appearancePanel, /OBS Mod UI 请在上方单独设置/);
  assert.doesNotMatch(settingsPanel, /aria-label="主播控制 UI 点歌歌曲图片"/);
});
