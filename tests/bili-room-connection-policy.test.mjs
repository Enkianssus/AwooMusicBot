import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import fs from 'node:fs';
import vm from 'node:vm';
import { extractFunctions } from './helpers/source.mjs';

const source = fs.readFileSync(
  new URL('../electron/bili-room-connection-policy.ts', import.meta.url),
  'utf8'
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022
  }
}).outputText;
const module = { exports: {} };
vm.runInNewContext(compiled, { module, exports: module.exports });
const {
  BILI_ROOM_CONNECTION_MESSAGES,
  BILI_ROOM_REFRESH_DELAYS_MS,
  BILI_SOCKET_SILENCE_TIMEOUT_MS,
  createBiliRoomConnectionState,
  nextRoomRefreshDelayMs,
  reduceBiliRoomConnectionState,
  shouldReconnectForSilence
} = module.exports;

test('HTTP room resolution keeps the UI connecting until WebSocket op=8 code=0', () => {
  let state = createBiliRoomConnectionState();
  state = reduceBiliRoomConnectionState(state, {
    type: 'connect-requested',
    session: 1,
    requestedRoomId: 123
  });
  state = reduceBiliRoomConnectionState(state, {
    type: 'room-resolved',
    session: 1,
    realRoomId: 456
  });
  assert.equal(state.status, 'connecting');
  assert.equal(state.realRoomId, 456);
  state = reduceBiliRoomConnectionState(state, {
    type: 'websocket-authenticated',
    session: 1,
    realRoomId: 456
  });
  assert.equal(state.status, 'connected');
  assert.equal(state.message, BILI_ROOM_CONNECTION_MESSAGES.connected);
});

test('stale socket events cannot overwrite a newer connection session', () => {
  let state = reduceBiliRoomConnectionState(
    createBiliRoomConnectionState(),
    { type: 'connect-requested', session: 4, requestedRoomId: 111 }
  );
  state = reduceBiliRoomConnectionState(state, {
    type: 'connect-requested',
    session: 5,
    requestedRoomId: 222
  });
  const stale = reduceBiliRoomConnectionState(state, {
    type: 'websocket-authenticated',
    session: 4,
    realRoomId: 111
  });
  assert.deepEqual(stale, state);
  assert.equal(stale.requestedRoomId, 222);
  assert.equal(stale.status, 'connecting');
});

test('disconnect invalidates the session while retaining room identifiers', () => {
  let state = reduceBiliRoomConnectionState(
    createBiliRoomConnectionState(),
    { type: 'connect-requested', session: 9, requestedRoomId: 321 }
  );
  state = reduceBiliRoomConnectionState(state, {
    type: 'room-resolved',
    session: 9,
    realRoomId: 654
  });
  state = reduceBiliRoomConnectionState(state, {
    type: 'websocket-authenticated',
    session: 9,
    realRoomId: 654
  });
  state = reduceBiliRoomConnectionState(state, {
    type: 'disconnect-requested',
    session: 10
  });
  assert.equal(state.status, 'disconnected');
  assert.equal(state.requestedRoomId, 321);
  assert.equal(state.realRoomId, 654);
  const stale = reduceBiliRoomConnectionState(state, {
    type: 'websocket-authenticated',
    session: 9,
    realRoomId: 654
  });
  assert.deepEqual(stale, state);
});

test('an old disconnect event cannot interrupt a newer connection', () => {
  let state = reduceBiliRoomConnectionState(
    createBiliRoomConnectionState(),
    { type: 'connect-requested', session: 3, requestedRoomId: 100 }
  );
  state = reduceBiliRoomConnectionState(state, {
    type: 'connect-requested',
    session: 4,
    requestedRoomId: 200
  });
  const stale = reduceBiliRoomConnectionState(state, {
    type: 'disconnect-requested',
    session: 3
  });
  assert.deepEqual(stale, state);
  assert.equal(stale.status, 'connecting');
});

test('failed and reconnecting states expose stable UI messages', () => {
  let state = reduceBiliRoomConnectionState(
    createBiliRoomConnectionState(),
    { type: 'connect-requested', session: 2, requestedRoomId: 987 }
  );
  state = reduceBiliRoomConnectionState(state, {
    type: 'socket-reconnecting',
    session: 2,
    message: '正在切换弹幕节点'
  });
  assert.equal(state.status, 'connecting');
  state = reduceBiliRoomConnectionState(state, {
    type: 'connection-failed',
    session: 2,
    message: BILI_ROOM_CONNECTION_MESSAGES.failed
  });
  assert.equal(state.status, 'error');
  assert.equal(state.message, '连接失败');
});

test('a socket is dead after 70 s without any packet, measured from the last one', () => {
  assert.equal(BILI_SOCKET_SILENCE_TIMEOUT_MS, 70_000);
  const lastPacketAt = 1_000_000;
  // Heartbeats go out every 30 s and each is answered, so a healthy idle room
  // is never silent for more than about 30 s.
  assert.equal(shouldReconnectForSilence(lastPacketAt, lastPacketAt + 30_000), false);
  assert.equal(shouldReconnectForSilence(lastPacketAt, lastPacketAt + 69_999), false);
  assert.equal(shouldReconnectForSilence(lastPacketAt, lastPacketAt + 70_000), true);
  assert.equal(shouldReconnectForSilence(lastPacketAt, lastPacketAt + 3_600_000), true);
  // A clock that went backwards is not silence.
  assert.equal(shouldReconnectForSilence(lastPacketAt, lastPacketAt - 120_000), false);
});

test('the silence check honours a custom timeout and ignores invalid input', () => {
  assert.equal(shouldReconnectForSilence(0, 10_000, 10_000), true);
  assert.equal(shouldReconnectForSilence(0, 9_999, 10_000), false);
  for (const timeout of [0, -1, Number.NaN, Infinity]) {
    assert.equal(shouldReconnectForSilence(0, 69_999, timeout), false, String(timeout));
    assert.equal(shouldReconnectForSilence(0, 70_000, timeout), true, String(timeout));
  }
  for (const [lastPacketAt, now] of [[Number.NaN, 100_000], [undefined, 100_000], [0, Number.NaN], [-Infinity, 0]]) {
    assert.equal(shouldReconnectForSilence(lastPacketAt, now), false, `${lastPacketAt}/${now}`);
  }
});

test('refreshing the room token backs off 5 s, 15 s, 30 s, then stays at 60 s', () => {
  assert.deepEqual([...BILI_ROOM_REFRESH_DELAYS_MS], [5000, 15000, 30000, 60000]);
  assert.deepEqual(
    [0, 1, 2, 3, 4, 10, 1000, Infinity].map(attempt => nextRoomRefreshDelayMs(attempt)),
    [5000, 15000, 30000, 60000, 60000, 60000, 60000, 60000]
  );
  assert.equal(nextRoomRefreshDelayMs(1.9), 15000);
  for (const attempt of [-1, -Infinity, Number.NaN, undefined]) {
    assert.equal(nextRoomRefreshDelayMs(attempt), 5000, String(attempt));
  }
});

// ---------------------------------------------------------------------------
// The production socket code in main.ts, driven by a fake WebSocket and clock
// ---------------------------------------------------------------------------

const mainSocketJavascript = ts.transpileModule(extractFunctions('electron/main.ts', [
  'startBiliWebSocket', 'scheduleBiliRoomRefresh', 'refreshBiliRoomAuth', 'readBiliAuthReply',
  'isBiliRoomSessionCurrent', 'failBiliRoomConnection', 'clearBiliConnectionTimers', 'clearBiliPingTimer',
  'closeCurrentBiliWebSocket', 'finishBiliConnectionAttempt', 'createBiliRoomRequestHeaders',
  'connectToLiveRoom', 'openBiliRoomConnection', 'scheduleBiliRoomConnectRetry',
  'invalidateBiliRoomTransport', 'disconnectFromLiveRoom', 'logoutBiliAccount', 'isBiliRoomRetryPending'
]), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function biliPacket(op, body) {
  const payload = Buffer.from(body);
  const header = Buffer.alloc(16);
  header.writeInt32BE(16 + payload.length, 0);
  header.writeInt16BE(16, 4);
  header.writeInt16BE(1, 6);
  header.writeInt32BE(op, 8);
  header.writeInt32BE(1, 12);
  return Buffer.concat([header, payload]);
}
const authReply = code => biliPacket(8, JSON.stringify({ code }));
const heartbeatReply = () => biliPacket(3, Buffer.alloc(4));
const settle = () => new Promise(resolve => setImmediate(resolve));

function socketHarness({ endpoints = 2 } = {}) {
  let now = 1_000_000;
  let nextTimerId = 1;
  const timers = new Map();
  const sockets = [];
  const logs = [];
  const events = [];
  const refreshes = [];
  const roomInits = [];
  let refreshResult = null;
  let roomInitResult = null;

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.handlers = {};
      this.terminated = false;
      sockets.push(this);
    }
    on(name, handler) { this.handlers[name] = handler; }
    send(data) { this.sent.push(Buffer.from(data)); }
    terminate() { this.terminated = true; this.readyState = 3; }
    close() { this.terminate(); }
    open() { this.readyState = 1; this.handlers.open(); }
    async receive(buffer) { await this.handlers.message(buffer); }
    drop() { this.handlers.close(); }
    sentAuth() { return JSON.parse(this.sent[0].subarray(16).toString('utf8')); }
    heartbeats() { return this.sent.filter(packet => packet.readInt32BE(8) === 2).length; }
  }

  const schedule = (fn, delay, interval) => {
    const id = nextTimerId++;
    timers.set(id, { at: now + delay, fn, interval });
    return id;
  };
  const context = vm.createContext({
    ...module.exports,
    Buffer,
    Date: { now: () => now },
    setTimeout: (fn, delay) => schedule(fn, delay, 0),
    setInterval: (fn, delay) => schedule(fn, delay, delay),
    clearTimeout: id => timers.delete(id),
    clearInterval: id => timers.delete(id),
    appConfig: { roomId: 42, roomConnectionEnabled: true },
    biliCookie: '',
    biliUid: 0,
    currentBiliWs: null,
    biliPingTimer: null,
    biliReconnectTimer: null,
    biliConnectionTimer: null,
    biliRoomSession: 1,
    lastBiliPacketAt: 0,
    biliRoomRefreshAttempt: 0,
    biliConnectionAttempt: null,
    getWebSocketClient: () => FakeWebSocket,
    dispatchBiliRoomConnectionEvent: event => events.push(event),
    writeLog: (message, color) => logs.push({ message, color }),
    setGlobalStatus() {},
    saveConfigNow() {},
    parseBiliPacket() {},
    // Logging out of Bilibili, which reconnects the room as a guest.
    qrLoginAttemptId: 0,
    stopBiliQrPolling() {},
    isQrLoggingIn: false,
    qrCodeBase64: '',
    qrLoginStatus: '',
    currentUserInfo: null,
    createEmptyBiliUserInfo: () => ({ uid: 0, uname: '' }),
    fetchBiliDanmuAuth: async (realRoomId, headers) => {
      refreshes.push({ realRoomId, headers });
      return typeof refreshResult === 'function' ? refreshResult() : refreshResult;
    },
    // Only room_init goes through fetchWithTimeout here; the token is fetchBiliDanmuAuth above.
    fetchWithTimeout: async url => {
      roomInits.push(String(url));
      return typeof roomInitResult === 'function' ? roomInitResult() : roomInitResult;
    }
  });
  vm.runInContext(mainSocketJavascript, context);

  const hostList = Array.from({ length: endpoints }, (_, index) => ({
    host: `node${index}.example`, port: 443, url: `wss://node${index}.example/sub`
  }));
  return {
    context, sockets, logs, events, refreshes, roomInits, hostList,
    setRefreshResult(value) { refreshResult = value; },
    setRoomInit(value) { roomInitResult = value; },
    start(token = 'first-token') {
      context.startBiliWebSocket({ roomid: 42, key: token }, hostList, 0, 1, 0, 42);
      return sockets[sockets.length - 1];
    },
    async advance(milliseconds) {
      const target = now + milliseconds;
      for (;;) {
        let due = null;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (!due || timer.at < due.timer.at)) due = { id, timer };
        }
        if (!due) break;
        now = due.timer.at;
        if (due.timer.interval) due.timer.at += due.timer.interval;
        else timers.delete(due.id);
        due.timer.fn();
        await settle();
      }
      now = target;
      await settle();
    }
  };
}

async function authenticate(harness, socket) {
  socket.open();
  await socket.receive(authReply(0));
  assert.ok(harness.events.some(event => event.type === 'websocket-authenticated'));
}

test('an authenticated socket that falls silent for 70 s reconnects with 心跳超时', async () => {
  const h = socketHarness();
  const first = h.start();
  await authenticate(h, first);

  await h.advance(30_000);
  assert.equal(first.heartbeats(), 1);
  await first.receive(heartbeatReply());
  await h.advance(30_000);
  await h.advance(30_000);
  // 60 s of silence: still only heartbeats.
  assert.equal(first.heartbeats(), 3);
  assert.equal(first.terminated, false);
  await h.advance(30_000);
  // 90 s of silence: the half-open socket is dropped instead of sent another heartbeat.
  assert.equal(first.heartbeats(), 3);
  assert.equal(first.terminated, true);
  assert.ok(h.logs.some(log => log.message.includes('心跳超时')));
  assert.ok(h.events.some(event => event.type === 'socket-reconnecting'));

  await h.advance(1500);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.sockets[1].url, 'wss://node1.example/sub');
});

test('a socket that keeps receiving heartbeat replies is never dropped', async () => {
  const h = socketHarness();
  const socket = h.start();
  await authenticate(h, socket);
  for (let round = 0; round < 20; round += 1) {
    await h.advance(30_000);
    await socket.receive(heartbeatReply());
  }
  assert.equal(socket.terminated, false);
  assert.equal(h.sockets.length, 1);
  assert.equal(socket.heartbeats(), 20);
});

test('a failed round fetches a fresh token after 5 s, then backs off until a socket authenticates', async () => {
  const h = socketHarness();
  h.setRefreshResult(() => ({
    ok: true,
    authObj: { roomid: 42, key: `fresh-token-${h.refreshes.length}` },
    endpoints: h.hostList
  }));
  h.start().drop();
  await h.advance(1500);
  h.sockets[1].drop();
  await h.advance(1500);
  assert.ok(h.events.some(event => event.type === 'connection-failed'));
  assert.ok(h.logs.some(log => log.message.includes('5 秒后重新获取弹幕鉴权')));

  await h.advance(4999);
  assert.equal(h.refreshes.length, 0);
  await h.advance(1);
  assert.deepEqual(h.refreshes.map(refresh => refresh.realRoomId), [42]);
  assert.equal(h.refreshes[0].headers.Referer, 'https://live.bilibili.com/42');
  const refreshed = h.sockets[2];
  refreshed.open();
  assert.equal(refreshed.sentAuth().key, 'fresh-token-1');

  // The next failed round waits 15 s.
  refreshed.drop();
  await h.advance(1500);
  h.sockets[3].drop();
  await h.advance(1500);
  await h.advance(14_999);
  assert.equal(h.refreshes.length, 1);
  await h.advance(1);
  assert.equal(h.refreshes.length, 2);

  // An authenticated socket resets the backoff: the next failure waits 5 s again.
  await authenticate(h, h.sockets[4]);
  assert.equal(h.context.biliRoomRefreshAttempt, 0);
  h.sockets[4].drop();
  await h.advance(1500);
  h.sockets[5].drop();
  await h.advance(1500);
  await h.advance(5000);
  assert.equal(h.refreshes.length, 3);
});

test('a failed refresh retries with the previous token', async () => {
  const h = socketHarness({ endpoints: 1 });
  h.setRefreshResult({ ok: false, log: '[Bilibili] 无法获取弹幕鉴权信息，code=-1', message: '连接失败' });
  h.start('old-token').drop();
  await h.advance(1500);
  await h.advance(5000);
  assert.equal(h.refreshes.length, 1);
  assert.ok(h.logs.some(log => log.message.includes('继续使用上次的鉴权信息重试')));
  h.sockets[1].open();
  assert.equal(h.sockets[1].sentAuth().key, 'old-token');

  h.setRefreshResult(() => { throw new Error('network down'); });
  h.sockets[1].drop();
  await h.advance(1500);
  await h.advance(15_000);
  assert.equal(h.refreshes.length, 2);
  h.sockets[2].open();
  assert.equal(h.sockets[2].sentAuth().key, 'old-token');
});

test('a disconnect or a new room during the refresh starts no socket', async () => {
  for (const change of [
    context => { context.appConfig.roomConnectionEnabled = false; },
    context => { context.biliRoomSession = 2; }
  ]) {
    const h = socketHarness({ endpoints: 1 });
    let release;
    h.setRefreshResult(() => new Promise(resolve => { release = resolve; }));
    h.start().drop();
    await h.advance(1500);
    await h.advance(5000);
    assert.equal(h.refreshes.length, 1);
    change(h.context);
    release({ ok: true, authObj: { roomid: 42, key: 'late-token' }, endpoints: h.hostList });
    await h.advance(60_000);
    assert.equal(h.sockets.length, 1);
  }

  // Disconnecting before the timer fires cancels the refresh altogether.
  const h = socketHarness({ endpoints: 1 });
  h.setRefreshResult({ ok: true, authObj: { roomid: 42, key: 'unused' }, endpoints: h.hostList });
  h.start().drop();
  await h.advance(1500);
  h.context.appConfig.roomConnectionEnabled = false;
  await h.advance(60_000);
  assert.equal(h.refreshes.length, 0);
  assert.equal(h.sockets.length, 1);
});

const roomInitOk = (roomId = 4242) => ({ json: async () => ({ code: 0, data: { room_id: roomId } }) });
const networkDown = () => { throw new TypeError('fetch failed'); };
const roomOf = url => new URL(url).searchParams.get('id');

test('a network error before the first socket is retried with the room backoff until the room connects', async () => {
  const h = socketHarness({ endpoints: 1 });
  h.setRefreshResult({ ok: true, authObj: { roomid: 4242, key: 'room-token' }, endpoints: h.hostList });
  let failures = 0;
  h.setRoomInit(() => {
    failures += 1;
    if (failures === 1) networkDown();
    // An answer that is not JSON, e.g. from a captive portal, counts as a network error too.
    if (failures === 2) return { json: async () => { throw new SyntaxError('Unexpected token <'); } };
    return roomInitOk();
  });
  assert.equal(await h.context.connectToLiveRoom(42, { enable: true }), false, 'the first failure is reported');
  assert.equal(h.events.at(-1).message, '连接失败：fetch failed');
  assert.ok(h.logs.some(log => log.message === '[Bilibili] 5 秒后重新连接直播间'));

  await h.advance(4999);
  assert.equal(h.roomInits.length, 1);
  await h.advance(1);
  assert.equal(h.roomInits.length, 2);
  assert.ok(h.logs.some(log => log.message === '[Bilibili] 15 秒后重新连接直播间'));
  await h.advance(15_000);
  assert.deepEqual(h.roomInits.map(roomOf), ['42', '42', '42']);
  assert.deepEqual(h.refreshes.map(refresh => refresh.realRoomId), [4242]);
  assert.equal(h.sockets.length, 1);
  await authenticate(h, h.sockets[0]);
  assert.equal(h.sockets[0].sentAuth().key, 'room-token');
  assert.equal(h.context.biliRoomRefreshAttempt, 0, 'a connected room starts the backoff afresh');
  assert.deepEqual(h.events.map(event => event.type), [
    'disconnect-requested', 'connect-requested', 'connection-failed',
    'socket-reconnecting', 'connection-failed',
    'socket-reconnecting', 'room-resolved', 'socket-reconnecting', 'websocket-authenticated'
  ]);
  const session = h.context.biliRoomSession;
  assert.ok(h.events.slice(1).every(event => event.session === session), 'all in one session');
});

test('Bilibili refusing the room or the token is final', async () => {
  for (const [label, prepare] of [
    ['room refused', h => h.setRoomInit({ json: async () => ({ code: 60004, message: '直播间不存在' }) })],
    ['token refused', h => {
      h.setRoomInit(roomInitOk());
      h.setRefreshResult({ ok: false, log: '[Bilibili] 无法获取弹幕鉴权信息，code=-352', message: '连接失败：无法取得弹幕鉴权' });
    }]
  ]) {
    const h = socketHarness({ endpoints: 1 });
    prepare(h);
    assert.equal(await h.context.connectToLiveRoom(42, { enable: true }), false, label);
    await h.advance(300_000);
    assert.equal(h.roomInits.length, 1, label);
    assert.equal(h.sockets.length, 0, label);
    assert.equal(h.events.at(-1).type, 'connection-failed', label);
    assert.ok(!h.logs.some(log => log.message.includes('重新连接直播间')), label);
  }
});

test('disconnecting or choosing another room cancels the connection retry', async () => {
  // The user disconnects while the retry waits.
  const waiting = socketHarness({ endpoints: 1 });
  waiting.setRoomInit(networkDown);
  await waiting.context.connectToLiveRoom(42, { enable: true });
  waiting.context.disconnectFromLiveRoom();
  await waiting.advance(300_000);
  assert.equal(waiting.roomInits.length, 1);
  assert.equal(waiting.context.biliReconnectTimer, null);

  // Another room is chosen: only the new room is requested from then on.
  const moved = socketHarness({ endpoints: 1 });
  moved.setRoomInit(networkDown);
  await moved.context.connectToLiveRoom(42, { enable: true });
  moved.setRoomInit(() => new Promise(() => {}));
  void moved.context.connectToLiveRoom(43, { enable: true });
  await moved.advance(300_000);
  assert.deepEqual(moved.roomInits.map(roomOf), ['42', '43']);

  // A retry already under way when the user disconnects starts no socket.
  const inFlight = socketHarness({ endpoints: 1 });
  inFlight.setRefreshResult({ ok: true, authObj: { roomid: 4242, key: 'late' }, endpoints: inFlight.hostList });
  let release = null;
  inFlight.setRoomInit(networkDown);
  await inFlight.context.connectToLiveRoom(42, { enable: true });
  inFlight.setRoomInit(() => new Promise(resolve => { release = () => resolve(roomInitOk()); }));
  await inFlight.advance(5000);
  assert.equal(inFlight.roomInits.length, 2);
  inFlight.context.disconnectFromLiveRoom();
  release();
  await inFlight.advance(300_000);
  assert.equal(inFlight.refreshes.length, 0);
  assert.equal(inFlight.sockets.length, 0);
  assert.equal(inFlight.roomInits.length, 2);
});

test('after logging out, a guest connection asks for a manual retry only when nothing retries it', async () => {
  const logOut = async prepare => {
    const h = socketHarness({ endpoints: 1 });
    prepare(h);
    h.context.logoutBiliAccount();
    await h.advance(0);
    return h;
  };
  const guestLines = h => h.logs.filter(log => log.message.startsWith('[Bilibili] 游客弹幕')
    || log.message.startsWith('[Bilibili] 已自动切换')).map(log => [log.message, log.color]);
  const willRetry = [['[Bilibili] 游客弹幕暂未连接成功，将自动重试', 'Yellow']];

  // No network: the request is retried on its own.
  const offline = await logOut(h => h.setRoomInit(networkDown));
  assert.deepEqual(guestLines(offline), willRetry);
  assert.ok(!offline.logs.some(log => log.message.includes('手动重试')));

  // Every endpoint failed: the round is retried with a fresh token.
  const round = await logOut(h => {
    h.setRoomInit(roomInitOk());
    h.setRefreshResult({ ok: true, authObj: { roomid: 4242, key: 'guest' }, endpoints: h.hostList });
  });
  round.sockets[0].drop();
  await round.advance(1500);
  assert.deepEqual(guestLines(round), willRetry);

  // Bilibili refused the room: only the user can change that.
  const refused = await logOut(h => h.setRoomInit({ json: async () => ({ code: 60004 }) }));
  assert.deepEqual(guestLines(refused), [['[Bilibili] 游客弹幕自动重连失败，请手动重试', 'Yellow']]);

  // Disconnecting meanwhile is no failure at all.
  const disconnected = await logOut(h => h.setRoomInit(() => new Promise(() => {})));
  disconnected.context.disconnectFromLiveRoom();
  await disconnected.advance(0);
  assert.deepEqual(guestLines(disconnected), []);

  const connected = await logOut(h => {
    h.setRoomInit(roomInitOk());
    h.setRefreshResult({ ok: true, authObj: { roomid: 4242, key: 'guest' }, endpoints: h.hostList });
  });
  await authenticate(connected, connected.sockets[0]);
  await connected.advance(0);
  assert.deepEqual(guestLines(connected), [['[Bilibili] 已自动切换为游客弹幕连接', 'Green']]);
});
