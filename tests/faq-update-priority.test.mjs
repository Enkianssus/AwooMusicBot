import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('FAQ prioritizes updates before deeper player troubleshooting', () => {
  const source = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8');
  const faqStart = source.indexOf("activeTab === 'faq'");
  const faqEnd = source.indexOf("activeTab === 'debug'", faqStart);
  const faqPanel = source.slice(faqStart, faqEnd);

  const playerUpdate = faqPanel.indexOf('1. 更新播放器');
  const connectorUpdate = faqPanel.indexOf('2. 更新对应连接器');
  const appUpdate = faqPanel.indexOf('3. 更新嗷呜点歌机');

  assert.ok(faqStart >= 0 && faqEnd > faqStart);
  assert.ok(playerUpdate >= 0);
  assert.ok(connectorUpdate > playerUpdate);
  assert.ok(appUpdate > connectorUpdate);
  assert.match(faqPanel, /三项都更新[\s\S]*才继续检查运行日志、程序权限和杀毒软件拦截/);
  assert.match(faqPanel, /setActiveTab\('settings'\)[\s\S]*setActiveTab\('update'\)/);
});
