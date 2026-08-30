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
