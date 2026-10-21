/**
 * External read-only API (default port 5556): JSON state for OBS pages, the
 * Mod UI host under /overlay/ and a WebSocket that pushes state changes.
 *
 * Restarts and stops run one at a time on a promise chain, and a generation
 * counter keeps callbacks of a replaced server away from the current one.
 * Overlapping settings saves therefore can no longer orphan a listening
 * server or its broadcast timer.  The WebSocket is read-only: inbound
 * messages close the connection, frames are capped at 4 KiB and dead clients
 * are dropped by a ping/pong heartbeat.
 *
 * No Electron import: settings, state and the overlay host are injected.
 */
import http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { ExternalApiState } from './external-api-state.ts';
import { isLoopbackHostHeader } from './internal-api-trust-policy.ts';

export interface ExternalApiSettings {
  httpEnabled: boolean;
  wsEnabled: boolean;
  port: number;
}

export interface ExternalApiServerOptions {
  getSettings: () => ExternalApiSettings;
  appVersion: string;
  buildState: () => ExternalApiState;
  getOverlayPublicState: () => Promise<unknown>;
  serveOverlay: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string
  ) => Promise<boolean>;
  log: (message: string, color: string) => void;
  broadcastIntervalMs?: number;
  heartbeatIntervalMs?: number;
  /** How long closing clients may take before they are terminated on stop. */
  closeGraceMs?: number;
}

export interface ExternalApiServerInfo {
  running: boolean;
  /** The listening port, or the port that failed to bind. */
  port: number | null;
  /** The last bind or runtime error code, e.g. 'EADDRINUSE'. */
  error: string | null;
}

export interface ExternalApiServer {
  restart(): Promise<void>;
  stop(): Promise<void>;
  getInfo(): ExternalApiServerInfo;
}

export const EXTERNAL_WEBSOCKET_MAX_PAYLOAD_BYTES = 4096;
export const EXTERNAL_WEBSOCKET_HEARTBEAT_MS = 30_000;

interface ActiveServer {
  server: http.Server;
  sockets: WebSocketServer;
  timers: NodeJS.Timeout[];
}

function listeningPort(server: http.Server): number | null {
  const address = server.address();
  return address && typeof address === 'object' ? address.port : null;
}

function describeError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code) return code;
  return error instanceof Error ? error.message : String(error);
}

function listen(server: http.Server, port: number): Promise<Error | null> {
  return new Promise(resolve => {
    const onListening = () => {
      server.off('error', onError);
      resolve(null);
    };
    const onError = (error: Error) => {
      server.off('listening', onListening);
      resolve(error);
    };
    server.once('listening', onListening);
    server.once('error', onError);
    server.listen(port, '127.0.0.1');
  });
}

function rejectUpgrade(socket: Duplex): void {
  socket.on('error', () => socket.destroy());
  socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
}

export function createExternalApiServer({
  getSettings,
  appVersion,
  buildState,
  getOverlayPublicState,
  serveOverlay,
  log,
  broadcastIntervalMs = 250,
  heartbeatIntervalMs = EXTERNAL_WEBSOCKET_HEARTBEAT_MS,
  closeGraceMs = 1000
}: ExternalApiServerOptions): ExternalApiServer {
  let generation = 0;
  let active: ActiveServer | null = null;
  let info: ExternalApiServerInfo = { running: false, port: null, error: null };
  let lastFingerprint = '';
  let tail: Promise<void> = Promise.resolve();
  let queuedRestart: Promise<void> | null = null;
  const awaitingPong = new WeakSet<WebSocket>();

  function enqueue(task: () => Promise<void>): Promise<void> {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  }

  function isCurrent(server: http.Server, serverGeneration: number): boolean {
    return active?.server === server && serverGeneration === generation;
  }

  async function handleRequest(
    server: http.Server,
    settings: ExternalApiSettings,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    if (!isLoopbackHostHeader(req.headers.host, listeningPort(server))) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Invalid host');
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (!settings.httpEnabled || req.method !== 'GET') {
      res.writeHead(404);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/overlay') {
      res.writeHead(302, { Location: `/overlay/${url.search}` });
      res.end();
      return;
    }
    if (await serveOverlay(req, res, url.pathname)) return;

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (url.pathname === '/health') {
      res.end(JSON.stringify({ ok: true, schemaVersion: 1, version: appVersion }));
      return;
    }

    if (url.pathname === '/api/v1/overlay') {
      res.end(JSON.stringify(await getOverlayPublicState()));
      return;
    }

    const state = buildState();
    if (url.pathname === '/api/v1/state') {
      res.end(JSON.stringify(state));
      return;
    }
    if (url.pathname === '/api/v1/current') {
      res.end(JSON.stringify({
        schemaVersion: state.schemaVersion,
        appVersion: state.appVersion,
        timestamp: state.timestamp,
        player: state.player,
        current: state.current,
        currentIsRequested: state.currentIsRequested,
        service: state.service
      }));
      return;
    }
    if (url.pathname === '/api/v1/queue') {
      res.end(JSON.stringify({
        schemaVersion: state.schemaVersion,
        appVersion: state.appVersion,
        timestamp: state.timestamp,
        queue: state.queue,
        queueLength: state.queueLength,
        requestNotifications: state.requestNotifications,
        service: state.service
      }));
      return;
    }
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not_found' }));
  }

  function sendToOpenClients(sockets: WebSocketServer, payload: string): void {
    for (const client of sockets.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  function acceptClient(sockets: WebSocketServer, client: WebSocket): void {
    client.on('error', () => client.terminate());
    // The API is read-only; a client that sends anything is disconnected.
    client.on('message', () => client.close(1008, 'read-only'));
    client.on('pong', () => awaitingPong.delete(client));
    let state: ExternalApiState;
    try {
      state = buildState();
    } catch {
      client.close(1011, 'state unavailable');
      return;
    }
    const fingerprint = JSON.stringify({ ...state, timestamp: '' });
    const payload = JSON.stringify({ type: 'state', data: state });
    if (fingerprint === lastFingerprint) {
      client.send(payload);
      return;
    }
    // A change not broadcast yet goes to every client now, so the next tick
    // does not repeat it to the newcomer.
    lastFingerprint = fingerprint;
    sendToOpenClients(sockets, payload);
  }

  function broadcast(current: ActiveServer): void {
    if (active !== current || current.sockets.clients.size === 0) return;
    let state: ExternalApiState;
    try {
      state = buildState();
    } catch {
      return;
    }
    // A new timestamp alone is not a change; serialize the payload only for real changes.
    const fingerprint = JSON.stringify({ ...state, timestamp: '' });
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    sendToOpenClients(current.sockets, JSON.stringify({ type: 'state', data: state }));
  }

  function heartbeat(current: ActiveServer): void {
    for (const client of current.sockets.clients) {
      if (awaitingPong.has(client)) {
        client.terminate();
        continue;
      }
      awaitingPong.add(client);
      try {
        client.ping();
      } catch {
        client.terminate();
      }
    }
  }

  async function closeActive(): Promise<void> {
    generation += 1;
    const current = active;
    active = null;
    lastFingerprint = '';
    info = { running: false, port: null, error: null };
    if (!current) return;
    current.timers.forEach(timer => clearInterval(timer));
    current.timers = [];
    for (const client of current.sockets.clients) client.close(1001, 'server restart');
    // server.close() waits for upgraded sockets, so unresponsive clients are cut off.
    const terminateTimer = setTimeout(() => {
      for (const client of current.sockets.clients) client.terminate();
    }, closeGraceMs);
    current.server.closeAllConnections?.();
    await new Promise<void>(resolve => current.server.close(() => resolve()));
    clearTimeout(terminateTimer);
    current.sockets.close();
  }

  async function start(): Promise<void> {
    const settings = getSettings();
    if (!settings.httpEnabled && !settings.wsEnabled) {
      log('[外部接口] HTTP 与 WebSocket 均已关闭', 'DarkGray');
      return;
    }
    const serverGeneration = generation;
    const server = http.createServer((req, res) => {
      void handleRequest(server, settings, req, res).catch((error: unknown) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        }
        if (!res.writableEnded) {
          res.end(JSON.stringify({ error: 'internal_error', message: describeError(error) }));
        }
      });
    });
    const sockets = new WebSocketServer({
      noServer: true,
      maxPayload: EXTERNAL_WEBSOCKET_MAX_PAYLOAD_BYTES,
      perMessageDeflate: false
    });
    server.on('upgrade', (request: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      if (!isLoopbackHostHeader(request.headers.host, listeningPort(server))) {
        rejectUpgrade(socket);
        return;
      }
      let pathname = '';
      try {
        pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
      } catch {
        pathname = '';
      }
      if (!settings.wsEnabled || pathname !== '/ws' || !isCurrent(server, serverGeneration)) {
        socket.destroy();
        return;
      }
      sockets.handleUpgrade(request, socket, head, client => {
        sockets.emit('connection', client, request);
      });
    });
    sockets.on('connection', client => acceptClient(sockets, client));
    server.on('error', (error: Error) => {
      const current = active;
      if (!current || !isCurrent(server, serverGeneration)) return;
      info = { ...info, running: server.listening, error: describeError(error) };
      log(`[外部接口] 运行中发生错误: ${error.message}`, 'Red');
      if (!server.listening) {
        current.timers.forEach(timer => clearInterval(timer));
        current.timers = [];
      }
    });

    const listenError = await listen(server, settings.port);
    if (serverGeneration !== generation) {
      // Superseded while binding; never publish this server.
      sockets.close();
      if (server.listening) server.close();
      return;
    }
    if (listenError) {
      sockets.close();
      info = { running: false, port: settings.port, error: describeError(listenError) };
      log(`[外部接口] 启动失败: ${listenError.message}`, 'Red');
      return;
    }

    const port = listeningPort(server) ?? settings.port;
    const current: ActiveServer = { server, sockets, timers: [] };
    active = current;
    info = { running: true, port, error: null };
    log(
      `✅ 外部只读接口已启动: ${settings.httpEnabled ? `HTTP http://127.0.0.1:${port}/api/v1/state` : ''}`
      + `${settings.httpEnabled && settings.wsEnabled ? ' | ' : ''}`
      + `${settings.wsEnabled ? `WebSocket ws://127.0.0.1:${port}/ws` : ''}`,
      'Green'
    );
    if (settings.wsEnabled) {
      current.timers.push(
        setInterval(() => broadcast(current), broadcastIntervalMs),
        setInterval(() => heartbeat(current), heartbeatIntervalMs)
      );
    }
  }

  function restart(): Promise<void> {
    // Restarts requested before the queued one begins share it: it reads the
    // settings when it runs, so the latest save always wins.
    if (queuedRestart) return queuedRestart;
    const run: Promise<void> = enqueue(async () => {
      if (queuedRestart === run) queuedRestart = null;
      await closeActive();
      try {
        await start();
      } catch (error: unknown) {
        info = { running: false, port: null, error: describeError(error) };
        log(`[外部接口] 启动失败: ${error instanceof Error ? error.message : String(error)}`, 'Red');
      }
    });
    queuedRestart = run;
    return run;
  }

  function stop(): Promise<void> {
    // A restart requested after this stop must run after it.
    queuedRestart = null;
    return enqueue(closeActive);
  }

  return {
    restart,
    stop,
    getInfo: () => ({ ...info })
  };
}
