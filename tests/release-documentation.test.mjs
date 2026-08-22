import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readProjectFile = relativePath => readFile(
  new URL(`../${relativePath}`, import.meta.url),
  'utf8'
);

test('release instructions preserve repository and account boundaries', async () => {
  const [agents, guide, connectorAgents] = await Promise.all([
    readProjectFile('AGENTS.md'),
    readProjectFile('docs/RELEASING.md'),
    readProjectFile('BiliNCM-Connectors/AGENTS.md')
  ]);
  const combined = `${agents}\n${guide}\n${connectorAgents}`;

  assert.match(combined, /Enkianssus\/AwooMusicBot/);
  assert.match(combined, /Enkianssus\/awoo-connectors/);
  assert.match(combined, /ENKIANSSUS_CLOUDFLARE_API_TOKEN/);
  assert.match(combined, /explicit user authorization|明确确认/i);

  const forbiddenAccountMarker = ['ankii', 'mmd'].join('');
  assert.doesNotMatch(combined, new RegExp(forbiddenAccountMarker, 'i'));
});

test('release guide preserves historical v1 assets and QQ profile assets', async () => {
  const guide = await readProjectFile('docs/RELEASING.md');

  assert.match(guide, /netease-v3\.1\.37\.205354\.9/);
  assert.match(guide, /kugou-v20\.0\.81\.5/);
  assert.match(guide, /qqmusic-v22\.52\.1/);
  assert.match(guide, /folia-v1\.1\.3/);
  assert.match(guide, /12 个资产/);
  assert.match(guide, /六个资产/);
  assert.match(guide, /bilincm-connector-\{id\}/);
  assert.match(guide, /publicKeyId = bilincm-connectors-2026-01/);
});

test('future connector releases use only the v2 small-package contract', async () => {
  const guide = await readProjectFile('docs/RELEASING.md');

  assert.match(guide, /未来 Release 必须严格只生成 3 个资产/);
  assert.match(guide, /只构建一个 Awoo framework-dependent ZIP/);
  assert.match(guide, /只执行 Awoo 小包 smoke test/);
  assert.match(guide, /恰好 3 个资产/);
  assert.match(guide, /catalog-v2\.json/);
  assert.match(guide, /现有签名 Awoo framework-dependent 资产初始化/);
  assert.match(guide, /不需要为了迁移虚构新的连接器修订号或 Tag/);
  assert.match(
    guide,
    /v2 代理和 Catalog 验收通过后[\s\S]*v1\.1\.10/
  );
  assert.doesNotMatch(guide, /创建连接器 Tag，让 workflow 生成唯一的 Awoo 小包 Release/);
  assert.doesNotMatch(guide, /每次连接器 Release 必须生成四个 ZIP/);
  assert.doesNotMatch(guide, /构建 Awoo\/legacy/);
  assert.doesNotMatch(guide, /执行 Awoo 与 legacy smoke test/);
  assert.doesNotMatch(guide, /scripts\/update-catalog\.mjs/);
  assert.doesNotMatch(guide, /连接器有 12 个资产/);
  assert.doesNotMatch(guide, /legacy\/完整包并安装成功/);
});

test('release guide keeps public update and verification contracts', async () => {
  const guide = await readProjectFile('docs/RELEASING.md');

  assert.match(
    guide,
    /https:\/\/app\.enkianss\.us\/connectors\/v1\/catalog\.json/
  );
  assert.match(
    guide,
    /https:\/\/app\.enkianss\.us\/connectors\/v2\/catalog\.json/
  );
  assert.match(guide, /schemaVersion: 2/);
  assert.match(guide, /package\.deployment.*framework-dependent/);
  assert.match(guide, /不再包含[\s\S]*awooFrameworkDependent/);
  assert.match(guide, /不得.*静默回退 v1/);
  assert.match(guide, /Range: bytes=0-0/);
  assert.match(guide, /github-actions\[bot\]/);
  assert.match(guide, /awoo-musicbot-win-Portable\.zip/);
  assert.match(guide, /不得删除历史 v1 Release[\s\S]*legacy ZIP/);
  assert.match(guide, /1\.1\.10 起的新客户端只安装该小包/);
  assert.match(guide, /不得下载 SelfContained 完整包/);
});
