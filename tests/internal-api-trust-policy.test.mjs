import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  classifyInternalRequest,
  createAppRendererUrlMatcher,
  isCrossSiteFetch,
  isLoopbackHostHeader,
  isLoopbackOrigin,
  isSameAppOrigin,
  isSensitiveInternalPath,
  isValidInternalToken,
  mayTriggerNetworkWork,
  SENSITIVE_INTERNAL_GET_PREFIXES,
  shouldAttachInternalToken
} from '../electron/internal-api-trust-policy.ts';
import { readSource, sliceBetween } from './helpers/source.mjs';

const WINDOWS_INDEX = 'C:\\Program Files\\嗷呜点歌机\\resources\\app.asar\\dist\\index.html';
const WINDOWS_FALLBACK = 'C:\\Program Files\\嗷呜点歌机\\resources\\app.asar\\renderer\\index.html';
const DEV_URL = 'http://localhost:5173/';

const windowsRenderer = createAppRendererUrlMatcher({
  rendererFiles: [WINDOWS_INDEX, WINDOWS_FALLBACK],
  platform: 'win32'
});
const devRenderer = createAppRendererUrlMatcher({
  rendererFiles: [WINDOWS_INDEX],
  devUrl: DEV_URL,
  platform: 'win32'
});
// What BrowserWindow.loadFile produces: Chromium's encoding of the same path.
const PACKAGED_ADMIN_URL = 'file:///C:/Program%20Files/%E5%97%B7%E5%91%9C%E7%82%B9%E6%AD%8C%E6%9C%BA/resources/app.asar/dist/index.html?admin=true&tab=appearance';

function attach(overrides = {}) {
  return shouldAttachInternalToken({
    isInternalApiUrl: true,
    webContentsId: 7,
    trustedWebContentsIds: [7, 9],
    frame: { isMainFrame: true, url: PACKAGED_ADMIN_URL },
    isAppRendererUrl: windowsRenderer,
    ...overrides
  });
}

function classify(overrides = {}) {
  return classifyInternalRequest({
    origin: undefined,
    hasValidToken: false,
    isTrustedSkinMarketplace: false,
    isSameAppOrigin: false,
    method: 'GET',
    pathname: '/data',
    ...overrides
  });
}

test('only the loopback names of the listening port are accepted as Host', () => {
  for (const host of ['127.0.0.1:5555', 'localhost:5555', 'LOCALHOST:5555', 'LocalHost:5555', '[::1]:5555']) {
    assert.equal(isLoopbackHostHeader(host, 5555), true, host);
  }
  for (const host of [
    undefined, '', '127.0.0.1', 'localhost', '127.0.0.1:5556', 'localhost:55555', '127.0.0.2:5555',
    'evil.example:5555', 'evil.example', '127.0.0.1.nip.io:5555', 'localhost.:5555',
    '[::1]', '[::2]:5555', '127.0.0.1:5555 ', ' 127.0.0.1:5555', '127.0.0.1:5555@evil.example'
  ]) {
    assert.equal(isLoopbackHostHeader(host, 5555), false, String(host));
  }
  assert.equal(isLoopbackHostHeader('127.0.0.1:5555', null), false, 'not listening yet');
  assert.equal(isLoopbackHostHeader('127.0.0.1:0', 0), false);
});

test('the token is attached to the trusted top-level renderer frame', () => {
  assert.equal(attach(), true, 'packaged admin window on file://');
  assert.equal(attach({ webContentsId: 9, frame: {
    isMainFrame: true,
    url: pathToFileURL(WINDOWS_INDEX, { windows: true }).href + '?mode=electron'
  } }), true, 'overlay window, Node-encoded file URL');
  assert.equal(attach({ frame: {
    isMainFrame: true,
    url: 'file:///c:/PROGRAM FILES/嗷呜点歌机/resources/app.asar/dist/index.html#queue'
  } }), true, 'drive letter and case differ, unencoded path');
  assert.equal(attach({ frame: {
    isMainFrame: true,
    url: 'file:///C:/Program%20Files/%E5%97%B7%E5%91%9C%E7%82%B9%E6%AD%8C%E6%9C%BA/resources/app.asar/renderer/index.html?admin=true'
  } }), true, 'loadWindow fallback document');
  assert.equal(attach({ isAppRendererUrl: devRenderer, frame: {
    isMainFrame: true, url: 'http://localhost:5173/?admin=true&tab=updates'
  } }), true, 'dev server renderer');
});

test('a request without a frame keeps the token only for trusted windows', () => {
  // keepalive settings flushes may outlive the closing window's frame.
  assert.equal(attach({ frame: null }), true);
  assert.equal(attach({ frame: undefined }), true);
  assert.equal(attach({ frame: null, webContentsId: 8 }), false);
  assert.equal(attach({ frame: null, webContentsId: undefined }), false);
});

test('sub-frames, foreign windows and other pages never get the token', () => {
  assert.equal(attach({ frame: { isMainFrame: false, url: PACKAGED_ADMIN_URL } }), false, 'sub-frame with app URL');
  assert.equal(attach({ frame: { isMainFrame: false, url: 'http://127.0.0.1:5556/overlay/?preview=1' } }), false, 'Mod UI preview host');
  assert.equal(attach({ frame: { isMainFrame: false, url: 'http://127.0.0.1:5556/overlay/content/dist/index.html?revision=x' } }), false, 'sandboxed Mod UI');
  assert.equal(attach({ frame: { isMainFrame: true, url: 'http://127.0.0.1:5556/overlay/' } }), false, 'external API page as a top frame');
  assert.equal(attach({ frame: { isMainFrame: true, url: 'http://127.0.0.1:5555/' } }), false, 'classic OBS page as a top frame');
  assert.equal(attach({ webContentsId: 8 }), false, 'foreign webContents');
  assert.equal(attach({ webContentsId: undefined }), false, 'no webContents');
  assert.equal(attach({ isInternalApiUrl: false }), false, 'not the internal API');
  for (const url of [
    'file:///C:/Program%20Files/%E5%97%B7%E5%91%9C%E7%82%B9%E6%AD%8C%E6%9C%BA/resources/app.asar/dist/other.html',
    'file:///C:/Users/admin/Downloads/index.html',
    'file:///C:/Program%20Files/%E5%97%B7%E5%91%9C%E7%82%B9%E6%AD%8C%E6%9C%BA/resources/app.asar/dist%2Findex.html',
    'file://evil-host/share/dist/index.html',
    'data:text/html,<p>x</p>',
    'about:blank',
    'chrome-error://chromewebdata/',
    '',
    'not a url'
  ]) {
    assert.equal(attach({ frame: { isMainFrame: true, url } }), false, url);
  }
  // Without a dev server only the packaged files are trusted.
  assert.equal(attach({ frame: { isMainFrame: true, url: 'http://localhost:5173/?admin=true' } }), false);
  assert.equal(attach({ isAppRendererUrl: devRenderer, frame: { isMainFrame: true, url: 'http://127.0.0.1:5173/' } }), false, 'different dev origin');
  assert.equal(attach({ isAppRendererUrl: devRenderer, frame: { isMainFrame: false, url: 'http://localhost:5173/' } }), false, 'dev sub-frame');
});

test('posix renderer paths match decoded file URLs exactly', () => {
  const posix = createAppRendererUrlMatcher({ rendererFiles: ['/opt/awoo/app/dist/index.html'], platform: 'linux' });
  assert.equal(posix('file:///opt/awoo/app/dist/index.html?admin=true'), true);
  assert.equal(posix('file:///opt/Awoo/app/dist/index.html'), false, 'case-sensitive outside Windows');
  // An opaque dev URL must never make every "null"-origin page trusted.
  const opaqueDev = createAppRendererUrlMatcher({ rendererFiles: [], devUrl: 'file:///opt/awoo/index.html', platform: 'linux' });
  assert.equal(opaqueDev('data:text/html,x'), false);
  assert.equal(opaqueDev('file:///tmp/x.html'), false);
});

test('the token header is compared exactly', () => {
  assert.equal(isValidInternalToken('secret-token', 'secret-token'), true);
  for (const value of [undefined, '', 'secret-toke', 'secret-tokenX', 'SECRET-TOKEN', ['secret-token']]) {
    assert.equal(isValidInternalToken(value, 'secret-token'), false, String(value));
  }
  assert.equal(isValidInternalToken('', ''), false, 'an empty expected token never matches');
});

test('Origin null needs the token; the preflight before it does not', () => {
  for (const method of ['GET', 'HEAD', 'POST', 'DELETE']) {
    for (const pathname of ['/data', '/api/config', '/api/bili/qrstatus', '/api/overlays/install-url']) {
      assert.equal(classify({ origin: 'null', method, pathname }), 'forbid-origin', `${method} ${pathname}`);
      assert.equal(classify({ origin: 'null', method, pathname, hasValidToken: true }), 'allow', `${method} ${pathname} with token`);
    }
  }
  // A preflight never carries custom headers and changes nothing; the packaged
  // renderer's JSON POST needs it, and the request after it is checked again.
  assert.equal(classify({ origin: 'null', method: 'OPTIONS', pathname: '/api/config' }), 'allow');
});

test('Mod UI code in the preview or OBS cannot reach control or sensitive routes', () => {
  // Sandboxed iframe: Origin null, no token (sub-frames never receive it).
  for (const [method, pathname] of [
    ['POST', '/api/config'], ['POST', '/api/update/apply'], ['POST', '/api/bili/logout'],
    ['POST', '/api/overlays/install-url'], ['POST', '/api/queue/action'], ['POST', '/api/feedback/submit'],
    ['GET', '/api/bili/qrstatus'], ['GET', '/api/logs'], ['GET', '/api/config'],
    ['GET', '/api/feedback/diagnostics'], ['GET', '/api/diagnostics'], ['GET', '/data']
  ]) {
    assert.equal(classify({ origin: 'null', method, pathname }), 'forbid-origin', `${method} ${pathname}`);
  }
});

test('other loopback pages may read public state but not control or sensitive routes', () => {
  const host = { origin: 'http://127.0.0.1:5556' };
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'PROPFIND']) {
    assert.equal(classify({ ...host, method, pathname: '/api/state/toggle' }), 'forbid-mutation', method);
  }
  assert.equal(classify({ ...host, method: 'post', pathname: '/api/config' }), 'forbid-mutation', 'method case');
  for (const pathname of [
    '/api/bili/qrstatus', '/api/logs', '/api/config', '/api/feedback/diagnostics', '/api/feedback/status',
    '/api/update/check', '/api/update/status', '/api/updates/announcements', '/api/debug/state',
    '/api/diagnostics', '/api/diagnostics/run'
  ]) {
    assert.equal(classify({ ...host, pathname }), 'forbid-sensitive-read', pathname);
    assert.equal(classify({ ...host, method: 'HEAD', pathname }), 'forbid-sensitive-read', `HEAD ${pathname}`);
    assert.equal(classify({ ...host, pathname, hasValidToken: true }), 'allow', `${pathname} with token`);
  }
  for (const pathname of ['/data', '/api/overlays', '/api/connectors/status', '/api/gifts/learning', '/api/test/request-song', '/']) {
    assert.equal(classify({ ...host, pathname }), 'allow', pathname);
  }
  assert.equal(classify({ ...host, method: 'OPTIONS', pathname: '/api/config' }), 'allow', 'preflight');
  assert.equal(classify({ origin: 'https://localhost:3000', method: 'POST', pathname: '/api/room' }), 'forbid-mutation');
});

test('the app itself, the dev server and token holders keep full access', () => {
  for (const [method, pathname] of [['POST', '/api/config'], ['GET', '/api/bili/qrstatus'], ['DELETE', '/api/room']]) {
    assert.equal(classify({ origin: 'http://127.0.0.1:5555', isSameAppOrigin: true, method, pathname }), 'allow');
    assert.equal(classify({ origin: 'http://localhost:5173', isSameAppOrigin: true, method, pathname }), 'allow');
    assert.equal(classify({ origin: 'http://localhost:5173', hasValidToken: true, method, pathname }), 'allow');
  }
});

test('requests without an Origin behave as before', () => {
  // Same-origin GETs from the classic OBS page and local tools such as curl.
  for (const method of ['GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS']) {
    for (const pathname of ['/data', '/api/config', '/api/bili/qrstatus', '/api/logs', '/api/test/request-song']) {
      assert.equal(classify({ method, pathname }), 'allow', `${method} ${pathname}`);
      assert.equal(classify({ origin: '', method, pathname }), 'allow', `empty Origin ${method} ${pathname}`);
    }
  }
  assert.equal(classify({ method: undefined }), 'allow');
});

test('Sec-Fetch-Site marks pages of another site or another local port', () => {
  for (const value of ['cross-site', 'same-site', 'Cross-Site', ' same-site ', 'same-origin, cross-site', ['cross-site']]) {
    assert.equal(isCrossSiteFetch(value), true, String(value));
  }
  for (const value of [undefined, '', 'same-origin', 'none', 'SAME-ORIGIN', 'cross-sites', [], ['same-origin']]) {
    assert.equal(isCrossSiteFetch(value), false, String(value));
  }
});

test('a page of another site or local port can change nothing, whatever Origin it sends', () => {
  for (const secFetchSite of ['cross-site', 'same-site']) {
    for (const method of ['POST', 'DELETE', 'PUT', 'PATCH']) {
      for (const pathname of ['/api/config', '/api/state/toggle', '/api/update/apply', '/api/room']) {
        // A form post or a beacon that arrives without an Origin header.
        assert.equal(classify({ method, pathname, secFetchSite }), 'forbid-mutation', `${secFetchSite} ${method} ${pathname}`);
        assert.equal(classify({ origin: '', method, pathname, secFetchSite }), 'forbid-mutation', `empty Origin ${method}`);
        assert.equal(classify({ origin: 'http://127.0.0.1:5556', method, pathname, secFetchSite }), 'forbid-mutation');
        assert.equal(classify({ origin: 'http://localhost:5173', isSameAppOrigin: true, method, pathname, secFetchSite }),
          'forbid-mutation', 'the dev server outside the app window has no token');
        assert.equal(classify({ origin: 'null', method, pathname, secFetchSite, hasValidToken: true }), 'allow', 'packaged renderer');
        assert.equal(classify({ origin: 'http://localhost:5173', method, pathname, secFetchSite, hasValidToken: true }), 'allow');
      }
    }
    // Reads and the preflight keep their current answers.
    assert.equal(classify({ pathname: '/data', secFetchSite }), 'allow');
    assert.equal(classify({ origin: 'http://127.0.0.1:5556', pathname: '/data', secFetchSite }), 'allow');
    assert.equal(classify({ origin: 'http://127.0.0.1:5556', pathname: '/api/config', secFetchSite }), 'forbid-sensitive-read');
    assert.equal(classify({ method: 'OPTIONS', pathname: '/api/config', secFetchSite }), 'allow');
    assert.equal(classify({ origin: 'null', method: 'POST', pathname: '/api/config', secFetchSite }), 'forbid-origin');
  }
  // The app's own pages, typed addresses and local tools are unaffected.
  for (const secFetchSite of [undefined, 'same-origin', 'none']) {
    assert.equal(classify({ method: 'POST', pathname: '/api/config', secFetchSite }), 'allow', String(secFetchSite));
    assert.equal(classify({ origin: 'http://127.0.0.1:5555', isSameAppOrigin: true, method: 'POST', pathname: '/api/config', secFetchSite }), 'allow');
  }
  // The skin marketplace is checked separately and keeps its one-click install.
  assert.equal(classify({
    origin: 'https://awoo-skins.enkianss.us', isTrustedSkinMarketplace: true, method: 'POST',
    pathname: '/api/skin-marketplace/install', secFetchSite: 'cross-site'
  }), 'allow');
});

test('only the app windows, its own pages and local tools may start network checks', () => {
  const facts = overrides => ({ origin: undefined, hasValidToken: false, isSameAppOrigin: false, ...overrides });
  // curl and other local tools send neither Origin nor Sec-Fetch-Site.
  assert.equal(mayTriggerNetworkWork(facts()), true, 'local tool');
  assert.equal(mayTriggerNetworkWork(facts({ secFetchSite: 'same-origin' })), true, 'same-origin GET of the app page');
  assert.equal(mayTriggerNetworkWork(facts({ secFetchSite: 'none' })), true, 'typed address');
  assert.equal(mayTriggerNetworkWork(facts({ origin: 'http://127.0.0.1:5555', isSameAppOrigin: true, secFetchSite: 'same-origin' })), true);
  for (const secFetchSite of ['cross-site', 'same-site']) {
    // An <img> loop in a website or a Mod UI frame: no Origin, no token.
    assert.equal(mayTriggerNetworkWork(facts({ secFetchSite })), false, secFetchSite);
    assert.equal(mayTriggerNetworkWork(facts({ origin: 'http://localhost:5173', isSameAppOrigin: true, secFetchSite })), false);
    assert.equal(mayTriggerNetworkWork(facts({ origin: 'null', secFetchSite, hasValidToken: true })), true, 'app window');
  }
  // Other local pages that read the API, e.g. the OBS overlay host.
  assert.equal(mayTriggerNetworkWork(facts({ origin: 'http://127.0.0.1:5556' })), false);
  assert.equal(mayTriggerNetworkWork(facts({ origin: 'null' })), false);
  assert.equal(mayTriggerNetworkWork(facts({ origin: 'http://127.0.0.1:5556', hasValidToken: true })), true);
});

test('non-loopback origins are refused unless they are the trusted skin marketplace', () => {
  for (const origin of [
    'https://evil.example', 'http://192.168.1.10:5555', 'http://[::1]:3000', 'https://awoo-skins.enkianss.us',
    'chrome-extension://abcdef', 'file://', 'NULL', 'http://127.0.0.1.evil.example'
  ]) {
    for (const method of ['GET', 'POST', 'OPTIONS']) {
      assert.equal(classify({ origin, method }), 'forbid-origin', `${method} ${origin}`);
      assert.equal(classify({ origin, method, hasValidToken: true }), 'forbid-origin', `${method} ${origin} with token`);
    }
  }
  for (const method of ['GET', 'POST', 'OPTIONS']) {
    assert.equal(classify({
      origin: 'https://awoo-skins.enkianss.us',
      isTrustedSkinMarketplace: true,
      method,
      pathname: '/api/skin-marketplace/install'
    }), 'allow', method);
  }
});

test('origin helpers identify loopback and same-app origins', () => {
  assert.equal(isLoopbackOrigin('http://127.0.0.1:5556'), true);
  assert.equal(isLoopbackOrigin('https://localhost'), true);
  assert.equal(isLoopbackOrigin('http://LOCALHOST:8080'), true);
  for (const origin of ['null', 'http://[::1]:5556', 'ws://127.0.0.1:5556', 'http://127.0.0.2', 'garbage']) {
    assert.equal(isLoopbackOrigin(origin), false, origin);
  }
  const app = { internalApiPort: 5555, devUrl: 'http://localhost:5173/' };
  assert.equal(isSameAppOrigin('http://127.0.0.1:5555', app), true);
  assert.equal(isSameAppOrigin('http://localhost:5555', app), true);
  assert.equal(isSameAppOrigin('http://localhost:5173', app), true);
  for (const origin of [undefined, '', 'null', 'https://127.0.0.1:5555', 'http://127.0.0.1:5556', 'http://127.0.0.1:5173', 'http://127.0.0.1']) {
    assert.equal(isSameAppOrigin(origin, app), false, String(origin));
  }
  assert.equal(isSameAppOrigin('http://127.0.0.1:5555', { internalApiPort: null }), false, 'not listening');
  assert.equal(isSameAppOrigin('http://127.0.0.1:80', { internalApiPort: 80 }), true, 'default port');
  assert.equal(isSameAppOrigin('null', { internalApiPort: 5555, devUrl: 'file:///C:/app/index.html' }), false);
});

test('sensitive prefixes cover login, logs, settings, feedback, updates, debug and diagnostics', () => {
  assert.deepEqual([...SENSITIVE_INTERNAL_GET_PREFIXES], [
    '/api/bili/', '/api/logs', '/api/config', '/api/feedback/', '/api/update', '/api/updates/', '/api/debug', '/api/diagnostics'
  ]);
  assert.equal(isSensitiveInternalPath('/api/bili/qrstatus'), true);
  assert.equal(isSensitiveInternalPath('/data'), false);
  assert.equal(isSensitiveInternalPath('/api/overlays'), false);
});

test('main wires the token, Host gate and access decision into the internal router', () => {
  const main = readSource('electron/main.ts');
  const hook = sliceBetween(main, 'function attachInternalApiTokenToAppSession', '\n}\n');
  assert.match(hook, /details\.webContentsId/);
  assert.match(hook, /details\.frame/);
  assert.match(hook, /shouldAttachInternalToken\(/);
  assert.doesNotMatch(hook, /requestHeaders\['X-Awoo-Internal-Token'\] =\s*INTERNAL_API_BROWSER_TOKEN;\s*\}\s*callback/,
    'the token is no longer added to every request for the internal origin');
  assert.match(main, /function trustRendererWindow\(/);
  assert.match(sliceBetween(main, 'function createOverlayWindow', 'function createAdminWindow'), /trustRendererWindow\(overlayWindow\)/);
  assert.match(sliceBetween(main, 'function createAdminWindow', 'function getInternalApiOrigin'), /trustRendererWindow\(adminWindow\)/);

  const router = sliceBetween(main, 'async function startBackendServer', "if (url.pathname === '/api/diagnostics'");
  const hostCheck = router.indexOf('isLoopbackHostHeader(req.headers.host');
  const decision = router.indexOf('classifyInternalRequest(');
  assert.ok(hostCheck !== -1 && decision !== -1 && hostCheck < decision, 'Host is checked before anything else');
  assert.match(router, /'Invalid host'/);
  assert.match(router, /'Forbidden origin'/);
  assert.match(router, /Mod UI 只能读取状态，不能调用点歌机控制接口/);
  assert.match(router, /forbid-sensitive-read/);
  assert.doesNotMatch(main, /function isAllowedInternalOrigin/);

  const announcements = sliceBetween(main, "url.pathname === '/api/updates/announcements'", "url.pathname === '/api/updates/ack'");
  assert.match(announcements, /searchParams\.get\('refresh'\) === '1' && hasValidToken/);
});

test('network checks start only for callers that may trigger them', () => {
  const main = readSource('electron/main.ts');
  const router = sliceBetween(main, 'async function startBackendServer', "if (url.pathname === '/api/diagnostics'");
  assert.match(router, /const secFetchSite = req\.headers\['sec-fetch-site'\];/);
  assert.match(sliceBetween(router, 'classifyInternalRequest({', '});'), /secFetchSite/);
  const trigger = sliceBetween(router, 'mayTriggerNetworkWork({', '});');
  for (const fact of ['origin', 'hasValidToken', 'isSameAppOrigin: fromSameApp', 'secFetchSite']) {
    assert.ok(trigger.includes(fact), fact);
  }

  // Other callers read the cached connector catalog ...
  const status = sliceBetween(main, "url.pathname === '/api/connectors/status'", "url.pathname === '/api/feedback/diagnostics'");
  assert.match(status, /const forceRefresh = url\.searchParams\.get\('refresh'\) === '1' && mayStartNetworkCheck;/);
  // ... and are refused the update and feedback checks, before any network work.
  for (const [start, end, call] of [
    ["url.pathname === '/api/update/check'", "url.pathname === '/api/update/status'", 'getAppUpdater().check()'],
    ["url.pathname === '/api/feedback/status'", "url.pathname === '/api/feedback/submit'", 'getFeedbackStatus(publicId)']
  ]) {
    const route = sliceBetween(main, start, end);
    const gate = route.indexOf('if (!mayStartNetworkCheck) {');
    assert.ok(gate > 0 && gate < route.indexOf(call), start);
    assert.match(route.slice(gate), /^if \(!mayStartNetworkCheck\) \{\s*res\.writeHead\(403\);/);
  }
});

test('loadWindow and the trusted renderer files stay in sync', () => {
  const main = readSource('electron/main.ts');
  const loadWindow = sliceBetween(main, 'function loadWindow', '\n}\n');
  assert.match(loadWindow, /loadFile\(RENDERER_INDEX_FILE,/);
  assert.match(loadWindow, /loadFile\(RENDERER_FALLBACK_INDEX_FILE,/);
  assert.match(main, /rendererFiles: \[RENDERER_INDEX_FILE, RENDERER_FALLBACK_INDEX_FILE\]/);
});
