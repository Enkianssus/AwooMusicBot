import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const appSource = fs.readFileSync(
  path.join(root, 'examples', 'obs-overlay', 'app.js'),
  'utf8'
);

function overlayHarness(search = '') {
  const elements = new Map();
  const windowHandlers = {};
  const sockets = [];
  class Element {
    constructor() {
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.textContent = '';
      this.hidden = false;
      this.rebuilds = 0;
      this.srcWrites = 0;
    }
    set src(value) { this.attributes.src = value; this.srcWrites += 1; }
    get src() { return this.attributes.src || ''; }
    append(...children) { this.children.push(...children); }
    insertBefore(child) { this.children.push(child); }
    replaceChildren(...children) { this.rebuilds += 1; this.children = children; }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
  }
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor() { this.handlers = {}; this.readyState = 0; sockets.push(this); }
    addEventListener(name, handler) { this.handlers[name] = handler; }
  }
  function element(id) {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  }
  vm.runInNewContext(appSource, {
    URL, URLSearchParams, Date, WebSocket: Socket,
    document: { getElementById: element, createElement: () => new Element() },
    fetch: () => new Promise(() => {}),
    window: {
      location: { search, port: '5556', href: `http://127.0.0.1:5556/overlay/${search}` },
      addEventListener(name, handler) { windowHandlers[name] = handler; },
      setInterval: () => 0,
      clearInterval() {},
      setTimeout: () => 0,
      clearTimeout() {}
    }
  });
  return {
    element,
    snapshot(data) {
      sockets[0].handlers.message({ data: JSON.stringify({ type: 'state', data }) });
    },
    settings(values) {
      windowHandlers['awoo-overlay-settings']({ detail: { values } });
    }
  };
}

test('builtin Mod UI morphs avatars only when rotation is disabled', () => {
  const styleSource = fs.readFileSync(
    path.join(root, 'examples', 'obs-overlay', 'styles.css'),
    'utf8'
  );

  assert.match(appSource, /kind: 'requester_avatar', value: song\.requestedByAvatar/);
  assert.match(appSource, /kind: 'album_cover', value: song\.coverUrl/);
  assert.match(appSource, /currentCoverFrame\.dataset\.artworkKind = candidate\.kind/);
  assert.match(styleSource, /\.cover-frame\[data-artwork-kind="requester_avatar"\][\s\S]*border-radius: 50%/);
  assert.match(styleSource, /data-awoo-setting-cover-rotation="true"[\s\S]*animation: awoo-cover-spin/);
  assert.match(styleSource, /data-awoo-setting-cover-rotation="true"\]\s+\.cover-frame\s*\{[\s\S]{0,120}border-radius: 50%;[\s\S]{0,120}transition: none/);
  assert.doesNotMatch(styleSource, /data-awoo-setting-artwork-source="requester_avatar"[\s\S]{0,160}animation:\s*none/);
  assert.doesNotMatch(styleSource, /animation-play-state:\s*paused/);
});

test('repeated settings deliveries and unrelated broadcasts keep the queue rows', () => {
  const ui = overlayHarness();
  const queue = [1, 2, 3, 4].map(index => ({
    id: String(index), title: `Song ${index}`, artist: 'Artist', requestedBy: 'Viewer'
  }));
  const state = {
    current: { id: 'now', title: 'Now', artist: 'Artist', coverUrl: 'https://p1.music.126.net/now.jpg' },
    queue, accepting: true, playing: true, player: { connected: true }
  };
  ui.snapshot(state);
  const list = ui.element('queue-list');
  const cover = ui.element('current-cover');
  assert.equal(list.rebuilds, 1);
  assert.equal(list.children.length, 3);
  assert.equal(cover.srcWrites, 1);

  // The OBS host re-delivers unchanged settings on every poll.
  const settings = { maxQueue: 3, artworkSource: 'album_cover', coverRotation: false };
  ui.settings(settings);
  ui.settings({ ...settings });
  assert.equal(list.rebuilds, 1, 'identical settings must not rebuild the queue');
  assert.equal(cover.srcWrites, 1, 'identical settings must not reload the artwork');

  ui.snapshot({ ...state, player: { connected: false } });
  assert.equal(list.rebuilds, 1, 'a broadcast without queue changes keeps the rows');

  ui.settings({ ...settings, maxQueue: 2 });
  assert.equal(list.rebuilds, 2);
  assert.equal(list.children.length, 2);
  ui.settings({ ...settings, maxQueue: 2 });
  assert.equal(list.rebuilds, 2);

  ui.snapshot({ ...state, queue: [queue[1], queue[0], queue[2]] });
  assert.equal(list.rebuilds, 3, 'a reordered queue is rendered again');
  assert.equal(list.children[0].children[1].children[0].textContent, 'Song 2');
});

test('a maxQueue written into the OBS source address wins over the Mod UI setting', () => {
  const ui = overlayHarness('?maxQueue=4');
  const queue = [1, 2, 3, 4, 5].map(index => ({
    id: String(index), title: `Song ${index}`, artist: 'Artist', requestedBy: 'Viewer'
  }));
  ui.snapshot({ current: null, queue, accepting: true, playing: true, player: { connected: true } });
  const list = ui.element('queue-list');
  assert.equal(list.children.length, 4);
  ui.settings({ maxQueue: 2, artworkSource: 'album_cover', coverRotation: false });
  assert.equal(list.children.length, 4, 'the panel setting must not override the URL value');
});
