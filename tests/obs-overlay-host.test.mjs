import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {
  createObsOverlayHost,
  injectObsOverlayRuntime,
  OBS_OVERLAY_CONTENT_CSP,
  OBS_OVERLAY_HOST_JS,
  OBS_OVERLAY_RUNTIME_JS
} from '../electron/obs-overlay-host.ts';
import { readSource } from './helpers/source.mjs';

const RUNTIME_TAG = '<script src="/overlay/runtime.js" defer data-awoo-overlay-runtime></script>';
const flush = () => new Promise(resolve => setImmediate(resolve));

function inject(html) {
  return injectObsOverlayRuntime(Buffer.from(html, 'utf8')).toString('utf8');
}

test('the runtime goes after <head> when the document has one', () => {
  assert.equal(
    inject('<!DOCTYPE html>\n<html lang="zh"><head data-x="1"><meta charset="utf-8"></head><body></body></html>'),
    `<!DOCTYPE html>\n<html lang="zh"><head data-x="1">\n  ${RUNTIME_TAG}<meta charset="utf-8"></head><body></body></html>`
  );
  // <header> is not <head>, and a commented-out <head> is ignored.
  assert.equal(
    inject('<!doctype html><html><!-- <head> --><head></head><body><header>x</header></body></html>'),
    `<!doctype html><html><!-- <head> --><head>\n  ${RUNTIME_TAG}</head><body><header>x</header></body></html>`
  );
});

test('without <head> the runtime goes after <html>, then after the doctype', () => {
  assert.equal(
    inject('<!doctype html>\n<html lang="zh-CN">\n<body><header>x</header></body></html>'),
    `<!doctype html>\n<html lang="zh-CN">\n${RUNTIME_TAG}\n<body><header>x</header></body></html>`
  );
  assert.equal(
    inject('<!doctype html>\n<title>Mod</title><p>hi</p>'),
    `<!doctype html>\n${RUNTIME_TAG}\n<title>Mod</title><p>hi</p>`
  );
  // A "<head>" string inside the body is not the document head.
  assert.equal(
    inject("<!DOCTYPE html><body><script>var s='<head>';</script></body>"),
    `<!DOCTYPE html>\n${RUNTIME_TAG}<body><script>var s='<head>';</script></body>`
  );
});

test('nothing is ever inserted before the doctype', () => {
  for (const html of [
    '<!doctype html><p>no head</p>',
    '\uFEFF<!doctype html><p>byte order mark</p>',
    '<!-- build 42 -->\n<!DOCTYPE html><html><body></body></html>',
    '  \n<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN"><html><head></head></html>'
  ]) {
    const injected = inject(html);
    const doctype = injected.search(/<!doctype/i);
    assert.ok(doctype !== -1 && doctype < injected.indexOf(RUNTIME_TAG), html);
    assert.equal(injected.slice(0, doctype), html.slice(0, html.search(/<!doctype/i)), 'prolog unchanged');
  }
  assert.equal(inject('<p>fragment</p>'), `${RUNTIME_TAG}\n<p>fragment</p>`);
  assert.equal(inject('\uFEFF<p>fragment</p>'), `\uFEFF${RUNTIME_TAG}\n<p>fragment</p>`);
  const already = Buffer.from(`<!doctype html><head>${RUNTIME_TAG}</head>`);
  assert.equal(injectObsOverlayRuntime(already), already);
});

function hostHarness(initialState, search = '') {
  const posted = [];
  const handlers = {};
  const windowHandlers = {};
  let state = initialState;
  let tick = null;
  const contentWindow = { postMessage: message => posted.push(JSON.parse(JSON.stringify(message))) };
  const frame = {
    dataset: {},
    src: '',
    contentWindow,
    addEventListener: (type, handler) => { handlers[type] = handler; }
  };
  const status = { textContent: '' };
  const context = vm.createContext({
    document: { getElementById: id => (id === 'awoo-overlay-frame' ? frame : status) },
    fetch: async () => ({ ok: true, json: async () => JSON.parse(JSON.stringify(state)) }),
    URLSearchParams,
    window: {
      location: { search },
      addEventListener: (type, handler) => { windowHandlers[type] = handler; },
      setInterval: callback => { tick = callback; }
    }
  });
  vm.runInContext(OBS_OVERLAY_HOST_JS, context);
  return {
    frame,
    status,
    posted,
    setState: next => { state = next; },
    async poll() { tick(); await flush(); },
    load: () => handlers.load(),
    ready: (source = contentWindow) => windowHandlers.message({ source, data: { type: 'awoo-overlay-ready' } })
  };
}

const nestedMod = {
  active: {
    id: 'neon', name: 'Neon', version: '1.2.0', installedAt: '2026-10-20T00:00:00.000Z',
    entry: 'dist/index.html', settings: [{ key: 'accent', type: 'color', default: '#fff' }], values: { accent: '#0ff' }
  }
};

test('the host opens the active entry so nested entries resolve their assets', async () => {
  const host = hostHarness(nestedMod);
  await flush();
  const revision = encodeURIComponent('neon@1.2.0@2026-10-20T00:00:00.000Z');
  assert.equal(host.frame.src, `/overlay/content/dist/index.html?revision=${revision}`);
  assert.equal(host.frame.dataset.ready, 'false');

  host.setState({ active: { ...nestedMod.active, version: '1.3.0', entry: 'pages/my page#1.html' } });
  await host.poll();
  assert.match(host.frame.src, /^\/overlay\/content\/pages\/my%20page%231\.html\?revision=neon%401\.3\.0%40/);

  host.setState({ active: { id: 'builtin', version: '1.2.6', installedAt: '', entry: '' } });
  await host.poll();
  assert.equal(host.frame.src, `/overlay/content/?revision=${encodeURIComponent('builtin@1.2.6@')}`);
  assert.match(OBS_OVERLAY_HOST_JS, /active\.entry/);
});

test('the host passes its own query parameters to the Mod page, except revision', async () => {
  const host = hostHarness(
    nestedMod,
    '?revision=stale&maxQueue=8&port=6000&name=a%26b%3Dc+d&wolf=%F0%9F%90%BA&flag'
  );
  await flush();
  const revision = encodeURIComponent('neon@1.2.0@2026-10-20T00:00:00.000Z');
  assert.equal(
    host.frame.src,
    `/overlay/content/dist/index.html?revision=${revision}&maxQueue=8&port=6000&name=a%26b%3Dc%20d&wolf=%F0%9F%90%BA&flag=`
  );
  // app.js reads these from its own location, exactly as from the host URL.
  const params = new URL(host.frame.src, 'http://127.0.0.1:5556').searchParams;
  assert.deepEqual(params.getAll('revision'), ['neon@1.2.0@2026-10-20T00:00:00.000Z'], 'the host revision is the only one');
  assert.equal(params.get('maxQueue'), '8');
  assert.equal(params.get('port'), '6000');
  assert.equal(params.get('name'), 'a&b=c d');
  assert.equal(params.get('wolf'), '🐺');
  assert.equal(params.get('flag'), '');

  const loaded = host.frame.src;
  await host.poll();
  assert.equal(host.frame.src, loaded, 'an unchanged state keeps the page');
  host.setState({ active: { ...nestedMod.active, version: '1.3.0' } });
  await host.poll();
  const reloaded = new URL(host.frame.src, 'http://127.0.0.1:5556').searchParams;
  assert.deepEqual(reloaded.getAll('revision'), ['neon@1.3.0@2026-10-20T00:00:00.000Z'], 'a new revision still busts the cache');
  assert.equal(reloaded.get('maxQueue'), '8');

  // Without a query string the address stays exactly as before.
  const plain = hostHarness(nestedMod, '');
  await flush();
  assert.equal(plain.frame.src, `/overlay/content/dist/index.html?revision=${revision}`);
});

test('settings are delivered on load, on the ready handshake and only when values change', async () => {
  const host = hostHarness(nestedMod);
  await flush();
  assert.equal(host.posted.length, 0, 'nothing is sent while the frame navigates');
  host.load();
  assert.equal(host.frame.dataset.ready, 'true');
  assert.equal(host.posted.length, 1);
  assert.deepEqual(host.posted[0], {
    type: 'awoo-overlay-settings', overlayId: 'neon', definitions: nestedMod.active.settings, values: { accent: '#0ff' }
  });

  for (let index = 0; index < 5; index += 1) await host.poll();
  assert.equal(host.posted.length, 1, 'unchanged polls do not re-deliver');

  host.setState({ active: { ...nestedMod.active, values: { accent: '#f0f' } } });
  await host.poll();
  await host.poll();
  assert.equal(host.posted.length, 2);
  assert.deepEqual(host.posted[1].values, { accent: '#f0f' });

  host.ready();
  assert.equal(host.posted.length, 3, 'the handshake always re-delivers');
  host.ready({ postMessage() {} });
  assert.equal(host.posted.length, 3, 'only the embedded frame may ask');
  host.load();
  assert.equal(host.posted.length, 4, 'a reload always re-delivers');

  host.setState({ active: { ...nestedMod.active, version: '2.0.0', values: { accent: '#f0f' } } });
  await host.poll();
  assert.equal(host.posted.length, 4, 'a new revision waits for its own load');
  host.load();
  assert.equal(host.posted.length, 5);
});

test('the runtime ignores repeated identical settings', () => {
  const events = [];
  const properties = new Map();
  const attributes = new Map();
  let listener = null;
  const parent = { postMessage: () => {} };
  const window = {
    parent,
    addEventListener: (type, handler) => { listener = handler; },
    dispatchEvent: event => events.push(event.detail)
  };
  const context = vm.createContext({
    window,
    document: {
      documentElement: {
        style: { setProperty: (name, value) => properties.set(name, value), removeProperty: name => properties.delete(name) },
        setAttribute: (name, value) => attributes.set(name, value),
        removeAttribute: name => attributes.delete(name)
      }
    },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } }
  });
  vm.runInContext(OBS_OVERLAY_RUNTIME_JS, context);
  const payload = {
    type: 'awoo-overlay-settings', overlayId: 'neon',
    definitions: [{ key: 'accentColor', cssVariable: '--accent', default: '#fff' }],
    values: { accentColor: '#0ff' }
  };
  const received = [];
  context.window.AwooOverlay.subscribe(detail => received.push(detail.values.accentColor));
  listener({ source: parent, data: payload });
  listener({ source: parent, data: JSON.parse(JSON.stringify(payload)) });
  listener({ source: parent, data: JSON.parse(JSON.stringify(payload)) });
  assert.equal(events.length, 1);
  assert.deepEqual(received, ['#0ff']);
  assert.equal(properties.get('--accent'), '#0ff');
  assert.equal(attributes.get('data-awoo-setting-accent-color'), '#0ff');
  listener({ source: parent, data: { ...payload, values: { accentColor: '#f0f' } } });
  assert.equal(events.length, 2);
  assert.deepEqual(received, ['#0ff', '#f0f']);
  listener({ source: { postMessage() {} }, data: { ...payload, values: { accentColor: '#000' } } });
  assert.equal(events.length, 2, 'only the host page may deliver settings');
});

async function withHost(options, run) {
  const host = createObsOverlayHost(options);
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    if (!(await host.serve(req, res, pathname))) {
      res.writeHead(404);
      res.end('not overlay');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(origin);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('hls.js is read once and revalidated with an ETag; the versioned alias is immutable', async () => {
  let reads = 0;
  const script = Buffer.from('/* hls */ window.Hls = function () {};');
  await withHost({
    resolveActiveAsset: async () => null,
    readVendorScript: async () => { reads += 1; return script; },
    vendorVersion: '1.7.3'
  }, async origin => {
    const plain = await fetch(`${origin}/overlay/vendor/hls.min.js`);
    assert.equal(plain.status, 200);
    assert.equal(plain.headers.get('cache-control'), 'no-cache');
    assert.equal(plain.headers.get('content-type'), 'text/javascript; charset=utf-8');
    const etag = plain.headers.get('etag');
    assert.match(etag, /^"hls-[0-9a-f]{32}"$/);
    assert.equal(Buffer.from(await plain.arrayBuffer()).equals(script), true);

    for (const header of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
      const revalidated = await fetch(`${origin}/overlay/vendor/hls.min.js`, { headers: { 'If-None-Match': header } });
      assert.equal(revalidated.status, 304, header);
      assert.equal((await revalidated.arrayBuffer()).byteLength, 0);
    }
    const stale = await fetch(`${origin}/overlay/vendor/hls.min.js`, { headers: { 'If-None-Match': '"stale"' } });
    assert.equal(stale.status, 200);
    await stale.arrayBuffer();

    const versioned = await fetch(`${origin}/overlay/vendor/hls-1.7.3.min.js`);
    assert.equal(versioned.status, 200);
    assert.equal(versioned.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(versioned.headers.get('etag'), etag);
    assert.equal(Buffer.from(await versioned.arrayBuffer()).equals(script), true);

    const otherVersion = await fetch(`${origin}/overlay/vendor/hls-1.7.2.min.js`);
    assert.equal(otherVersion.status, 404);
    await otherVersion.arrayBuffer();
  });
  assert.equal(reads, 1, 'the file is memoized');
});

test('a failed vendor read is not cached', async () => {
  let attempts = 0;
  await withHost({
    resolveActiveAsset: async () => null,
    readVendorScript: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('ENOENT: hls.min.js');
      return Buffer.from('ok');
    },
    vendorVersion: ''
  }, async origin => {
    const failed = await fetch(`${origin}/overlay/vendor/hls.min.js`);
    assert.equal(failed.status, 500);
    assert.equal(failed.headers.get('cache-control'), 'no-store');
    await failed.arrayBuffer();
    const retried = await fetch(`${origin}/overlay/vendor/hls.min.js`);
    assert.equal(retried.status, 200);
    assert.equal(await retried.text(), 'ok');
    const noAlias = await fetch(`${origin}/overlay/vendor/hls-.min.js`);
    assert.equal(noAlias.status, 404, 'no versioned alias without a version');
    await noAlias.arrayBuffer();
  });
});

test('Mod content is served with the runtime and the unchanged content CSP', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awoo-overlay-host-'));
  try {
    await fs.mkdir(path.join(root, 'dist'));
    await fs.writeFile(path.join(root, 'dist', 'index.html'), '<!doctype html><link rel="stylesheet" href="styles.css"><p>neon</p>');
    await fs.writeFile(path.join(root, 'dist', 'styles.css'), 'p{color:red}');
    const requested = [];
    await withHost({
      resolveActiveAsset: async relativePath => {
        requested.push(relativePath);
        const file = path.join(root, ...(relativePath || 'dist/index.html').split('/'));
        try {
          await fs.access(file);
        } catch {
          return null;
        }
        return {
          filePath: file,
          contentType: file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/css; charset=utf-8',
          revision: 'neon@1.2.0:2026-10-20'
        };
      },
      readVendorScript: async () => Buffer.alloc(0),
      vendorVersion: '1.7.3'
    }, async origin => {
      const page = await fetch(`${origin}/overlay/content/dist/index.html?revision=x`);
      assert.equal(page.status, 200);
      assert.equal(page.headers.get('x-awoo-overlay-revision'), 'neon@1.2.0:2026-10-20');
      assert.equal(page.headers.get('cache-control'), 'no-store');
      assert.equal(page.headers.get('content-security-policy'), OBS_OVERLAY_CONTENT_CSP);
      assert.equal(await page.text(), `<!doctype html>\n${RUNTIME_TAG}<link rel="stylesheet" href="styles.css"><p>neon</p>`);

      const styles = await fetch(`${origin}/overlay/content/dist/styles.css`);
      assert.equal(await styles.text(), 'p{color:red}');
      const root = await fetch(`${origin}/overlay/content/`);
      assert.equal(root.status, 200);
      await root.arrayBuffer();
      const malformed = await fetch(`${origin}/overlay/content/%E0%A4%A`);
      assert.equal(malformed.status, 404);
      await malformed.arrayBuffer();
      const missing = await fetch(`${origin}/overlay/content/nope.js`);
      assert.equal(missing.status, 404);
      assert.equal(await missing.text(), 'Mod UI asset not found');

      const hostPage = await fetch(`${origin}/overlay/`);
      assert.match(await hostPage.text(), /sandbox="allow-scripts"/);
      assert.match(hostPage.headers.get('content-security-policy'), /base-uri 'none'/);
      const other = await fetch(`${origin}/api/v1/state`);
      assert.equal(other.status, 404, 'non-overlay paths are left to the caller');
      await other.arrayBuffer();
    });
    assert.deepEqual(requested, ['dist/index.html', 'dist/styles.css', '', 'nope.js']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the legacy content root redirects to the active entry and keeps the query string', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awoo-overlay-host-'));
  try {
    await fs.mkdir(path.join(root, 'dist'));
    await fs.mkdir(path.join(root, 'pages'));
    await fs.writeFile(path.join(root, 'dist', 'index.html'), '<!doctype html><link rel="stylesheet" href="styles.css">');
    await fs.writeFile(path.join(root, 'pages', 'my page#1.html'), '<!doctype html><p>encoded</p>');
    let entry = 'dist/index.html';
    await withHost({
      resolveActiveAsset: async relativePath => {
        const file = path.join(root, ...(relativePath.replace(/^\/+/, '') || entry).split('/'));
        try {
          await fs.access(file);
        } catch {
          return null;
        }
        return { filePath: file, contentType: 'text/html; charset=utf-8', revision: 'neon@1.2.0', entry };
      },
      readVendorScript: async () => Buffer.alloc(0),
      vendorVersion: '1.7.3'
    }, async origin => {
      const legacy = await fetch(`${origin}/overlay/content/?revision=neon%401.2.0&maxQueue=8`, { redirect: 'manual' });
      assert.equal(legacy.status, 302);
      assert.equal(legacy.headers.get('location'), '/overlay/content/dist/index.html?revision=neon%401.2.0&maxQueue=8');
      assert.equal(legacy.headers.get('cache-control'), 'no-store', 'the active entry can change at any time');
      await legacy.arrayBuffer();

      // Followed, the entry is served at its own base, so styles.css resolves to dist/styles.css.
      const followed = await fetch(`${origin}/overlay/content/?maxQueue=8`);
      assert.equal(followed.status, 200);
      assert.equal(followed.url, `${origin}/overlay/content/dist/index.html?maxQueue=8`);
      assert.match(await followed.text(), /href="styles\.css"/);

      for (const [requested, location] of [
        ['/overlay/content/', '/overlay/content/dist/index.html'],
        ['/overlay/content//', '/overlay/content/dist/index.html']
      ]) {
        const response = await fetch(`${origin}${requested}`, { redirect: 'manual' });
        assert.equal(response.headers.get('location'), location, requested);
        await response.arrayBuffer();
      }

      entry = 'pages/my page#1.html';
      const encoded = await fetch(`${origin}/overlay/content/?a=1`, { redirect: 'manual' });
      assert.equal(encoded.headers.get('location'), '/overlay/content/pages/my%20page%231.html?a=1');
      await encoded.arrayBuffer();
      const page = await fetch(`${origin}/overlay/content/pages/my%20page%231.html?a=1`);
      assert.equal(page.status, 200, 'the redirect target is the entry itself, so it never loops');
      assert.match(await page.text(), /encoded/);
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('the Mod content CSP is unchanged by the extraction', () => {
  assert.equal(
    OBS_OVERLAY_CONTENT_CSP,
    "default-src 'self'; connect-src http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:* https://*.itunes.apple.com https://*.mzstatic.com; media-src blob: https://*.itunes.apple.com https://*.mzstatic.com; img-src http: https: data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self' file: http://127.0.0.1:* http://localhost:*"
  );
});

test('main serves the overlay through the extracted host with the bundled hls.js file', () => {
  const main = readSource('electron/main.ts');
  assert.doesNotMatch(main, /OBS_OVERLAY_HOST_JS|function serveObsOverlay|function injectObsOverlayRuntime/);
  assert.match(main, /createObsOverlayHost\(\{/);
  assert.match(main, /path\.join\(app\.getAppPath\(\), 'dist', 'overlay-vendor', 'hls\.min\.js'\)/);
  assert.match(main, /customRequire\.resolve\('hls\.js\/dist\/hls\.min\.js'\)/);
  assert.match(main, /vendorVersion: HLS_VENDOR_VERSION/);
  assert.match(main, /import \{ version as HLS_VENDOR_VERSION \} from 'hls\.js\/package\.json'/);
});
