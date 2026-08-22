import type { Server } from 'node:http';

export const DEFAULT_INTERNAL_API_PORT = 5555;
export const DEFAULT_EXTERNAL_API_PORT = 5556;
export const MIN_LOCAL_API_PORT = 1024;
export const MAX_LOCAL_API_PORT = 65535;

export function isValidLocalApiPort(value: unknown): value is number {
  return (
    typeof value === 'number'
    && Number.isInteger(value)
    && value >= MIN_LOCAL_API_PORT
    && value <= MAX_LOCAL_API_PORT
  );
}

export function normalizeLocalApiPort(
  value: unknown,
  fallback: number = DEFAULT_INTERNAL_API_PORT
): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return isValidLocalApiPort(parsed) ? parsed : fallback;
}

export function buildLocalApiOrigin(port: number): string {
  return `http://127.0.0.1:${normalizeLocalApiPort(port)}`;
}

export interface LocalApiListenResult {
  requestedPort: number;
  actualPort: number;
  fallback: boolean;
  reason?: 'conflict' | 'reserved';
}

const MAX_STABLE_FALLBACK_ATTEMPTS = 128;

interface ListenError extends Error {
  code?: string;
}

function listenOnce(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      cleanup();
      const address = server.address();
      if (!address || typeof address === 'string' || !Number.isInteger(address.port)) {
        reject(new Error('本地 API 服务已监听，但无法读取实际端口'));
        return;
      }
      resolve(address.port);
    };
    const onError = (error: ListenError) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      server.removeListener('listening', onListening);
      server.removeListener('error', onError);
    };

    server.once('listening', onListening);
    server.once('error', onError);
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Listen on the requested loopback port, falling back to an OS-selected port
 * only for a known port conflict or an explicitly reserved port.
 */
export async function listenLoopbackWithFallback(
  server: Server,
  requestedPort: number,
  reservedPorts: readonly number[] = []
): Promise<LocalApiListenResult> {
  const requested = normalizeLocalApiPort(requestedPort);
  const isReserved = reservedPorts.includes(requested);
  if (isReserved) {
    const actualPort = await listenStableFallback(server, requested, reservedPorts);
    return { requestedPort: requested, actualPort, fallback: true, reason: 'reserved' };
  }

  try {
    const actualPort = await listenOnce(server, requested);
    return { requestedPort: requested, actualPort, fallback: false };
  } catch (error: unknown) {
    const code = (error as ListenError | null)?.code;
    if (code !== 'EADDRINUSE') throw error;
    const actualPort = await listenStableFallback(server, requested, reservedPorts);
    return { requestedPort: requested, actualPort, fallback: true, reason: 'conflict' };
  }
}

async function listenStableFallback(
  server: Server,
  requestedPort: number,
  reservedPorts: readonly number[]
): Promise<number> {
  const reserved = new Set(reservedPorts);
  reserved.add(requestedPort);
  for (let offset = 1; offset <= MAX_STABLE_FALLBACK_ATTEMPTS; offset += 1) {
    const candidate = MIN_LOCAL_API_PORT
      + ((requestedPort - MIN_LOCAL_API_PORT + offset) % (MAX_LOCAL_API_PORT - MIN_LOCAL_API_PORT + 1));
    if (reserved.has(candidate)) continue;
    try {
      return await listenOnce(server, candidate);
    } catch (error: unknown) {
      if ((error as ListenError | null)?.code === 'EADDRINUSE') continue;
      throw error;
    }
  }
  // 极端情况下候选端口都被占用，再交给操作系统挑选最后的可用端口。
  return listenOnce(server, 0);
}
