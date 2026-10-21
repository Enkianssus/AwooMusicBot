import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import {
  createCrashLoopGuard,
  describeUrlForLog,
  isAllowedExternalUrl,
  isAppNavigationUrl
} from '../electron/web-contents-policy.ts';
import {
  isAllowedSkinMarketplaceOrigin,
  SKIN_MARKETPLACE_URL
} from '../electron/skin-marketplace-policy.ts';
import { releaseNotesLocation } from '../electron/update-announcements.ts';
import { extractFunctions, readSource, sliceBetween } from './helpers/source.mjs';

const external = { isMarketplaceOrigin: isAllowedSkinMarketplaceOrigin };
const WINDOWS_INDEX = 'C:\\Program Files\\嗷呜点歌机\\resources\\app.asar\\dist\\index.html';
const WINDOWS_FALLBACK = 'C:\\Program Files\\嗷呜点歌机\\resources\\app.asar\\renderer\\index.html';
const packaged = { rendererFiles: [WINDOWS_INDEX, WINDOWS_FALLBACK], platform: 'win32' };
const PACKAGED_URL = 'file:///C:/Program%20Files/%E5%97%B7%E5%91%9C%E7%82%B9%E6%AD%8C%E6%9C%BA/resources/app.asar/dist/index.html';

const transpile = source => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 }
}).outputText;
const settle = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('only https pages of the project open in the system browser', () => {
  for (const url of [
    releaseNotesLocation('core', '1.2.6').notesUrl,
    releaseNotesLocation('qqmusic', '22.52.1').notesUrl,
    'https://github.com/Enkianssus/AwooMusicBot-Overlay-Default',
    'https://github.com/Enkianssus',
    'https://github.com/enkianssus/AwooMusicBot',
    'https://github.com:443/Enkianssus/AwooMusicBot',
    'https://app.enkianss.us/feedback',
    'https://app.enkianss.us/feedback?id=AW-20261021-ABCD',
    SKIN_MARKETPLACE_URL
  ]) {
    assert.equal(isAllowedExternalUrl(url, external), true, url);
  }
  for (const url of [
    'http://github.com/Enkianssus/AwooMusicBot',
    'http://app.enkianss.us/feedback',
    'https://github.com/other-org/AwooMusicBot',
    'https://github.com/EnkianssusFake/AwooMusicBot',
    'https://github.com/',
    'https://github.com/Enkianssus/../other-org/repo',
    'https://gist.github.com/Enkianssus/abc',
    'https://www.github.com/Enkianssus/AwooMusicBot',
    'https://github.com.evil.example/Enkianssus/AwooMusicBot',
    'https://evil.example/https://github.com/Enkianssus/',
    'https://app.enkianss.us.evil.example/feedback',
    'https://user:secret@app.enkianss.us/feedback',
    'https://app.enkianss.us:8443/feedback',
    'http://127.0.0.1:5178/',
    'http://localhost:5555/',
    'javascript:alert(1)',
    'file:///C:/Windows/System32/notepad.exe',
    'data:text/html,<script>alert(1)</script>',
    'about:blank',
    'not a url',
    ''
  ]) {
    assert.equal(isAllowedExternalUrl(url, external), false, url);
  }
  assert.equal(isAllowedExternalUrl(SKIN_MARKETPLACE_URL), false, 'the marketplace needs its origin policy');
});

test('every link the renderer opens in a new window is allowed or deliberately blocked', () => {
  const hrefs = ['src/App.tsx', 'src/UpdateAnnouncements.tsx']
    .flatMap(file => [...readSource(file).matchAll(/href="(https?:[^"]+)"[^>]*target="_blank"/g)].map(match => match[1]));
  assert.ok(hrefs.length >= 2, 'the static links were found');
  for (const href of hrefs) assert.equal(isAllowedExternalUrl(href, external), true, href);
  // Dynamic targets: release notes, the feedback tracking page and the marketplace fallback.
  const app = readSource('src/App.tsx');
  assert.match(app, /href=\{item\.trackingUrl\} target="_blank"/);
  assert.match(app, /window\.open\(SKIN_MARKETPLACE_URL, '_blank'/);
  assert.match(readSource('src/UpdateAnnouncements.tsx'), /href=\{item\.notesUrl\} target="_blank"/);
});

test('only the app renderer and, in development, the dev server are navigation targets', () => {
  for (const url of [
    `${PACKAGED_URL}?mode=electron`,
    `${PACKAGED_URL}?admin=true&tab=updates`,
    `${PACKAGED_URL}#queue`,
    pathToFileURL(WINDOWS_INDEX, { windows: true }).href,
    'file:///c:/PROGRAM FILES/嗷呜点歌机/resources/app.asar/dist/index.html?admin=true',
    'file:///C:/Program%20Files/%E5%97%B7%E5%91%9C%E7%82%B9%E6%AD%8C%E6%9C%BA/resources/app.asar/renderer/index.html?mode=electron'
  ]) {
    assert.equal(isAppNavigationUrl(url, packaged), true, url);
  }
  for (const url of [
    'file:///C:/Program%20Files/%E5%97%B7%E5%91%9C%E7%82%B9%E6%AD%8C%E6%9C%BA/resources/app.asar/dist/other.html',
    'file:///C:/Users/admin/Downloads/awoo-overlay.zip',
    'file:///C:/Users/admin/Downloads/index.html',
    'http://127.0.0.1:5555/',
    'http://127.0.0.1:5556/overlay/?preview=1',
    'http://localhost:5173/?mode=electron',
    'https://github.com/Enkianssus/AwooMusicBot',
    'https://app.enkianss.us/feedback',
    'about:blank',
    'javascript:location.reload()',
    'devtools://devtools/bundled/devtools_app.html',
    'not a url'
  ]) {
    assert.equal(isAppNavigationUrl(url, packaged), false, url);
  }
  const dev = { ...packaged, devUrl: 'http://localhost:5173/' };
  assert.equal(isAppNavigationUrl('http://localhost:5173/?mode=electron', dev), true);
  assert.equal(isAppNavigationUrl('http://localhost:5173/?admin=true&tab=appearance', dev), true);
  assert.equal(isAppNavigationUrl('http://localhost:5173/src/main.tsx', dev), true, 'a dev server reload');
  assert.equal(isAppNavigationUrl('http://localhost:5174/', dev), false);
  assert.equal(isAppNavigationUrl('http://127.0.0.1:5173/', dev), false);
  assert.equal(isAppNavigationUrl(`${PACKAGED_URL}?mode=electron`, dev), true);
});

test('the crash guard reloads three times, then rebuilds and starts counting afresh', () => {
  const guard = createCrashLoopGuard();
  assert.deepEqual([0, 1_000, 2_000, 3_000].map(now => guard.record(now)),
    ['reload', 'reload', 'reload', 'recreate']);
  assert.deepEqual([4_000, 5_000, 6_000, 7_000].map(now => guard.record(now)),
    ['reload', 'reload', 'reload', 'recreate'], 'the rebuilt window gets its own reloads');

  const spaced = createCrashLoopGuard();
  assert.deepEqual([0, 30_000, 59_999, 60_000, 90_000].map(now => spaced.record(now)),
    ['reload', 'reload', 'reload', 'reload', 'reload'], 'crashes older than a minute no longer count');

  const strict = createCrashLoopGuard({ limit: 1, windowMs: 1_000 });
  assert.deepEqual([0, 10, 20, 2_000].map(now => strict.record(now)), ['reload', 'recreate', 'reload', 'reload']);

  const backwards = createCrashLoopGuard();
  assert.deepEqual([50_000, 50_001, 50_002].map(now => backwards.record(now)), ['reload', 'reload', 'reload']);
  assert.equal(backwards.record(10_000), 'reload', 'a clock moved backwards does not force a rebuild');
});

test('logged URLs keep only the scheme, host and path', () => {
  assert.equal(describeUrlForLog('https://app.enkianss.us/feedback?id=AW-1&token=secret#x'),
    'https://app.enkianss.us/feedback');
  assert.equal(describeUrlForLog('http://evil.example:8080/a/b?c=d'), 'http://evil.example:8080/a/b');
  assert.equal(describeUrlForLog('file:///C:/Users/张三/Downloads/mod.zip'), 'file:');
  assert.equal(describeUrlForLog('javascript:alert(document.cookie)'), 'javascript:');
  assert.equal(describeUrlForLog('not a url'), '无效地址');
  const long = describeUrlForLog(`https://evil.example/${'a'.repeat(400)}`);
  assert.equal(long.length, 201);
  assert.ok(long.endsWith('…'));
});

// ---------------------------------------------------------------------------
// The actual main.ts functions, run in a vm with inert dependencies. No
// Electron module, window or renderer process is involved.
// ---------------------------------------------------------------------------

const INDEX = path.resolve('awoo-app', 'dist', 'index.html');
const FALLBACK = path.resolve('awoo-app', 'renderer', 'index.html');
const hardenJs = transpile(extractFunctions('electron/main.ts', ['hardenWebContents']));

function hardenHarness({ type = 'window', devUrl, openFails = false } = {}) {
  const opened = [];
  const logs = [];
  const listeners = new Map();
  let openHandler = null;
  const context = vm.createContext({
    isAllowedExternalUrl, isAllowedSkinMarketplaceOrigin, describeUrlForLog, isAppNavigationUrl,
    RENDERER_INDEX_FILE: INDEX,
    RENDERER_FALLBACK_INDEX_FILE: FALLBACK,
    getDevUrl: () => devUrl,
    shell: {
      openExternal: async url => {
        opened.push(url);
        if (openFails) throw new Error('no browser');
      }
    },
    writeLog: (message, color) => logs.push({ message, color }),
    Error, String
  });
  vm.runInContext(hardenJs, context);
  context.hardenWebContents({
    getType: () => type,
    setWindowOpenHandler: handler => { openHandler = handler; },
    on: (event, listener) => { listeners.set(event, listener); }
  });
  return {
    opened, logs, listeners,
    open: url => openHandler({ url, frameName: '', features: '', disposition: 'foreground-tab' }),
    navigate(url) {
      let prevented = false;
      listeners.get('will-navigate')({ url, preventDefault: () => { prevented = true; } });
      return prevented;
    }
  };
}

test('every window open is denied in the app and project pages go to the system browser', async () => {
  const h = hardenHarness();
  const notes = releaseNotesLocation('core', '1.2.6').notesUrl;
  assert.deepEqual({ ...h.open(notes) }, { action: 'deny' });
  assert.deepEqual({ ...h.open('https://app.enkianss.us/feedback?id=AW-1') }, { action: 'deny' });
  assert.deepEqual({ ...h.open(SKIN_MARKETPLACE_URL) }, { action: 'deny' });
  assert.deepEqual(h.opened, [notes, 'https://app.enkianss.us/feedback?id=AW-1', SKIN_MARKETPLACE_URL]);
  assert.deepEqual(h.logs, []);

  for (const url of ['https://evil.example/login?next=1', 'http://github.com/Enkianssus/x', 'javascript:alert(1)']) {
    assert.deepEqual({ ...h.open(url) }, { action: 'deny' });
  }
  assert.equal(h.opened.length, 3, 'nothing else was opened');
  assert.deepEqual(h.logs.map(log => log.message), [
    '[窗口] 已阻止打开链接：https://evil.example/login',
    '[窗口] 已阻止打开链接：http://github.com/Enkianssus/x',
    '[窗口] 已阻止打开链接：javascript:'
  ]);

  const failing = hardenHarness({ openFails: true });
  failing.open(notes);
  await settle();
  assert.match(failing.logs[0].message, /^\[窗口\] 无法用系统浏览器打开 https:\/\/github\.com\/Enkianssus\/AwooMusicBot\/releases\/tag\/v1\.2\.6：no browser$/);
});

test('top-level navigations stay on the app renderer, dev server reloads included', () => {
  const h = hardenHarness();
  const renderer = pathToFileURL(INDEX).href;
  assert.equal(h.navigate(`${renderer}?mode=electron`), false);
  assert.equal(h.navigate(`${pathToFileURL(FALLBACK).href}?admin=true&tab=updates`), false);
  assert.deepEqual(h.logs, []);
  assert.equal(h.navigate('https://github.com/Enkianssus/AwooMusicBot'), true, 'even a project page is not loaded in place');
  assert.equal(h.navigate(pathToFileURL(path.resolve('Downloads', 'skin.zip')).href), true, 'a dropped file');
  assert.equal(h.navigate('http://localhost:5173/?mode=electron'), true, 'no dev server in production');
  assert.deepEqual(h.logs.map(log => log.message), [
    '[窗口] 已阻止页面跳转：https://github.com/Enkianssus/AwooMusicBot',
    '[窗口] 已阻止页面跳转：file:',
    '[窗口] 已阻止页面跳转：http://localhost:5173/'
  ]);

  const dev = hardenHarness({ devUrl: 'http://localhost:5173/' });
  assert.equal(dev.navigate('http://localhost:5173/?mode=electron'), false);
  assert.equal(dev.navigate('http://localhost:5173/?admin=true'), false);

  const devtools = hardenHarness({ type: 'remote' });
  assert.equal(devtools.listeners.has('will-navigate'), false, 'DevTools keeps its own navigation');
  assert.deepEqual({ ...devtools.open('https://evil.example/') }, { action: 'deny' });
});

const healthJs = transpile(extractFunctions('electron/main.ts', ['watchRendererHealth', 'recreateAppWindow']));

function healthHarness() {
  const timers = [];
  const logs = [];
  const prompts = [];
  const events = [];
  let created = 0;
  let context;
  const makeWindow = (kind, url = `file:///C:/awoo/dist/index.html?${kind === 'admin' ? 'admin=true' : 'mode=electron'}`) => {
    const name = `${kind}#${++created}`;
    const listeners = new Map();
    const contents = {
      url,
      destroyed: false,
      on(event, listener) {
        listeners.set(event, [...(listeners.get(event) || []), listener]);
        return this;
      },
      emit(event, ...args) {
        for (const listener of listeners.get(event) || []) listener(...args);
      },
      isDestroyed() { return this.destroyed; },
      getURL() { return this.url; },
      reload() { events.push(['reload', name]); },
      forcefullyCrashRenderer() { events.push(['kill', name]); }
    };
    return {
      name,
      webContents: contents,
      destroyed: false,
      isDestroyed() { return this.destroyed; },
      getBounds: () => ({ x: 1200, y: 80, width: 420, height: 600 }),
      setBounds(bounds) { events.push(['setBounds', name, bounds]); },
      destroy() {
        this.destroyed = true;
        contents.destroyed = true;
        events.push(['destroy', name]);
      }
    };
  };
  context = vm.createContext({
    APP_WINDOW_LABELS: { overlay: '点歌悬浮窗', admin: '控制面板' },
    rendererCrashGuards: { overlay: createCrashLoopGuard(), admin: createCrashLoopGuard() },
    RENDERER_RECOVERY_DELAY_MS: 1000,
    applicationQuitRequested: false,
    overlayWindow: null,
    adminWindow: null,
    AbortController,
    Date,
    setTimeout: (callback, ms) => { timers.push({ callback, ms }); return timers.length; },
    writeLog: (message, color) => logs.push({ message, color }),
    dialog: {
      showMessageBox(win, options) {
        const pending = deferred();
        options.signal?.addEventListener('abort', () => pending.resolve({ response: options.cancelId, checkboxChecked: false }));
        prompts.push({ win, options, answer: response => pending.resolve({ response, checkboxChecked: false }) });
        return pending.promise;
      }
    },
    createOverlayWindow() {
      const win = makeWindow('overlay');
      events.push(['create', win.name]);
      context.overlayWindow = win;
      context.watchRendererHealth(win, 'overlay');
    },
    createAdminWindow(tab) {
      // The real function would only present an existing panel.
      assert.equal(context.adminWindow, null, 'the crashed panel was released first');
      const win = makeWindow('admin');
      events.push(['create', win.name, tab]);
      context.adminWindow = win;
      context.watchRendererHealth(win, 'admin');
    }
  });
  vm.runInContext(healthJs, context);
  return {
    context, events, logs, prompts,
    open(kind) {
      if (kind === 'overlay') context.createOverlayWindow();
      else context.createAdminWindow();
      events.length = 0;
      return kind === 'overlay' ? context.overlayWindow : context.adminWindow;
    },
    crash(win, reason = 'crashed') {
      win.webContents.emit('render-process-gone', { preventDefault() {} }, { reason, exitCode: -1073741819 });
    },
    runTimers() {
      const due = timers.splice(0);
      for (const timer of due) {
        assert.equal(timer.ms, 1000);
        timer.callback();
      }
      return due.length;
    }
  };
}

test('a crashed overlay reloads three times, then is rebuilt before the old window closes', () => {
  const h = healthHarness();
  const first = h.open('overlay');
  for (let attempt = 0; attempt < 3; attempt++) {
    h.crash(first);
    assert.equal(h.runTimers(), 1);
  }
  assert.deepEqual(h.events, [['reload', 'overlay#1'], ['reload', 'overlay#1'], ['reload', 'overlay#1']]);
  assert.ok(h.logs.some(log => log.color === 'Red' && log.message.includes('点歌悬浮窗渲染进程已退出（crashed')));

  h.events.length = 0;
  h.crash(first);
  h.runTimers();
  assert.deepEqual(h.events, [
    ['create', 'overlay#2'],
    ['setBounds', 'overlay#2', { x: 1200, y: 80, width: 420, height: 600 }],
    ['destroy', 'overlay#1']
  ], 'the replacement exists before the crashed window closes, at the same place');
  const second = h.context.overlayWindow;
  assert.equal(second.name, 'overlay#2');

  // The rebuilt window starts with a fresh allowance, and the old one is inert.
  h.events.length = 0;
  h.crash(second);
  h.runTimers();
  assert.deepEqual(h.events, [['reload', 'overlay#2']]);
  h.context.recreateAppWindow(first, 'overlay');
  assert.equal(h.context.overlayWindow, second);
});

test('a crashed control panel is rebuilt through createAdminWindow', () => {
  const h = healthHarness();
  const panel = h.open('admin');
  for (let attempt = 0; attempt < 4; attempt++) {
    h.crash(panel, 'oom');
    h.runTimers();
  }
  assert.deepEqual(h.events, [
    ['reload', 'admin#1'], ['reload', 'admin#1'], ['reload', 'admin#1'],
    ['create', 'admin#2', undefined], ['destroy', 'admin#1']
  ]);
  assert.equal(h.context.adminWindow.name, 'admin#2');
});

test('clean exits, quitting and lost first loads are handled without a blind reload', () => {
  const h = healthHarness();
  const overlay = h.open('overlay');
  h.crash(overlay, 'clean-exit');
  assert.equal(h.runTimers(), 0);
  assert.equal(h.logs.at(-1).color, 'DarkGray');

  h.crash(overlay);
  h.context.applicationQuitRequested = true;
  h.runTimers();
  h.crash(overlay);
  assert.equal(h.runTimers(), 0);
  assert.deepEqual(h.events, [], 'nothing happens while the app quits');

  const fresh = healthHarness();
  const unloaded = fresh.open('overlay');
  unloaded.webContents.url = '';
  fresh.crash(unloaded, 'launch-failed');
  fresh.runTimers();
  assert.deepEqual(fresh.events.map(event => event.slice(0, 2)), [
    ['create', 'overlay#2'], ['setBounds', 'overlay#2'], ['destroy', 'overlay#1']
  ], 'a page that never committed is loaded again in a new window');
});

test('an unresponsive window offers one reload prompt that closes itself on recovery', async () => {
  const h = healthHarness();
  const panel = h.open('admin');
  panel.webContents.emit('unresponsive');
  panel.webContents.emit('unresponsive');
  assert.equal(h.prompts.length, 1, 'one prompt at a time');
  const [first] = h.prompts;
  assert.equal(first.win, panel);
  assert.deepEqual([...first.options.buttons], ['重新加载', '继续等待']);
  assert.equal(first.options.cancelId, 1);
  assert.equal(first.options.message, '控制面板暂时没有响应');

  panel.webContents.emit('responsive');
  assert.equal(first.options.signal.aborted, true);
  await settle();
  assert.deepEqual(h.events, [], 'a recovered window is left alone');

  panel.webContents.emit('unresponsive');
  assert.equal(h.prompts.length, 2);
  h.prompts[1].answer(0);
  await settle();
  assert.deepEqual(h.events, [['kill', 'admin#1']], 'the hung renderer is ended');
  h.crash(panel, 'killed');
  h.runTimers();
  assert.deepEqual(h.events, [['kill', 'admin#1'], ['reload', 'admin#1']], 'and reloaded by crash recovery');
});

test('main hardens every web contents and watches both windows', () => {
  const main = readSource('electron/main.ts');
  assert.match(main, /app\.on\('web-contents-created', \(_event, contents\) => hardenWebContents\(contents\)\);/);
  assert.match(main, /overlay: createCrashLoopGuard\(\),\s*admin: createCrashLoopGuard\(\)/);
  const overlay = sliceBetween(main, 'function createOverlayWindow', 'function createAdminWindow');
  assert.match(overlay, /trustRendererWindow\(overlayWindow\);\s*watchRendererHealth\(overlayWindow, 'overlay'\);/);
  assert.match(overlay, /if \(overlayWindow !== initialWindow\) return;\s*overlayWindow = null;\s*requestApplicationQuit\(\);/);
  const admin = sliceBetween(main, 'function createAdminWindow', 'function getInternalApiOrigin');
  assert.match(admin, /trustRendererWindow\(adminWindow\);\s*watchRendererHealth\(adminWindow, 'admin'\);/);
  assert.match(admin, /if \(adminWindow !== closingWindow\) return;\s*setAdminWindowTopmost\(false\);\s*adminWindow = null;/);
  const focus = sliceBetween(main, 'function focusExistingWindow', '\n}\n');
  assert.match(focus, /webContents\.isCrashed\(\)\) win\.webContents\.reload\(\)/);
  assert.ok(focus.indexOf('isCrashed()') < focus.indexOf('presentAdminWindow()'), 'reload before presenting');
});
