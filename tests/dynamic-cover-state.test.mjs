import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { createLookupDebouncer, withDynamicCover } from '../electron/dynamic-cover-state.ts';

function createLookup() {
  const values = new Map();
  const requests = [];
  return {
    values,
    requests,
    getCached(title, artist) { return values.get(`${title}|${artist}`) || ''; },
    lookup(title, artist) {
      return new Promise(resolve => requests.push({ title, artist, resolve: url => {
        values.set(`${title}|${artist}`, url);
        resolve(url);
      } }));
    }
  };
}

test('default-on snapshots immediately keep the static cover, then add resolved video', async () => {
  const service = createLookup();
  const song = { Id: '1', SongName: 'Song', ArtistName: 'Artist', CoverUrl: 'static.jpg' };
  const first = withDynamicCover(song, undefined, service);
  assert.equal(first.CoverUrl, 'static.jpg');
  assert.equal(first.DynamicCoverUrl, '');
  assert.equal(service.requests.length, 1);
  service.requests[0].resolve('https://mvod.itunes.apple.com/song.m3u8');
  await Promise.resolve();
  assert.equal(withDynamicCover(song, true, service).DynamicCoverUrl, 'https://mvod.itunes.apple.com/song.m3u8');
  assert.equal(Object.hasOwn(song, 'DynamicCoverUrl'), false);
});

test('late results for an old title or artist cannot be displayed for the new song', () => {
  const service = createLookup();
  const oldSong = { SongName: 'Same title', ArtistName: 'First artist' };
  const nextSong = { SongName: 'Same title', ArtistName: 'Other artist' };
  withDynamicCover(oldSong, true, service);
  withDynamicCover(nextSong, true, service);
  service.requests[0].resolve('https://mvod.itunes.apple.com/old.m3u8');
  assert.equal(withDynamicCover(nextSong, true, service).DynamicCoverUrl, '');
});

test('explicit off hides even cached/embedded video without making a request', () => {
  const service = createLookup();
  service.values.set('Song|Artist', 'cached.m3u8');
  const song = { SongName: 'Song', ArtistName: 'Artist', CoverUrl: 'static.jpg', DynamicCoverUrl: 'old.m3u8' };
  const result = withDynamicCover(song, false, service);
  assert.equal(result.DynamicCoverUrl, '');
  assert.equal(result.CoverUrl, 'static.jpg');
  assert.equal(song.DynamicCoverUrl, 'old.m3u8');
  assert.equal(service.requests.length, 0);
});

test('empty or unknown metadata does not trigger a broad lookup', () => {
  const service = createLookup();
  assert.equal(withDynamicCover(null, true, service), null);
  for (const song of [
    { SongName: 'Song' },
    { SongName: 'Song', ArtistName: '未知歌手' },
    { SongName: '未知歌曲', ArtistName: 'Artist' }
  ]) {
    assert.equal(withDynamicCover(song, true, service).DynamicCoverUrl, '');
  }
  assert.equal(service.requests.length, 0);
});

test('lookup:false snapshots only read cached video and never query Apple', () => {
  const service = createLookup();
  const song = { SongName: 'Song', ArtistName: 'Artist', CoverUrl: 'static.jpg' };
  assert.equal(withDynamicCover(song, true, service, { lookup: false }).DynamicCoverUrl, '');
  service.values.set('Song|Artist', 'https://mvod.itunes.apple.com/song.m3u8');
  assert.equal(
    withDynamicCover(song, undefined, service, { lookup: false }).DynamicCoverUrl,
    'https://mvod.itunes.apple.com/song.m3u8'
  );
  assert.equal(withDynamicCover(song, false, service, { lookup: false }).DynamicCoverUrl, '');
  assert.equal(service.requests.length, 0);
  withDynamicCover(song, true, service, {});
  assert.equal(service.requests.length, 1);
});

test('the lookup debouncer waits until a song has stayed current for two seconds', () => {
  const debouncer = createLookupDebouncer();
  assert.equal(debouncer.shouldLookup('A', 10_000), false);
  assert.equal(debouncer.shouldLookup('A', 11_999), false);
  assert.equal(debouncer.shouldLookup('A', 12_000), true);
  assert.equal(debouncer.shouldLookup('A', 13_000), true);
  // Rapid skips restart the wait, so skipped songs are never looked up.
  assert.equal(debouncer.shouldLookup('B', 13_500), false);
  assert.equal(debouncer.shouldLookup('C', 14_000), false);
  assert.equal(debouncer.shouldLookup('A', 15_000), false);
  assert.equal(debouncer.shouldLookup('A', 17_000), true);
  assert.equal(debouncer.shouldLookup('', 30_000), false);
  assert.equal(debouncer.shouldLookup('', 40_000), false);

  const quick = createLookupDebouncer(500);
  assert.equal(quick.shouldLookup('A', 0), false);
  assert.equal(quick.shouldLookup('A', 500), true);
});

test('main debounces artwork lookups and keeps the config snapshot cache-only', () => {
  const main = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true);
  const declaration = parsed.statements.find(value => ts.isFunctionDeclaration(value)
    && value.name?.text === 'getSongWithDynamicCover');
  assert.ok(declaration);
  let now = 0;
  const service = createLookup();
  const context = vm.createContext({
    Date: { now: () => now }, withDynamicCover, dynamicCoverService: service,
    dynamicCoverLookupDebouncer: createLookupDebouncer(), appConfig: { sysConfig: {} }
  });
  vm.runInContext(ts.transpileModule(declaration.getText(parsed), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }
  }).outputText, context);
  const skipped = { SongName: 'Skipped', ArtistName: 'Artist' };
  const kept = { SongName: 'Kept', ArtistName: 'Artist' };
  context.getSongWithDynamicCover(skipped);
  now = 1_500;
  context.getSongWithDynamicCover(kept);
  assert.equal(context.getSongWithDynamicCover(null), null);
  now = 3_499;
  context.getSongWithDynamicCover(kept, { lookup: false });
  context.getSongWithDynamicCover(kept);
  assert.equal(service.requests.length, 0);
  now = 3_500;
  context.getSongWithDynamicCover(kept);
  assert.deepEqual(service.requests.map(request => request.title), ['Kept']);
  assert.match(main, /current: getSongWithDynamicCover\(currentPlayingSong \|\| playerCurrentTrack, \{ lookup: false \}\)/);
});
