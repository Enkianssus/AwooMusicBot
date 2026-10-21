import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(path.resolve(import.meta.dirname, '../examples/obs-overlay/app.js'), 'utf8');
const epoch = 1_800_000_000_000;

function overlayHarness() {
  let now = epoch;
  let timerId = 0;
  const timeouts = new Map();
  const elements = new Map();
  const sockets = [];
  class Element {
    constructor() {
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.textContent = '';
      this.hidden = false;
      this.parent = null;
      this.inserts = 0;
    }
    append(...children) { children.forEach(child => this.insertBefore(child, null)); }
    insertBefore(child, reference) {
      child.remove();
      const index = reference ? this.children.indexOf(reference) : this.children.length;
      this.children.splice(index, 0, child);
      child.parent = this;
      this.inserts += 1;
    }
    remove() {
      if (!this.parent) return;
      const siblings = this.parent.children;
      siblings.splice(siblings.indexOf(this), 1);
      this.parent = null;
    }
    replaceChildren(...children) {
      this.children.forEach(child => { child.parent = null; });
      this.children = [];
      this.append(...children);
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
  }
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor() { this.handlers = {}; this.readyState = 0; sockets.push(this); }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    emit(name, event = {}) {
      if (name === 'open') this.readyState = 1;
      if (name === 'close') this.readyState = 3;
      this.handlers[name]?.(event);
    }
  }
  class Clock extends Date {
    static now() { return now; }
  }
  function element(id) {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  }
  vm.runInNewContext(source, {
    URL, URLSearchParams, Date: Clock, WebSocket: Socket,
    document: { getElementById: element, createElement: () => new Element() },
    fetch: () => new Promise(() => {}),
    window: {
      location: { search: '', port: '5556', href: 'http://127.0.0.1:5556/overlay/' },
      addEventListener() {},
      setInterval: () => ++timerId,
      clearInterval() {},
      setTimeout(callback, delay) {
        const id = ++timerId;
        timeouts.set(id, { callback, at: now + delay });
        return id;
      },
      clearTimeout: id => timeouts.delete(id)
    }
  });
  function advance(milliseconds) {
    const target = now + milliseconds;
    while (true) {
      const next = [...timeouts.entries()].filter(([, item]) => item.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timeouts.delete(next[0]);
      next[1].callback();
    }
    now = target;
  }
  function snapshot(notifications, timestamp = now) {
    sockets.at(-1).emit('message', { data: JSON.stringify({
      type: 'state', data: {
        timestamp: new Date(timestamp).toISOString(),
        accepting: true, playing: true,
        player: { connected: true }, queue: [],
        ...(notifications === undefined ? {} : { requestNotifications: notifications })
      }
    }) });
  }
  return { element, advance, snapshot, sockets, get now() { return now; } };
}

function notice(overrides = {}) {
  return {
    id: 'request-1', kind: 'waiting', title: '晴天', message: '正在搜索歌曲',
    requestedBy: '小明', createdAt: epoch, expiresAt: epoch + 120_000, ...overrides
  };
}

test('request popups update the same card and expire without another state broadcast', () => {
  const ui = overlayHarness();
  const list = ui.element('queue-notifications');
  ui.snapshot([notice()]);
  const card = list.children[0];
  assert.equal(card.children[0].textContent, '待处理');
  assert.equal(card.children[1].textContent, '晴天');
  assert.equal(card.children[2].textContent, '小明 · 正在搜索歌曲');
  ui.advance(1_000);
  const result = notice({ kind: 'success', message: '已加入待播队列', expiresAt: ui.now + 6_000 });
  ui.snapshot([result]);
  assert.equal(list.children[0], card);
  assert.equal(card.children[0].textContent, '点歌成功');
  ui.advance(2_000);
  ui.snapshot([result], epoch + 1_000);
  assert.equal(list.inserts, 1, 'identical snapshots must not reinsert the card');
  ui.advance(4_000);
  assert.equal(list.children.length, 0);
  assert.equal(list.hidden, true);
  ui.snapshot([result], epoch + 1_000);
  assert.equal(list.children.length, 0, 'stale snapshots cannot restart expired results');
});

test('reconnect does not restart a popup or display WebSocket text while connected', () => {
  const ui = overlayHarness();
  const result = notice({ kind: 'success', expiresAt: epoch + 6_000 });
  ui.sockets[0].emit('open');
  ui.snapshot([result]);
  assert.equal(ui.element('connection-label').hidden, true);
  assert.equal(ui.element('connection-status').attributes['aria-label'], 'WebSocket 已连接');
  assert.equal(ui.element('connection-status').title, 'WebSocket 已连接');
  ui.advance(5_000);
  ui.sockets[0].emit('close');
  assert.equal(ui.element('connection-label').hidden, false);
  ui.advance(1_000);
  ui.sockets[1].emit('open');
  ui.snapshot([result], epoch);
  assert.equal(ui.element('queue-notifications').children.length, 0);
});

test('server snapshot time handles differing browser clocks and duplicate snapshot timestamps', () => {
  const ui = overlayHarness();
  const serverTime = epoch - 3_600_000;
  const result = notice({ kind: 'success', createdAt: serverTime, expiresAt: serverTime + 6_000 });
  ui.snapshot([result], serverTime);
  assert.equal(ui.element('queue-notifications').children.length, 1);
  ui.advance(5_000);
  ui.snapshot([result], serverTime);
  ui.advance(1_000);
  assert.equal(ui.element('queue-notifications').children.length, 0);
});

test('a stale HTTP snapshot cannot roll a completed operation back to waiting', () => {
  const ui = overlayHarness();
  const waiting = notice();
  ui.snapshot([waiting]);
  ui.advance(1_000);
  ui.snapshot([notice({ kind: 'success', message: '已加入待播队列', expiresAt: epoch + 7_000 })]);
  ui.snapshot([waiting], epoch);
  assert.equal(ui.element('queue-notifications').children[0].children[0].textContent, '点歌成功');
  ui.advance(6_000);
  assert.equal(ui.element('queue-notifications').children.length, 0);
});

test('only two current popups render, expiry reveals remaining notices, and titles stay plain text', () => {
  const ui = overlayHarness();
  ui.snapshot([
    notice({ id: 'old', kind: 'cancelled', expiresAt: epoch + 10_000 }),
    notice({ id: 'middle', kind: 'error', createdAt: epoch + 1, expiresAt: epoch + 8_000, message: '撤回失败：正在播放' }),
    notice({ id: 'new', kind: 'error', createdAt: epoch + 2, expiresAt: epoch + 6_000, title: '<img src=x onerror=alert(1)>', message: '没有搜索结果' })
  ]);
  const list = ui.element('queue-notifications');
  assert.equal(list.children.length, 2);
  assert.equal(list.children[0].children[0].textContent, '点歌失败');
  assert.equal(list.children[0].children[1].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(list.children[0].children[1].children.length, 0);
  assert.equal(list.children[1].children[0].textContent, '撤回失败');
  ui.advance(6_000);
  assert.equal(list.children.length, 2);
  assert.equal(list.children[1].children[0].textContent, '撤回成功');
  ui.advance(4_000);
  assert.equal(list.children.length, 0);
});

test('labels come from the notice action and only legacy notices sniff the message', () => {
  const cases = [
    [{ kind: 'error', action: 'request', message: '点歌失败：未搜到歌曲: 撤回' }, '点歌失败'],
    [{ kind: 'error', action: 'cancel', message: '撤回失败：歌曲正在播放' }, '撤回失败'],
    [{ kind: 'error', action: 'future', message: '撤回?' }, '点歌失败'],
    [{ kind: 'cancelled', action: 'cancel', message: '撤回成功，已移出待播队列' }, '撤回成功'],
    [{ kind: 'cancelled', action: 'remove', message: '主播已将歌曲移出待播队列', requestedBy: '主播' }, '主播已移出'],
    [{ kind: 'waiting', action: 'cancel', message: '正在撤回歌曲，请稍候' }, '待处理'],
    [{ kind: 'success', action: 'request', message: '已加入待播队列' }, '点歌成功'],
    // Hosts before 1.2.6 send no action.
    [{ kind: 'error', message: '撤回失败：歌曲正在播放' }, '撤回失败'],
    [{ kind: 'error', message: '点歌失败：没有搜索结果' }, '点歌失败'],
    [{ kind: 'cancelled', message: '撤回成功，已移出待播队列' }, '撤回成功']
  ];
  for (const [overrides, label] of cases) {
    const ui = overlayHarness();
    ui.snapshot([notice({ expiresAt: epoch + 6_000, ...overrides })]);
    const card = ui.element('queue-notifications').children[0];
    assert.equal(card.children[0].textContent, label, JSON.stringify(overrides));
    assert.equal(card.dataset.kind, overrides.kind);
  }
});

test('a streamer removal is not attributed to the viewer', () => {
  const ui = overlayHarness();
  ui.snapshot([notice({
    kind: 'cancelled', action: 'remove', requestedBy: '主播',
    message: '主播已将歌曲移出待播队列', expiresAt: epoch + 6_000
  })]);
  const card = ui.element('queue-notifications').children[0];
  assert.equal(card.children[0].textContent, '主播已移出');
  assert.equal(card.children[1].textContent, '晴天');
  assert.equal(card.children[2].textContent, '主播已将歌曲移出待播队列');
});

test('only the newest waiting request takes a card and the queue reserves room for notices', () => {
  const ui = overlayHarness();
  const list = ui.element('queue-notifications');
  const queue = ui.element('queue-region');
  ui.snapshot([]);
  assert.equal(queue.dataset.hasNotices, 'false');
  const waiting = [
    notice({ id: 'first', title: '第一首' }),
    notice({ id: 'second', title: '第二首', createdAt: epoch + 1 }),
    notice({ id: 'third', title: '第三首', createdAt: epoch + 2 })
  ];
  ui.snapshot(waiting);
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].children[1].textContent, '第三首');
  assert.equal(list.hidden, false);
  assert.equal(queue.dataset.hasNotices, 'true');
  ui.advance(1_000);
  const result = notice({
    id: 'second', kind: 'success', title: '第二首', message: '已加入待播队列',
    createdAt: ui.now, expiresAt: ui.now + 6_000
  });
  ui.snapshot([waiting[0], result, waiting[2]]);
  assert.deepEqual(list.children.map(card => card.children[1].textContent), ['第二首', '第三首']);
  assert.deepEqual(list.children.map(card => card.dataset.kind), ['success', 'waiting']);
  ui.snapshot([]);
  assert.equal(list.children.length, 0);
  assert.equal(list.hidden, true);
  assert.equal(queue.dataset.hasNotices, 'false');
});

test('older hosts and malformed notifications are harmless', () => {
  const ui = overlayHarness();
  const list = ui.element('queue-notifications');
  ui.snapshot(undefined);
  assert.equal(list.hidden, true);
  ui.snapshot([
    null, 'bad', {}, notice({ id: '' }), notice({ kind: 'unknown' }),
    notice({ createdAt: '1800000000000' }), notice({ expiresAt: epoch - 1 }),
    notice({ title: {} }), notice({ requestedBy: null }), notice({ message: [] })
  ]);
  assert.equal(list.children.length, 0);
  ui.snapshot([notice()]);
  assert.equal(list.children.length, 1);
  ui.snapshot(undefined);
  assert.equal(list.children.length, 0);
  ui.advance(120_000);
  assert.equal(list.hidden, true);
});
