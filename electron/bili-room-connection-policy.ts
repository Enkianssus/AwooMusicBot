export type BiliRoomConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

export interface BiliRoomConnectionState {
  session: number;
  status: BiliRoomConnectionStatus;
  requestedRoomId: number;
  realRoomId: number;
  message: string;
}

export type BiliRoomConnectionEvent =
  | {
      type: 'connect-requested';
      session: number;
      requestedRoomId: number;
    }
  | {
      type: 'room-resolved';
      session: number;
      realRoomId: number;
    }
  | {
      type: 'websocket-authenticated';
      session: number;
      realRoomId: number;
    }
  | {
      type: 'socket-reconnecting';
      session: number;
      message?: string;
    }
  | {
      type: 'connection-failed';
      session: number;
      message: string;
    }
  | {
      type: 'disconnect-requested';
      session: number;
      requestedRoomId?: number;
      message?: string;
    };

export const BILI_ROOM_CONNECTION_MESSAGES = {
  connecting: '正在连接',
  connected: '弹幕已连接',
  disconnected: '已断开连接',
  failed: '连接失败'
} as const;

export function createBiliRoomConnectionState(
  requestedRoomId = 0
): BiliRoomConnectionState {
  return {
    session: 0,
    status: 'disconnected',
    requestedRoomId: normalizeRoomId(requestedRoomId),
    realRoomId: 0,
    message: BILI_ROOM_CONNECTION_MESSAGES.disconnected
  };
}

function normalizeRoomId(value: unknown): number {
  const roomId = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : 0;
  return Number.isSafeInteger(roomId) && roomId > 0 ? roomId : 0;
}

/**
 * Reduce only the room connection lifecycle. Network responses and WebSocket
 * callbacks carry a session so a stale close/timer cannot resurrect a room
 * after the user has disconnected or selected another room.
 */
export function reduceBiliRoomConnectionState(
  state: BiliRoomConnectionState,
  event: BiliRoomConnectionEvent
): BiliRoomConnectionState {
  if (event.type === 'connect-requested') {
    return {
      session: event.session,
      status: 'connecting',
      requestedRoomId: normalizeRoomId(event.requestedRoomId),
      realRoomId: 0,
      message: BILI_ROOM_CONNECTION_MESSAGES.connecting
    };
  }

  // Disconnect allocates the next generation and must invalidate callbacks
  // from the previous socket. An old close/disconnect event is ignored.
  if (event.type === 'disconnect-requested') {
    if (event.session <= state.session) return state;
    return {
      ...state,
      session: event.session,
      status: 'disconnected',
      requestedRoomId: event.requestedRoomId === undefined
        ? state.requestedRoomId
        : normalizeRoomId(event.requestedRoomId),
      // Keep the resolved room visible after a manual disconnect. A new
      // connect request clears it before resolving the next room.
      realRoomId: state.realRoomId,
      message: event.message?.trim() || BILI_ROOM_CONNECTION_MESSAGES.disconnected
    };
  }

  if (event.session !== state.session) return state;

  switch (event.type) {
    case 'room-resolved':
      return {
        ...state,
        realRoomId: normalizeRoomId(event.realRoomId)
      };
    case 'websocket-authenticated':
      return {
        ...state,
        status: 'connected',
        realRoomId: normalizeRoomId(event.realRoomId) || state.realRoomId,
        message: BILI_ROOM_CONNECTION_MESSAGES.connected
      };
    case 'socket-reconnecting':
      return {
        ...state,
        status: 'connecting',
        message: event.message?.trim() || BILI_ROOM_CONNECTION_MESSAGES.connecting
      };
    case 'connection-failed':
      return {
        ...state,
        status: 'error',
        message: event.message.trim() || BILI_ROOM_CONNECTION_MESSAGES.failed
      };
    default:
      return state;
  }
}

/**
 * The server answers every 30 s heartbeat (op=2) with op=3, so an
 * authenticated socket that has received nothing for this long is a dead,
 * half-open connection even though it still looks open.
 */
export const BILI_SOCKET_SILENCE_TIMEOUT_MS = 70_000;

/**
 * Waits before the danmaku token and host list are fetched again after a
 * whole round of endpoints failed; the last entry is the cap.
 */
export const BILI_ROOM_REFRESH_DELAYS_MS: readonly number[] = [5000, 15000, 30000, 60000];

/** Whether the socket has been silent for at least `timeoutMs` (invalid times never trigger it). */
export function shouldReconnectForSilence(
  lastPacketAt: number,
  now: number,
  timeoutMs = BILI_SOCKET_SILENCE_TIMEOUT_MS
): boolean {
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : BILI_SOCKET_SILENCE_TIMEOUT_MS;
  if (!Number.isFinite(lastPacketAt) || !Number.isFinite(now)) return false;
  return now - lastPacketAt >= timeout;
}

/** The wait before refresh number `attempt` (0 for the first since the last successful authentication). */
export function nextRoomRefreshDelayMs(attempt: number): number {
  const steps = BILI_ROOM_REFRESH_DELAYS_MS;
  const index = attempt >= 0 ? Math.min(Math.floor(attempt), steps.length - 1) : 0;
  return steps[index];
}
