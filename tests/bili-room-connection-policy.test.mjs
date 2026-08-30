import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';
import fs from 'node:fs';
import vm from 'node:vm';

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
  createBiliRoomConnectionState,
  reduceBiliRoomConnectionState
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
