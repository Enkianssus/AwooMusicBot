import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DynamicCoverService } from '../electron/dynamic-cover-service.ts';

const videoUrl = 'https://mvod.itunes.apple.com/itunes-assets/test/cover.m3u8';
const albumUrl = 'https://music.apple.com/cn/album/this-is-our-life/1867199281?i=1867199282';
const html = (body, options = {}) => new Response(body, {
  ...options, headers: { 'Content-Type': 'text/html; charset=utf-8', ...options.headers },
});
const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const result = (title = 'This Is Our Life', artists = ['CRi', 'Nicky Elisabeth'], url = albumUrl, index = 0) => `
  <li data-index="${index}"><ul>
    <li class="track-lockup__title"><a href="${escape(url)}">${escape(title)}</a></li>
    <li class="track-lockup__subtitle">${artists.map((artist, i) => `<a href="https://music.apple.com/cn/artist/name/${i}">${escape(artist)}</a>`).join(' / ')}</li>
  </ul></li>`;
const search = (...results) => `<div aria-label="歌曲">${results.join('')}</div>`;
const album = (url = videoUrl) => `<amp-ambient-video src="${escape(url)}"></amp-ambient-video>`;
const subject = ['This Is Our Life', 'CRi / Nicky Elisabeth'];
const flush = () => new Promise(resolve => setImmediate(resolve));

test('matches title and all artists, then returns the Apple video with credential-free requests', async () => {
  const calls = [];
  const service = new DynamicCoverService({ fetch: async (url, options) => {
    calls.push({ url, options });
    return html(calls.length === 1 ? search(result()) : album());
  } });
  assert.equal(await service.lookup(...subject), videoUrl);
  assert.equal(service.getCached(...subject), videoUrl);
  assert.equal(new URL(calls[0].url).searchParams.get('term'), subject.join(' - '));
  assert.equal(calls[1].url, albumUrl);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.options.credentials, 'omit');
    assert.equal(call.options.redirect, 'manual');
    assert.ok(call.options.signal instanceof AbortSignal);
    assert.equal(call.options.headers.Authorization, undefined);
  }
  service.dispose();
});

test('same title with another artist, incomplete artists, or another version never matches', async () => {
  let calls = 0;
  const service = new DynamicCoverService({ fetch: async () => {
    calls++;
    return html(search(
      result('This Is Our Life', ['Someone Else'], albumUrl, 0),
      result('This Is Our Life', ['CRi'], albumUrl, 1),
      result('This Is Our Life (Live)', ['CRi', 'Nicky Elisabeth'], albumUrl, 2),
    ));
  } });
  assert.equal(await service.lookup(...subject), '');
  assert.equal(calls, 1);
  service.dispose();
});

test('skips wrong artists but accepts exact artist names in a different order', async () => {
  const calls = [];
  const service = new DynamicCoverService({ fetch: async url => {
    calls.push(url);
    return html(calls.length === 1
      ? search(result('This Is Our Life', ['Other'], albumUrl, 0), result('This Is Our Life', ['Nicky Elisabeth', 'CRi'], albumUrl, 1))
      : album());
  } });
  assert.equal(await service.lookup(...subject), videoUrl);
  assert.equal(calls.length, 2);
  service.dispose();
});

test('an unavailable matching album does not hide a later matching album with video', async () => {
  const unavailableAlbum = 'https://music.apple.com/cn/album/this-is-our-life/111?i=112';
  const calls = [];
  const service = new DynamicCoverService({ fetch: async url => {
    calls.push(url);
    if (calls.length === 1) return html(search(
      result(subject[0], ['CRi', 'Nicky Elisabeth'], unavailableAlbum, 0),
      result(subject[0], ['CRi', 'Nicky Elisabeth'], albumUrl, 1),
    ));
    if (url === unavailableAlbum) return html('temporarily unavailable', { status: 503 });
    return html(album());
  } });
  assert.equal(await service.lookup(...subject), videoUrl);
  assert.equal(service.getCached(...subject), videoUrl);
  assert.deepEqual(calls.slice(1), [unavailableAlbum, albumUrl]);
  service.dispose();
});

test('an aborted matching album request does not continue to later candidates', async () => {
  let calls = 0;
  const service = new DynamicCoverService({ timeoutMs: 15, fetch: async () => {
    calls++;
    if (calls === 1) return html(search(
      result(subject[0], ['CRi', 'Nicky Elisabeth'], albumUrl, 0),
      result(subject[0], ['CRi', 'Nicky Elisabeth'], 'https://music.apple.com/cn/album/alternate/222', 1),
    ));
    return new Promise(() => {});
  } });
  assert.equal(await service.lookup(...subject), '');
  assert.equal(calls, 2);
  service.dispose();
});

test('missing or oversized identity does not request or cache anything', async () => {
  let calls = 0;
  const service = new DynamicCoverService({ fetch: async () => { calls++; return html(''); } });
  for (const song of [['', 'Artist'], ['Title', ' '], ['x'.repeat(513), 'Artist']]) {
    assert.equal(await service.lookup(...song), '');
    assert.equal(service.getCached(...song), '');
  }
  assert.equal(calls, 0);
  service.dispose();
});

test('deduplicates simultaneous lookups and caches success until its expiration', async () => {
  let now = 100;
  let calls = 0;
  const service = new DynamicCoverService({ now: () => now, successTtlMs: 50, fetch: async () => {
    calls++;
    return html(calls % 2 ? search(result()) : album());
  } });
  const first = service.lookup(...subject);
  assert.equal(first, service.lookup(...subject));
  assert.equal(await first, videoUrl);
  await flush();
  assert.equal(await service.lookup(' this is our life ', 'cri / nicky elisabeth'), videoUrl);
  assert.equal(calls, 2);
  now = 150;
  assert.equal(service.getCached(...subject), '');
  assert.equal(await service.lookup(...subject), videoUrl);
  assert.equal(calls, 4);
  service.dispose();
});

test('no dynamic artwork and fetch errors are negative-cached for the shorter TTL', async () => {
  for (const failing of [false, true]) {
    let now = 0;
    let calls = 0;
    const service = new DynamicCoverService({ now: () => now, failureTtlMs: 10, fetch: async () => {
      calls++;
      if (failing) throw new Error('offline');
      return html(calls % 2 ? search(result()) : '<img src="artwork.jpg">');
    } });
    assert.equal(await service.lookup(...subject), '');
    await flush();
    const priorCalls = calls;
    assert.equal(await service.lookup(...subject), '');
    assert.equal(calls, priorCalls);
    now = 10;
    assert.equal(await service.lookup(...subject), '');
    assert.ok(calls > priorCalls);
    service.dispose();
  }
});

test('only the first five search candidates are considered', async () => {
  let calls = 0;
  const service = new DynamicCoverService({ fetch: async () => {
    calls++;
    return html(search(...Array.from({ length: 6 }, (_, index) => result(
      'This Is Our Life', index === 5 ? ['CRi', 'Nicky Elisabeth'] : ['Other'], albumUrl, index,
    ))));
  } });
  assert.equal(await service.lookup(...subject), '');
  assert.equal(calls, 1);
  service.dispose();
});

test('rejects untrusted album URLs and off-domain or credentialed media', async () => {
  for (const url of ['https://evil.test/cn/album/x', 'http://music.apple.com/cn/album/x', 'https://user:secret@music.apple.com/cn/album/x']) {
    let calls = 0;
    const service = new DynamicCoverService({ fetch: async () => {
      calls++;
      return html(search(result(...[subject[0], ['CRi', 'Nicky Elisabeth'], url])));
    } });
    assert.equal(await service.lookup(...subject), '');
    assert.equal(calls, 1);
    service.dispose();
  }
  for (const url of [
    'https://evil.test/cover.m3u8', 'https://mvod.itunes.apple.com.evil.test/cover.m3u8',
    'http://mvod.itunes.apple.com/cover.m3u8', 'https://mvod.itunes.apple.com:444/cover.m3u8',
    'https://user:secret@mvod.itunes.apple.com/cover.m3u8', 'https://mvod.itunes.apple.com/cover.html',
  ]) {
    let calls = 0;
    const service = new DynamicCoverService({ fetch: async () => html(++calls === 1 ? search(result()) : album(url)) });
    assert.equal(await service.lookup(...subject), '');
    service.dispose();
  }
});

test('redirects remain on Apple pages, with a finite redirect budget', async () => {
  for (const location of ['https://evil.test/cn/search', 'https://music.apple.com/cn/browse', 'https://music.apple.com/cn/search']) {
    let calls = 0;
    const service = new DynamicCoverService({ fetch: async () => {
      calls++;
      return html('', { status: 302, headers: { location } });
    } });
    assert.equal(await service.lookup(...subject), '');
    assert.equal(calls, location.endsWith('/search') && location.includes('music.apple.com') ? 4 : 1);
    service.dispose();
  }
});

test('response size, non-HTML, HTTP failures, and stalled operations fall back to static artwork', async () => {
  const responses = [
    () => html('x'.repeat(257)),
    () => html('small', { headers: { 'content-length': '257' } }),
    () => html('{}', { headers: { 'Content-Type': 'application/json' } }),
    () => html('failure', { status: 503 }),
    () => new Promise(() => {}),
    () => html(new ReadableStream({ start() {} })),
  ];
  for (const respond of responses) {
    const service = new DynamicCoverService({ timeoutMs: 15, maxResponseBytes: 256, fetch: async () => respond() });
    assert.equal(await service.lookup(...subject), '');
    service.dispose();
  }
});

test('limits concurrent work to two and bounds the pending queue', async () => {
  let calls = 0;
  const service = new DynamicCoverService({ maxConcurrent: 99, fetch: async () => {
    calls++;
    return new Promise(() => {});
  } });
  const requests = Array.from({ length: 34 }, (_, index) => service.lookup(`Song ${index}`, 'Artist'));
  assert.equal(calls, 2);
  assert.equal(await service.lookup('Over capacity', 'Artist'), '');
  service.clear();
  assert.deepEqual(await Promise.all(requests), Array(34).fill(''));
  assert.equal(calls, 2);
  service.dispose();
});

test('LRU cache evicts the least recently accessed entry at its capacity', async () => {
  const calls = [];
  const service = new DynamicCoverService({ maxCacheEntries: 2, fetch: async url => {
    calls.push(new URL(url).searchParams.get('term'));
    return html(search());
  } });
  await service.lookup('A', 'Artist');
  await service.lookup('B', 'Artist');
  await flush();
  service.getCached('A', 'Artist');
  await service.lookup('C', 'Artist');
  await flush();
  await service.lookup('A', 'Artist');
  assert.equal(calls.length, 3);
  await service.lookup('B', 'Artist');
  assert.equal(calls.length, 4);
  service.dispose();
});

test('clear aborts work and a late fetch cannot repopulate cache; dispose prevents new requests', async () => {
  let finish;
  let signal;
  let calls = 0;
  const service = new DynamicCoverService({ fetch: async (_url, options) => {
    calls++;
    signal = options.signal;
    return new Promise(resolve => { finish = resolve; });
  } });
  const pending = service.lookup(...subject);
  service.clear();
  assert.equal(signal.aborted, true);
  assert.equal(await pending, '');
  finish(html(search(result())));
  await flush();
  assert.equal(service.getCached(...subject), '');
  assert.equal(calls, 1);
  service.dispose();
  assert.equal(await service.lookup(...subject), '');
  assert.equal(calls, 1);
});

async function diagnose(fetch, options = {}) {
  const diagnostics = [];
  const service = new DynamicCoverService({ fetch, onDiagnostic: item => diagnostics.push(item), ...options });
  const url = await service.lookup(...subject);
  service.dispose();
  return { url, diagnostics };
}

test('each finished lookup reports exactly one diagnostic outcome', async () => {
  const sequence = (...responses) => {
    let calls = 0;
    return async () => responses[Math.min(calls++, responses.length - 1)]();
  };
  const cases = [
    [sequence(() => html(search(result())), () => html(album())), { kind: 'hit' }],
    [sequence(() => html(search(result())), () => html('<img src="artwork.jpg">')), { kind: 'miss' }],
    [sequence(() => html(search(result('Other Song')))), { kind: 'miss' }],
    [sequence(() => html(search())), { kind: 'no-candidates' }],
    [sequence(() => html('<main>markup changed</main>')), { kind: 'no-candidates' }],
    [sequence(() => html('busy', { status: 503 })), { kind: 'http', status: 503 }],
    [sequence(() => html('slow down', { status: 429 })), { kind: 'http', status: 429 }],
    [sequence(() => html('blocked', { status: 403 })), { kind: 'http', status: 403 }],
    [async () => { throw new TypeError('fetch failed'); }, { kind: 'http' }],
    [sequence(() => html('{}', { headers: { 'Content-Type': 'application/json' } })), { kind: 'parse' }],
    [sequence(() => html('x'.repeat(300))), { kind: 'parse' }, { maxResponseBytes: 256 }],
    [() => new Promise(() => {}), { kind: 'timeout' }, { timeoutMs: 15 }],
  ];
  for (const [fetch, expected, options] of cases) {
    const { url, diagnostics } = await diagnose(fetch, options);
    assert.equal(url, expected.kind === 'hit' ? videoUrl : '', JSON.stringify(expected));
    assert.deepEqual(diagnostics, [expected]);
  }
});

test('a timeout is retried after 60 seconds, but not before', async () => {
  let now = 0;
  let calls = 0;
  const service = new DynamicCoverService({ now: () => now, timeoutMs: 15, fetch: async () => {
    calls++;
    return new Promise(() => {});
  } });
  assert.equal(await service.lookup(...subject), '');
  assert.equal(calls, 1);
  now = 59_999;
  assert.equal(await service.lookup(...subject), '');
  assert.equal(calls, 1);
  now = 60_000;
  assert.equal(await service.lookup(...subject), '');
  assert.equal(calls, 2);
  service.dispose();
});

test('HTTP 429/5xx and network errors are transient; other answers are cached for 10 minutes', async () => {
  for (const [respond, transient] of [
    [() => html('busy', { status: 503 }), true],
    [() => html('slow down', { status: 429 }), true],
    [() => { throw new TypeError('fetch failed'); }, true],
    [() => html('missing', { status: 404 }), false],
    [() => html(search()), false],
    [() => html('{}', { headers: { 'Content-Type': 'application/json' } }), false],
  ]) {
    let now = 0;
    let calls = 0;
    const service = new DynamicCoverService({ now: () => now, fetch: async () => { calls++; return respond(); } });
    await service.lookup(...subject);
    await flush();
    now = 60_000;
    await service.lookup(...subject);
    await flush();
    assert.equal(calls, transient ? 2 : 1, String(respond));
    now = 60_000 + 10 * 60_000;
    await service.lookup(...subject);
    assert.equal(calls, transient ? 3 : 2, String(respond));
    service.dispose();
  }
});

test('a definitive miss after HTTP 200 stays cached for 10 minutes', async () => {
  let now = 0;
  let calls = 0;
  const diagnostics = [];
  const service = new DynamicCoverService({
    now: () => now, onDiagnostic: item => diagnostics.push(item.kind),
    fetch: async () => html(++calls % 2 ? search(result()) : '<img src="artwork.jpg">'),
  });
  assert.equal(await service.lookup(...subject), '');
  await flush();
  assert.equal(calls, 2);
  now = 10 * 60_000 - 1;
  assert.equal(await service.lookup(...subject), '');
  assert.equal(calls, 2);
  now = 10 * 60_000;
  assert.equal(await service.lookup(...subject), '');
  assert.equal(calls, 4);
  assert.deepEqual(diagnostics, ['miss', 'miss']);
  service.dispose();
});

test('an edition that failed transiently keeps an otherwise empty result provisional', async () => {
  let now = 0;
  let calls = 0;
  const diagnostics = [];
  const service = new DynamicCoverService({
    now: () => now, onDiagnostic: item => diagnostics.push(item),
    fetch: async () => (++calls === 1 ? html(search(result())) : html('busy', { status: 502 })),
  });
  assert.equal(await service.lookup(...subject), '');
  assert.deepEqual(diagnostics, [{ kind: 'http', status: 502 }]);
  await flush();
  calls = 0;
  now = 60_000;
  await service.lookup(...subject);
  assert.equal(calls, 2);
  service.dispose();
});

test('cancelled lookups report nothing and a failing diagnostic callback cannot affect artwork', async () => {
  const diagnostics = [];
  const cancelled = new DynamicCoverService({ onDiagnostic: item => diagnostics.push(item), fetch: () => new Promise(() => {}) });
  const pending = cancelled.lookup(...subject);
  cancelled.clear();
  assert.equal(await pending, '');
  await flush();
  assert.deepEqual(diagnostics, []);
  cancelled.dispose();

  let calls = 0;
  const service = new DynamicCoverService({
    onDiagnostic() { throw new Error('logger failed'); },
    fetch: async () => html(++calls === 1 ? search(result()) : album()),
  });
  assert.equal(await service.lookup(...subject), videoUrl);
  assert.equal(service.getCached(...subject), videoUrl);
  service.dispose();
});

test('the HTML parser is the lazily loaded htmlparser2-only cheerio entry', () => {
  const source = fs.readFileSync(new URL('../electron/dynamic-cover-service.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from 'cheerio'/);
  assert.doesNotMatch(source, /^\s*import\b[^(]*['"]cheerio/m);
  assert.match(source, /await import\('cheerio\/slim'\)/);
});
