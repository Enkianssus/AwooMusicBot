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

test('release guide locks connector versions and old-core assets', async () => {
  const guide = await readProjectFile('docs/RELEASING.md');

  assert.match(guide, /netease-v3\.1\.37\.205354\.9/);
  assert.match(guide, /kugou-v20\.0\.81\.5/);
  assert.match(guide, /qqmusic-v22\.52\.1/);
  assert.match(guide, /folia-v1\.1\.3/);
  assert.match(guide, /12 个资产/);
  assert.match(guide, /6 个资产/);
  assert.match(guide, /bilincm-connector-\{id\}/);
  assert.match(guide, /publicKeyId = bilincm-connectors-2026-01/);
});

test('release guide keeps public update and verification contracts', async () => {
  const guide = await readProjectFile('docs/RELEASING.md');

  assert.match(
    guide,
    /https:\/\/app\.enkianss\.us\/connectors\/v1\/catalog\.json/
  );
  assert.match(guide, /Range: bytes=0-0/);
  assert.match(guide, /github-actions\[bot\]/);
  assert.match(guide, /awoo-musicbot-win-Portable\.zip/);
  assert.match(guide, /不得删除 legacy ZIP/);
});
