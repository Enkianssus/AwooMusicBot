import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  fetchBaseRelease,
  pruneOutput,
  selectBaseRelease,
  selectFilesToPrune
} from '../scripts/release-delta-base.mjs';

const options = {
  repository: 'Enkianssus/AwooMusicBot',
  currentTag: 'v1.2.6',
  tagPrefix: 'v',
  minVersion: '1.1.0',
  packId: 'awoo-musicbot',
  channel: 'win',
  outputDir: 'Releases'
};

const download = name => `https://github.com/Enkianssus/AwooMusicBot/releases/download/${name}`;

function release(tag, overrides = {}) {
  const version = tag.slice(1);
  return {
    tag_name: tag,
    draft: false,
    prerelease: false,
    assets: [
      { name: 'releases.win.json', size: 20, browser_download_url: download(`${tag}/releases.win.json`) },
      { name: `awoo-musicbot-${version}-full.nupkg`, size: 40, browser_download_url: download(`${tag}/awoo-musicbot-${version}-full.nupkg`) },
      { name: 'awoo-musicbot-win-Setup.exe', size: 50, browser_download_url: download(`${tag}/awoo-musicbot-win-Setup.exe`) }
    ],
    ...overrides
  };
}

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awoo-delta-base-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('the delta base is the newest published release of the same channel below the current version', () => {
  const releases = [
    release('v1.0.15'),
    release('v1.2.7'),
    release('v1.2.6'),
    release('v1.2.5', { draft: true }),
    release('v1.2.4', { prerelease: true }),
    release('v1.2.3'),
    release('v1.2.2'),
    release('v1.1.13')
  ];
  const base = selectBaseRelease(releases, options);
  assert.equal(base.tag, 'v1.2.3');
  assert.deepEqual(base.assets.map(asset => asset.name), ['releases.win.json', 'awoo-musicbot-1.2.3-full.nupkg']);
});

test('a release without its full package or feed cannot be a delta base', () => {
  const withoutFull = release('v1.2.5');
  withoutFull.assets = withoutFull.assets.filter(asset => !asset.name.endsWith('-full.nupkg'));
  const withoutFeed = release('v1.2.4');
  withoutFeed.assets = withoutFeed.assets.filter(asset => asset.name !== 'releases.win.json');
  assert.equal(selectBaseRelease([withoutFull, withoutFeed], options), null);
  assert.equal(selectBaseRelease([release('v1.0.14'), release('v1.0.13')], options), null,
    'the legacy 1.0.x channel uses another package id');
  assert.throws(() => selectBaseRelease([], { ...options, currentTag: '1.2.6' }), /Invalid current release tag/);
});

test('only packages of other versions are pruned from the upload set', () => {
  assert.deepEqual(selectFilesToPrune([
    'awoo-musicbot-1.2.5-full.nupkg',
    'awoo-musicbot-1.2.4-delta.nupkg',
    'Awoo-MusicBot-1.2.3-FULL.nupkg',
    'awoo-musicbot-1.2.6-full.nupkg',
    'awoo-musicbot-1.2.6-delta.nupkg',
    'awoo-musicbot-win-Setup.exe',
    'awoo-musicbot-win-Portable.zip',
    'RELEASES',
    'releases.win.json',
    'assets.win.json',
    'bilincm-1.0.3-full.nupkg'
  ], { packId: 'awoo-musicbot', version: '1.2.6' }), [
    'Awoo-MusicBot-1.2.3-FULL.nupkg',
    'awoo-musicbot-1.2.4-delta.nupkg',
    'awoo-musicbot-1.2.5-full.nupkg'
  ]);
});

test('the base download writes the feed and full package, and leaves nothing behind on a short download', async t => {
  const directory = temporaryDirectory(t);
  const bodies = new Map([
    [download('v1.2.5/releases.win.json'), 'x'.repeat(20)],
    [download('v1.2.5/awoo-musicbot-1.2.5-full.nupkg'), 'y'.repeat(40)]
  ]);
  const requested = [];
  const fetchImpl = async (url, init) => {
    requested.push(url);
    if (url.includes('api.github.com')) {
      assert.equal(init.headers.Authorization, 'Bearer token');
      return Response.json([release('v1.2.5'), release('v1.0.14')]);
    }
    return new Response(bodies.get(url));
  };
  const result = await fetchBaseRelease({ ...options, outputDir: directory }, { fetchImpl, token: 'token' });
  assert.equal(result.base.tag, 'v1.2.5');
  assert.deepEqual(fs.readdirSync(directory).sort(), ['awoo-musicbot-1.2.5-full.nupkg', 'releases.win.json']);
  assert.equal(fs.statSync(path.join(directory, 'awoo-musicbot-1.2.5-full.nupkg')).size, 40);
  assert.equal(requested.filter(url => url.includes('Setup.exe')).length, 0, 'installers are never downloaded');

  const shortDirectory = temporaryDirectory(t);
  bodies.set(download('v1.2.5/awoo-musicbot-1.2.5-full.nupkg'), 'y'.repeat(12));
  await assert.rejects(
    fetchBaseRelease({ ...options, outputDir: shortDirectory }, { fetchImpl, token: 'token' }),
    /incomplete \(12 of 40 bytes\)/
  );
  assert.deepEqual(fs.readdirSync(shortDirectory), [], 'a partial base must not reach vpk');
});

test('a failed release listing downloads nothing', async t => {
  const directory = temporaryDirectory(t);
  await assert.rejects(
    fetchBaseRelease({ ...options, outputDir: directory }, { fetchImpl: async () => new Response('', { status: 503 }) }),
    /HTTP 503/
  );
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('pruning keeps the current release and reports the delta size', t => {
  const directory = temporaryDirectory(t);
  for (const [name, size] of [
    ['awoo-musicbot-1.2.5-full.nupkg', 30],
    ['awoo-musicbot-1.2.6-full.nupkg', 40],
    ['awoo-musicbot-1.2.6-delta.nupkg', 5],
    ['RELEASES', 1],
    ['releases.win.json', 1]
  ]) fs.writeFileSync(path.join(directory, name), 'z'.repeat(size));
  const result = pruneOutput({ outputDir: directory, packId: 'awoo-musicbot', version: '1.2.6' });
  assert.deepEqual(result, { removed: ['awoo-musicbot-1.2.5-full.nupkg'], fullSize: 40, deltaSize: 5 });
  assert.deepEqual(fs.readdirSync(directory).sort(), [
    'RELEASES', 'awoo-musicbot-1.2.6-delta.nupkg', 'awoo-musicbot-1.2.6-full.nupkg', 'releases.win.json'
  ]);
  fs.rmSync(path.join(directory, 'awoo-musicbot-1.2.6-full.nupkg'));
  assert.throws(() => pruneOutput({ outputDir: directory, packId: 'awoo-musicbot', version: '1.2.6' }), /is missing/);
});

test('the release workflow prepares the delta base before packing and uploads only the current version', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const position = text => {
    const index = workflow.indexOf(text);
    assert.notEqual(index, -1, `release.yml must contain ${text}`);
    return index;
  };
  assert.match(workflow, /dotnet tool install -g vpk --version \d+\.\d+\.\d+/, 'vpk is pinned to the version the delta dry run used');
  const version = position('name: Get Version and Sync package.json');
  const fetchBase = position('node scripts/release-delta-base.mjs fetch');
  const pack = position('vpk pack -u awoo-musicbot');
  const prune = position('node scripts/release-delta-base.mjs prune');
  const upload = position('files: Releases/*');
  const prewarm = position('name: Prewarm release assets in R2');
  assert.ok(version < fetchBase && fetchBase < pack && pack < prune && prune < upload && upload < prewarm);
  assert.match(workflow, /release-delta-base\.mjs fetch[^\n]*--min-version 1\.1\.0[^\n]*--pack-id awoo-musicbot/);
  assert.doesNotMatch(workflow, /release-delta-base\.mjs fetch[^\n]*--strict/, 'a missing base must fall back to the full package');
});
