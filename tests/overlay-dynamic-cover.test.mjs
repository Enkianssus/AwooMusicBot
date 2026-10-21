import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.resolve(import.meta.dirname, '../examples/obs-overlay/app.js'), 'utf8');
const coverUrl = 'https://p1.music.126.net/test/cover.jpg';
const dynamicCoverUrl = 'https://video-ssl.itunes.apple.com/cover.m3u8';

function overlayHarness({ nativeHls = false, hlsSupported = true, videoSupported = true, playRejects = false, hlsPreloaded = true } = {}) {
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  const elements = new Map();
  const sockets = [];
  const instances = [];
  const windowHandlers = {};
  const scripts = [];
  class Element {
    constructor() {
      this.children = [];
      this.dataset = {};
      this.hidden = true;
      this.srcWrites = 0;
      this.attributes = {};
    }
    set src(value) { this.attributes.src = value; this.srcWrites += 1; }
    get src() { return this.attributes.src || ''; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
  }
  class Video extends Element {
    constructor() {
      super();
      this.listeners = new Map();
      this.playCalls = 0;
      this.pauseCalls = 0;
      this.loadCalls = 0;
      this.readyState = 4;
    }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    removeEventListener(name, callback) {
      if (this.listeners.get(name) === callback) this.listeners.delete(name);
    }
    emit(name) { this.listeners.get(name)?.(); }
    play() {
      this.playCalls += 1;
      return playRejects ? Promise.reject(new Error('autoplay unavailable')) : Promise.resolve();
    }
    pause() { this.pauseCalls += 1; }
    load() { this.loadCalls += 1; }
    canPlayType() { return nativeHls ? 'probably' : ''; }
  }
  class Hls {
    static Events = { ERROR: 'error', MEDIA_ATTACHED: 'mediaAttached' };
    static isSupported() { return hlsSupported; }
    constructor(options) { this.options = options; this.handlers = {}; this.destroyed = false; instances.push(this); }
    on(name, callback) { this.handlers[name] = callback; }
    attachMedia(video) { this.video = video; this.handlers.mediaAttached?.(); }
    loadSource(url) { this.url = url; }
    destroy() { this.destroyed = true; }
    error(fatal) { this.handlers.error?.('error', { fatal }); }
  }
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor() { this.handlers = {}; this.readyState = 0; sockets.push(this); }
    addEventListener(name, handler) { this.handlers[name] = handler; }
  }
  const video = videoSupported ? new Video() : new Element();
  elements.set('current-cover-video', video);
  function element(id) {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  }
  // Only the overlay's injected <script> tags are appended to the head.
  const head = new Element();
  head.appendChild = child => { scripts.push(child); return child; };
  const windowObject = {
    Hls: hlsPreloaded ? Hls : undefined,
    location: { search: '', port: '5556', href: 'http://127.0.0.1:5556/overlay/' },
    addEventListener(name, handler) { windowHandlers[name] = handler; },
    setInterval: () => ++timerId,
    clearInterval() {},
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id)
  };
  vm.runInNewContext(source, {
    URL, URLSearchParams, Date, WebSocket: Socket,
    document: { getElementById: element, createElement: tagName => Object.assign(new Element(), { tagName }), head },
    fetch: () => new Promise(() => {}),
    window: windowObject
  });
  return {
    video, element, instances, scripts,
    finishHlsScript(loaded) {
      if (loaded) windowObject.Hls = Hls;
      scripts[0][loaded ? 'onload' : 'onerror']();
    },
    snapshot(current, overrides = {}) {
      sockets[0].handlers.message({ data: JSON.stringify({ type: 'state', data: {
        current, queue: [], accepting: true, playing: true, player: { connected: true }, ...overrides
      } }) });
    },
    settings(artworkSource) { windowHandlers['awoo-overlay-settings']({ detail: { values: { artworkSource } } }); },
    close() { windowHandlers.pagehide(); },
    advance(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of [...timers.entries()]) {
        if (timer.at <= now) { timers.delete(id); timer.callback(); }
      }
    }
  };
}

function song(overrides = {}) {
  return { id: '3345950115', title: 'Song', artist: 'Artist', coverUrl, dynamicCoverUrl, ...overrides };
}

test('HLS keeps the static cover until playable and repeated broadcasts preserve playback', async () => {
  const ui = overlayHarness();
  ui.snapshot(song({ dynamicCoverUrl: '' }));
  assert.equal(ui.instances.length, 0);
  assert.equal(ui.element('current-cover').hidden, false);
  ui.snapshot(song());
  assert.equal(ui.instances.length, 1);
  assert.equal(ui.instances[0].url, dynamicCoverUrl);
  assert.equal(ui.instances[0].options.enableWorker, false);
  assert.equal(ui.instances[0].options.capLevelToPlayerSize, true);
  assert.equal(ui.instances[0].options.startLevel, 0);
  assert.equal(ui.element('current-cover').src, coverUrl);
  assert.equal(ui.element('current-cover').hidden, false);
  assert.equal(ui.video.hidden, true);
  ui.video.emit('canplay');
  await Promise.resolve();
  assert.equal(ui.video.hidden, false);
  assert.equal(ui.video.muted, true);
  assert.equal(ui.video.loop, true);
  assert.equal(ui.video.playsInline, true);
  assert.equal(ui.element('current-cover-frame').dataset.dynamicCover, 'true');
  for (let index = 0; index < 20; index += 1) ui.snapshot(song());
  ui.video.emit('canplay');
  ui.advance(10_000);
  assert.equal(ui.instances.length, 1);
  assert.equal(ui.video.playCalls, 1);
  assert.equal(ui.element('current-cover').srcWrites, 1);
  assert.equal(ui.video.hidden, false, 'the readiness timeout is cancelled after playback begins');
});

test('track changes, disabled covers and page exit destroy the previous session', async () => {
  const ui = overlayHarness();
  ui.snapshot(song());
  const oldReady = ui.video.listeners.get('canplay');
  ui.snapshot(song({ id: 'second' }));
  assert.equal(ui.instances[0].destroyed, true);
  assert.equal(ui.instances.length, 2);
  oldReady();
  await Promise.resolve();
  assert.equal(ui.video.hidden, true, 'a prior track callback cannot reveal the new video');
  ui.video.emit('canplay');
  await Promise.resolve();
  // Turning the global setting off clears dynamicCoverUrl in the next snapshot.
  ui.snapshot(song({ id: 'second', dynamicCoverUrl: '' }));
  assert.equal(ui.instances[1].destroyed, true);
  assert.equal(ui.video.hidden, true, 'clearing the URL when the global setting changes stops playback');
  assert.equal(ui.video.src, '');
  assert.equal(ui.video.listeners.size, 0);
  assert.equal(ui.element('current-cover').src, coverUrl);
  ui.snapshot(song({ id: 'second' }));
  ui.snapshot(song({ id: 'second' }), { dynamicCoverEnabled: false });
  assert.equal(ui.instances[2].destroyed, false, 'the never-emitted dynamicCoverEnabled field is ignored');
  ui.close();
  assert.equal(ui.instances[2].destroyed, true);
  assert.equal(ui.video.hidden, true);
});

test('hls.js is injected once, only after the first HLS motion cover arrives', () => {
  const ui = overlayHarness({ hlsPreloaded: false });
  ui.snapshot(song({ dynamicCoverUrl: '' }));
  assert.equal(ui.scripts.length, 0, 'static covers never load hls.js');
  ui.snapshot(song({ id: 'mp4', dynamicCoverUrl: 'https://video-ssl.itunes.apple.com/cover.mp4' }));
  assert.equal(ui.scripts.length, 0, 'MP4 motion covers play without hls.js');
  ui.snapshot(song());
  ui.snapshot(song());
  assert.equal(ui.scripts.length, 1);
  assert.equal(ui.scripts[0].tagName, 'script');
  assert.equal(ui.scripts[0].src, '/overlay/vendor/hls.min.js');
  assert.equal(ui.instances.length, 0);
  assert.equal(ui.video.hidden, true);
  assert.equal(ui.element('current-cover').hidden, false, 'the static cover stays while hls.js loads');
  assert.equal(ui.element('current-cover').src, coverUrl);
  const nextUrl = 'https://video-ssl.itunes.apple.com/next.m3u8';
  ui.snapshot(song({ id: 'next', dynamicCoverUrl: nextUrl }));
  assert.equal(ui.scripts.length, 1, 'a track change while loading reuses the pending script');
  ui.finishHlsScript(true);
  assert.equal(ui.instances.length, 1, 'only the newest track starts once hls.js is ready');
  assert.equal(ui.instances[0].url, nextUrl);
  ui.snapshot(song({ id: 'third' }));
  assert.equal(ui.scripts.length, 1);
  assert.equal(ui.instances.length, 2);
  assert.equal(ui.instances[0].destroyed, true);
});

test('a failed hls.js load keeps the static cover and is never retried', () => {
  const ui = overlayHarness({ hlsPreloaded: false });
  ui.snapshot(song());
  ui.finishHlsScript(false);
  assert.equal(ui.instances.length, 0);
  assert.equal(ui.video.hidden, true);
  assert.equal(ui.video.listeners.size, 0);
  assert.equal(ui.element('current-cover').hidden, false);
  assert.equal(ui.element('current-cover').src, coverUrl);
  ui.snapshot(song());
  ui.snapshot(song({ id: 'next' }));
  assert.equal(ui.scripts.length, 1);
  assert.equal(ui.instances.length, 0);
  assert.equal(ui.video.listeners.size, 0);

  const native = overlayHarness({ hlsPreloaded: false, nativeHls: true });
  native.snapshot(song());
  native.finishHlsScript(false);
  assert.equal(native.video.src, dynamicCoverUrl, 'browsers with native HLS still get the motion cover');
});

test('media failure and a ten-second timeout fall back without retrying each broadcast', async () => {
  const fatal = overlayHarness();
  fatal.snapshot(song());
  fatal.instances[0].error(false);
  assert.equal(fatal.instances[0].destroyed, false);
  fatal.instances[0].error(true);
  fatal.snapshot(song());
  assert.equal(fatal.instances[0].destroyed, true);
  assert.equal(fatal.instances.length, 1);
  assert.equal(fatal.video.hidden, true);
  assert.equal(fatal.element('current-cover').hidden, false);

  const timeout = overlayHarness();
  timeout.snapshot(song());
  timeout.advance(9_999);
  assert.equal(timeout.instances[0].destroyed, false);
  timeout.advance(1);
  assert.equal(timeout.instances[0].destroyed, true);
  timeout.snapshot(song());
  assert.equal(timeout.instances.length, 1);

  const blocked = overlayHarness({ playRejects: true });
  blocked.snapshot(song());
  blocked.video.emit('canplay');
  await Promise.resolve();
  assert.equal(blocked.instances[0].destroyed, true);
  assert.equal(blocked.video.hidden, true);
});

test('native HLS and MP4 work without Hls.js and an error clears their source', async () => {
  for (const [nativeHls, url] of [[true, dynamicCoverUrl], [false, 'https://video-ssl.itunes.apple.com/cover.mp4']]) {
    const ui = overlayHarness({ nativeHls, hlsSupported: false });
    ui.snapshot({ Id: 'internal', SongName: 'Song', CoverUrl: coverUrl, DynamicCoverUrl: url });
    assert.equal(ui.instances.length, 0);
    assert.equal(ui.video.src, url);
    ui.video.emit('canplay');
    await Promise.resolve();
    assert.equal(ui.video.hidden, false);
    ui.video.emit('error');
    assert.equal(ui.video.hidden, true);
    assert.equal(ui.video.src, '');
    assert.equal(ui.element('current-cover').hidden, false);
  }
});

test('Hls.js is preferred when Chromium also advertises native HLS support', () => {
  const ui = overlayHarness({ nativeHls: true, hlsSupported: true });
  ui.snapshot(song());
  assert.equal(ui.instances.length, 1);
  assert.equal(ui.instances[0].url, dynamicCoverUrl);
  assert.equal(ui.video.src, '', 'the browser must not receive the HLS manifest as a native source');
  ui.close();
});

test('buffering after playback falls back after ten seconds without repeated retries', async () => {
  for (const event of ['waiting', 'stalled']) {
    const ui = overlayHarness();
    ui.snapshot(song());
    ui.video.emit('canplay');
    await Promise.resolve();
    ui.video.readyState = 2;
    ui.video.emit(event);
    ui.advance(9_999);
    assert.equal(ui.instances[0].destroyed, false);
    ui.video.emit(event);
    ui.advance(1);
    assert.equal(ui.instances[0].destroyed, true, 'repeated buffering events cannot extend the deadline');
    assert.equal(ui.video.hidden, true);
    assert.equal(ui.element('current-cover').hidden, false);
    assert.equal(ui.video.listeners.size, 0);
    ui.snapshot(song());
    assert.equal(ui.instances.length, 1);
  }
});

test('buffered download stalls stay visible and resumed playback cancels buffering timeout', async () => {
  const ui = overlayHarness();
  ui.snapshot(song());
  ui.video.emit('canplay');
  await Promise.resolve();
  ui.video.emit('stalled');
  ui.advance(10_000);
  assert.equal(ui.instances[0].destroyed, false, 'readyState with future frames does not mean playback is blocked');
  ui.video.emit('waiting');
  ui.advance(9_000);
  ui.video.emit('playing');
  ui.advance(10_000);
  assert.equal(ui.instances[0].destroyed, false);
  assert.equal(ui.video.hidden, false);
  const oldPlaying = ui.video.listeners.get('playing');
  const oldWaiting = ui.video.listeners.get('waiting');
  ui.snapshot(null);
  oldPlaying();
  oldWaiting();
  ui.advance(10_000);
  assert.equal(ui.video.hidden, true);
  assert.equal(ui.video.listeners.size, 0);
});

test('requester avatars and queues never start dynamic covers, and older DOMs stay usable', () => {
  const ui = overlayHarness();
  ui.settings('requester_avatar');
  ui.snapshot(song({ requestedByAvatar: 'https://example.com/avatar.jpg' }), { currentIsRequested: true, queue: [song()] });
  assert.equal(ui.instances.length, 0);
  assert.equal(ui.element('current-cover').src, 'https://example.com/avatar.jpg');
  ui.settings('album_cover');
  assert.equal(ui.instances.length, 1);
  ui.settings('requester_avatar');
  assert.equal(ui.instances[0].destroyed, true);
  ui.snapshot(null, { queue: [song()] });
  assert.equal(ui.instances.length, 1);
  ui.settings('album_cover');
  ui.snapshot(song({ dynamicCoverUrl: 'javascript:alert(1)' }));
  assert.equal(ui.instances.length, 1);
  const oldDom = overlayHarness({ videoSupported: false });
  assert.doesNotThrow(() => oldDom.snapshot(song()));
  assert.equal(oldDom.element('current-cover').src, coverUrl);
});

test('unsupported HLS remains a static image', () => {
  const ui = overlayHarness({ hlsSupported: false });
  ui.snapshot(song());
  assert.equal(ui.instances.length, 0);
  assert.equal(ui.video.hidden, true);
  assert.equal(ui.element('current-cover').hidden, false);
});
