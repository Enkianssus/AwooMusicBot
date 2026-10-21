import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { WebSocket } from 'ws';
import { createExternalApiServer } from '../electron/external-api-server.ts';
import { readSource, sliceBetween } from './helpers/source.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const BROADCAST_MS = 15;

// Waits for an expected event without depending on exact timer timing.
async function until(predicate, message, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, message);
    await wait(5);
  }
}

function fakeState(overrides = {}) {
  return {
    schemaVersion: 1,
    appVersion: '1.2.6',
    timestamp: new Date().toISOString(),
    player: { key: 'netease', name: '网易云音乐', connected: true, connecting: false, processId: 1, version: '3.1', status: '' },
    current: null,
    currentIsRequested: false,
    queue: [],
    queueLength: 0,
    service: {
      requestIntake: { enabled: true, state: 'accepting' },
      queuePlayback: { enabled: true, state: 'running' }
    },
    accepting: true,
    playing: true,
    pausedAfterRequests: false,
    commandQueue: { pending: 0, processing: false },
    requestNotifications: [],
    ...overrides
  };
}

async function freePort() {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

// Tracks the servers and intervals the module creates.
function instrument(t) {
  const servers = [];
  const intervals = new Map();
  const originalCreateServer = http.createServer;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  http.createServer = (...args) => {
    const server = originalCreateServer(...args);
    servers.push(server);
    return server;
  };
  globalThis.setInterval = (callback, delay, ...args) => {
    const timer = originalSetInterval(callback, delay, ...args);
    intervals.set(timer, delay);
    return timer;
  };
  globalThis.clearInterval = timer => {
    intervals.delete(timer);
    return originalClearInterval(timer);
  };
  t.after(() => {
    http.createServer = originalCreateServer;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  });
  return {
    listening: () => servers.filter(server => server.listening).length,
    broadcastTimers: () => [...intervals.values()].filter(delay => delay === BROADCAST_MS).length,
    timers: () => intervals.size
  };
}

function harness(t, { settings, closeGraceMs = 1000, heartbeatIntervalMs = 60_000 } = {}) {
  const logs = [];
  let state = fakeState();
  const current = { httpEnabled: true, wsEnabled: true, port: 0, ...settings };
  const api = createExternalApiServer({
    getSettings: () => ({ ...current }),
    appVersion: '1.2.6',
    buildState: () => ({ ...state, timestamp: new Date().toISOString() }),
    getOverlayPublicState: async () => ({ schemaVersion: 1, activeId: 'builtin', active: { id: 'builtin', entry: 'index.html' } }),
    serveOverlay: async (_req, res, pathname) => {
      if (pathname !== '/overlay/') return false;
      res.end('host');
      return true;
    },
    log: (message, color) => logs.push([color, message]),
    broadcastIntervalMs: BROADCAST_MS,
    heartbeatIntervalMs,
    closeGraceMs
  });
  t.after(() => api.stop());
  return {
    api,
    logs,
    settings: current,
    setState: patch => { state = fakeState(patch); },
    port: () => api.getInfo().port
  };
}

function request(port, { path = '/health', method = 'GET', host = `127.0.0.1:${port}`, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { Host: host, ...headers } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const messages = [];
    client.on('message', data => messages.push(JSON.parse(String(data))));
    client.once('open', () => resolve({ client, messages }));
    client.once('error', reject);
  });
}

function closed(client) {
  return new Promise(resolve => client.once('close', (code, reason) => resolve({ code, reason: String(reason) })));
}

// A raw WebSocket peer that completes the handshake and then never answers
// pings or close frames, like a frozen OBS browser source.
function connectUnresponsive(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let handshake = '';
    socket.on('error', () => {});
    socket.once('connect', () => {
      socket.write([
        'GET /ws HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
        'Sec-WebSocket-Version: 13',
        '', ''
      ].join('\r\n'));
    });
    socket.on('data', function onData(chunk) {
      handshake += chunk.toString('latin1');
      if (handshake.includes('\r\n\r\n')) {
        socket.off('data', onData);
        if (!handshake.startsWith('HTTP/1.1 101')) reject(new Error(handshake.split('\r\n')[0]));
        else resolve(socket);
      }
    });
  });
}

test('concurrent restarts leave exactly one listening server and one broadcast timer', { timeout: 10_000 }, async t => {
  const tracked = instrument(t);
  const port = await freePort();
  const { api } = harness(t, { settings: { port }, closeGraceMs: 150 });
  await Promise.all([api.restart(), api.restart()]);
  assert.deepEqual(api.getInfo(), { running: true, port, error: null });
  assert.equal(tracked.listening(), 1);
  assert.equal(tracked.broadcastTimers(), 1);

  // A peer that ignores the close handshake keeps the first stop waiting while
  // more restarts arrive, the window in which the old code orphaned a server.
  const frozen = await connectUnresponsive(port);
  const first = api.restart();
  await wait(20);
  const second = api.restart();
  const third = api.restart();
  assert.equal(second, third, 'queued restarts are coalesced');
  await Promise.all([first, second, third]);
  assert.deepEqual(api.getInfo(), { running: true, port, error: null });
  assert.equal(tracked.listening(), 1);
  assert.equal(tracked.broadcastTimers(), 1);
  assert.equal(tracked.timers(), 2, 'one broadcast and one heartbeat timer');
  assert.equal((await request(port)).status, 200);
  frozen.destroy();

  // The last call wins: restart then stop ends stopped.
  const restarting = api.restart();
  const stopping = api.stop();
  await Promise.all([restarting, stopping]);
  assert.deepEqual(api.getInfo(), { running: false, port: null, error: null });
  assert.equal(tracked.listening(), 0);
  assert.equal(tracked.timers(), 0);

  // And stop then restart ends running.
  await Promise.all([api.stop(), api.restart()]);
  assert.equal(api.getInfo().running, true);
  assert.equal(tracked.listening(), 1);
});

test('a port in use is reported and nothing is left behind', { timeout: 10_000 }, async t => {
  const tracked = instrument(t);
  const blocker = net.createServer();
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => blocker.close(resolve)));
  const { api, logs } = harness(t, { settings: { port: blocker.address().port } });
  await api.restart();
  assert.deepEqual(api.getInfo(), { running: false, port: blocker.address().port, error: 'EADDRINUSE' });
  assert.equal(tracked.timers(), 0);
  assert.equal(tracked.listening(), 0);
  assert.ok(logs.some(([color, message]) => color === 'Red' && message.startsWith('[外部接口] 启动失败')));
  await api.stop();
  assert.equal(api.getInfo().error, null, 'stopping clears the error');
});

test('disabled HTTP and WebSocket start nothing', { timeout: 10_000 }, async t => {
  const tracked = instrument(t);
  const { api, logs } = harness(t, { settings: { httpEnabled: false, wsEnabled: false } });
  await api.restart();
  assert.deepEqual(api.getInfo(), { running: false, port: null, error: null });
  assert.equal(tracked.listening() + tracked.timers(), 0);
  assert.deepEqual(logs, [['DarkGray', '[外部接口] HTTP 与 WebSocket 均已关闭']]);
});

test('HTTP and upgrade requests with a foreign Host are refused', { timeout: 10_000 }, async t => {
  const { api } = harness(t);
  await api.restart();
  const port = api.getInfo().port;
  for (const host of [`evil.example:${port}`, `127.0.0.1:${port + 1}`, '127.0.0.1', `127.0.0.1.nip.io:${port}`]) {
    const response = await request(port, { host, path: '/api/v1/state' });
    assert.equal(response.status, 403, host);
    assert.equal(response.body, 'Invalid host');
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`, `[::1]:${port}`]) {
    assert.equal((await request(port, { host })).status, 200, host);
  }
  const upgrade = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/ws',
      headers: {
        Host: `evil.example:${port}`, Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13'
      }
    });
    req.on('response', res => { res.resume(); resolve(res.statusCode); });
    req.on('upgrade', () => reject(new Error('upgrade accepted')));
    req.on('error', reject);
    req.end();
  });
  assert.equal(upgrade, 403);
});

test('the read-only HTTP routes keep their shapes and CORS headers', { timeout: 10_000 }, async t => {
  const { api, setState } = harness(t);
  setState({ queue: [{ id: '1', title: 'Song' }], queueLength: 1 });
  await api.restart();
  const port = api.getInfo().port;
  const health = await request(port);
  assert.deepEqual(JSON.parse(health.body), { ok: true, schemaVersion: 1, version: '1.2.6' });
  assert.equal(health.headers['access-control-allow-origin'], '*');
  assert.equal(health.headers['cache-control'], 'no-store');
  assert.equal(health.headers['x-content-type-options'], 'nosniff');

  const state = JSON.parse((await request(port, { path: '/api/v1/state' })).body);
  assert.equal(state.queueLength, 1);
  assert.deepEqual(Object.keys(JSON.parse((await request(port, { path: '/api/v1/current' })).body)),
    ['schemaVersion', 'appVersion', 'timestamp', 'player', 'current', 'currentIsRequested', 'service']);
  assert.deepEqual(Object.keys(JSON.parse((await request(port, { path: '/api/v1/queue?x=1' })).body)),
    ['schemaVersion', 'appVersion', 'timestamp', 'queue', 'queueLength', 'requestNotifications', 'service']);
  assert.equal(JSON.parse((await request(port, { path: '/api/v1/overlay' })).body).active.entry, 'index.html');
  assert.equal((await request(port, { path: '/overlay/' })).body, 'host');
  const redirect = await request(port, { path: '/overlay?maxQueue=3' });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.location, '/overlay/?maxQueue=3');
  const missing = await request(port, { path: '/nope' });
  assert.equal(missing.status, 404);
  assert.deepEqual(JSON.parse(missing.body), { error: 'not_found' });
  assert.equal((await request(port, { method: 'POST', path: '/api/v1/state' })).status, 404);
  const preflight = await request(port, { method: 'OPTIONS', path: '/api/v1/state' });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-methods'], 'GET, OPTIONS');
});

test('WebSocket-only mode serves no HTTP data and HTTP-only mode refuses upgrades', { timeout: 10_000 }, async t => {
  const wsOnly = harness(t, { settings: { httpEnabled: false } });
  await wsOnly.api.restart();
  assert.equal((await request(wsOnly.port(), { path: '/api/v1/state' })).status, 404);
  const { client, messages } = await connect(wsOnly.port());
  await until(() => messages.length === 1, 'the snapshot arrives without HTTP');
  client.terminate();

  const httpOnly = harness(t, { settings: { wsEnabled: false } });
  await httpOnly.api.restart();
  await assert.rejects(connect(httpOnly.port()));
});

test('a WebSocket client that sends anything is closed with 1008', { timeout: 10_000 }, async t => {
  const { api } = harness(t);
  await api.restart();
  const { client, messages } = await connect(api.getInfo().port);
  const result = closed(client);
  client.send('{"type":"command","action":"skip"}');
  assert.deepEqual(await result, { code: 1008, reason: 'read-only' });
  assert.equal(messages[0].type, 'state');
});

test('oversized frames are rejected without crashing the server', { timeout: 10_000 }, async t => {
  const { api } = harness(t);
  await api.restart();
  const port = api.getInfo().port;
  const uncaught = [];
  const onUncaught = error => uncaught.push(error);
  process.on('uncaughtException', onUncaught);
  t.after(() => process.off('uncaughtException', onUncaught));
  const { client } = await connect(port);
  client.on('error', () => {});
  const result = closed(client);
  client.send('x'.repeat(5000));
  const { code } = await result;
  assert.ok(code === 1009 || code === 1006, `closed with ${code}`);
  await wait(20);
  assert.deepEqual(uncaught, []);
  assert.equal((await request(port)).status, 200);
  const next = await connect(port);
  next.client.send('y'.repeat(4096 + 1));
  next.client.on('error', () => {});
  assert.ok([1009, 1006].includes((await closed(next.client)).code));
});

test('the broadcast is sent only when the state changes', { timeout: 10_000 }, async t => {
  const { api, setState } = harness(t);
  await api.restart();
  const port = api.getInfo().port;
  const { client, messages } = await connect(port);
  await until(() => messages.length >= 1, 'the initial snapshot arrives');
  await wait(BROADCAST_MS * 8);
  assert.equal(messages.length, 1, 'a new timestamp alone is not a change');

  setState({ queue: [{ id: '2', title: 'Next' }], queueLength: 1 });
  await until(() => messages.length >= 2, 'the change is broadcast');
  await wait(BROADCAST_MS * 8);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].data.queueLength, 1);

  // A client that connects after a change gets it once, as does everyone else.
  setState({ queue: [], queueLength: 0, accepting: false });
  const late = await connect(port);
  await until(() => late.messages.length >= 1 && messages.length >= 3, 'both clients see the change');
  await wait(BROADCAST_MS * 8);
  assert.equal(late.messages.length, 1);
  assert.equal(late.messages[0].data.accepting, false);
  assert.equal(messages.length, 3);
  assert.equal(messages[2].data.accepting, false);
  client.terminate();
  late.client.terminate();
});

test('stop resolves promptly with open clients', { timeout: 10_000 }, async t => {
  const { api } = harness(t, { closeGraceMs: 200 });
  await api.restart();
  const port = api.getInfo().port;
  const { client } = await connect(port);
  const result = closed(client);
  let started = Date.now();
  await api.stop();
  assert.ok(Date.now() - started < 1000, `well-behaved client: ${Date.now() - started} ms`);
  assert.equal((await result).code, 1001);

  await api.restart();
  const frozen = await connectUnresponsive(api.getInfo().port);
  started = Date.now();
  await api.stop();
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 150 && elapsed < 1500, `unresponsive client terminated after ${elapsed} ms`);
  frozen.destroy();
  await assert.rejects(request(port));
});

test('the heartbeat drops clients that stop answering pings', { timeout: 10_000 }, async t => {
  const { api } = harness(t, { heartbeatIntervalMs: 100 });
  await api.restart();
  const port = api.getInfo().port;
  const healthy = await connect(port);
  const frozen = await connectUnresponsive(port);
  // The first tick pings, the next one finds no pong and terminates.
  await new Promise(resolve => frozen.once('close', resolve));
  await wait(250);
  assert.equal(healthy.client.readyState, WebSocket.OPEN, 'a client that answers pings stays');
  healthy.client.terminate();
});

test('main delegates to the extracted server and exposes the bind error', () => {
  const main = readSource('electron/main.ts');
  assert.doesNotMatch(main, /new WebSocketServer|externalBroadcastTimer|externalWebSocketServer/);
  assert.match(main, /const externalApi = createExternalApiServer\(\{/);
  assert.match(sliceBetween(main, 'function restartExternalApiServer', '\n}\n'), /return externalApi\.restart\(\);/);
  assert.match(sliceBetween(main, 'function stopExternalApiServer', '\n}\n'), /return externalApi\.stop\(\);/);
  const config = sliceBetween(main, 'externalApi: {', '},');
  assert.match(config, /running: externalApiInfo\.running/);
  assert.match(config, /error: externalApiInfo\.error/);
});
