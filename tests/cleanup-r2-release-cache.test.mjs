import assert from 'node:assert/strict';
import {
  cleanupR2ReleaseCache,
  selectKeysToDelete
} from '../scripts/cleanup-r2-release-cache.mjs';

const accountId = 'a'.repeat(32);
const prefix =
  'github-release-v1/github.com/Enkianssus/AwooMusicBot/releases/download/';
const currentKey = `${prefix}v1.1.6/awoo-musicbot-win-Portable.zip`;
const oldKey = `${prefix}v1.1.5/awoo-musicbot-win-Portable.zip`;
const newerKey = `${prefix}v1.1.7/awoo-musicbot-win-Portable.zip`;
const scope = {
  accountId,
  bucket: 'awoo-download-cache',
  repository: 'Enkianssus/AwooMusicBot',
  currentTag: 'v1.1.6',
  tagPrefix: 'v',
  versionParts: 3,
  expectedKeys: [currentKey]
};

assert.deepEqual(
  selectKeysToDelete(scope, [
    currentKey,
    oldKey,
    newerKey,
    `${prefix}v1.1.preview/unknown.bin`,
    'github-release-v1/github.com/Enkianssus/awoo-connectors/releases/download/kugou-v20.1.1/other.zip'
  ]),
  [oldKey],
  'newer app releases and unknown/other-product keys must remain untouched'
);

const makeResponse = body => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json' }
});
let deleteCalls = 0;
let listUrl;
const fetchMock = async (input, init = {}) => {
  if (init.method === 'DELETE') {
    deleteCalls += 1;
    return makeResponse({ success: true, result: {} });
  }
  listUrl = new URL(String(input));
  return makeResponse({
    success: true,
    result: [{ key: currentKey }, { key: oldKey }],
    result_info: { is_truncated: false }
  });
};
const result = await cleanupR2ReleaseCache(scope, 'test-token', fetchMock);
assert.deepEqual(result.deleted, [oldKey]);
assert.equal(deleteCalls, 1);
assert.equal(listUrl.searchParams.get('per_page'), '1000');
assert.equal(listUrl.searchParams.get('limit'), null);

deleteCalls = 0;
const dryRunResult = await cleanupR2ReleaseCache(
  { ...scope, dryRun: true },
  'test-token',
  fetchMock
);
assert.deepEqual(dryRunResult.deleted, []);
assert.deepEqual(dryRunResult.candidates, [oldKey]);
assert.equal(deleteCalls, 0, 'dry-run must never issue DELETE requests');

console.log('cleanup-r2-release-cache.test.mjs passed.');
