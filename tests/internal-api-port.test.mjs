import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildLocalApiOrigin,
  DEFAULT_INTERNAL_API_PORT,
  listenLoopbackWithFallback,
  normalizeLocalApiPort
} from '../electron/internal-api-port.ts';

class FakeServer extends EventEmitter {
  constructor(occupiedPorts = []) {
    super();
    this.occupiedPorts = new Set(occupiedPorts);
    this.currentPort = null;
  }

  listen(port) {
    queueMicrotask(() => {
      if (port !== 0 && this.occupiedPorts.has(port)) {
        const error = new Error(`port ${port} is occupied`);
        error.code = 'EADDRINUSE';
        this.emit('error', error);
        return;
      }
      this.currentPort = port === 0 ? 65000 : port;
      this.emit('listening');
    });
    return this;
  }

  address() {
    return { address: '127.0.0.1', family: 'IPv4', port: this.currentPort };
  }
}

test('normalizes local ports and builds loopback origins', () => {
  assert.equal(normalizeLocalApiPort(undefined), DEFAULT_INTERNAL_API_PORT);
  assert.equal(normalizeLocalApiPort('6000'), 6000);
  assert.equal(normalizeLocalApiPort(1023), DEFAULT_INTERNAL_API_PORT);
  assert.equal(normalizeLocalApiPort(65536), DEFAULT_INTERNAL_API_PORT);
  assert.equal(buildLocalApiOrigin(6000), 'http://127.0.0.1:6000');
});

test('uses a stable next port after a conflict and skips the external port', async () => {
  const server = new FakeServer([5000, 5002]);
  const result = await listenLoopbackWithFallback(server, 5000, [5001]);

  assert.deepEqual(result, {
    requestedPort: 5000,
    actualPort: 5003,
    fallback: true,
    reason: 'conflict'
  });
});

test('skips a reserved requested port without using a random port', async () => {
  const server = new FakeServer();
  const result = await listenLoopbackWithFallback(server, 6000, [6000]);

  assert.deepEqual(result, {
    requestedPort: 6000,
    actualPort: 6001,
    fallback: true,
    reason: 'reserved'
  });
});

test('renderer and main process use the negotiated internal API port', async () => {
  const [appSource, mainSource, preloadSource] = await Promise.all([
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../electron/main.ts', import.meta.url), 'utf8'),
    readFile(new URL('../electron/preload.ts', import.meta.url), 'utf8')
  ]);

  assert.doesNotMatch(appSource, /https?:\/\/(?:127\.0\.0\.1|localhost):5555/);
  assert.match(appSource, /内部控制服务/);
  assert.match(appSource, /InternalApiPort/);
  assert.match(mainSource, /listenLoopbackWithFallback/);
  assert.match(mainSource, /configuredPort:[\s\S]*actualPort:[\s\S]*restartRequired:/);
  assert.match(preloadSource, /get-internal-api-origin/);
});
