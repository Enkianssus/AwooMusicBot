import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';
import test from 'node:test';
import ts from 'typescript';
import * as policy from '../electron/gift-request-credit-policy.ts';

// Exercise the actual socket dispatch, learning and credit functions without
// starting Electron, connecting to a room, or sending any live messages.
const main = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true);
const names = ['parseBiliPacket', 'handleRawDanmaku', 'handleGiftEvent', 'applyGiftCreditEvent',
  'claimGiftEvent', 'captureGiftForLearning', 'getGiftRequirementForGuardLevel', 'reportGiftParseDiagnostic',
  'isGiftLearningActive', 'startGiftLearning', 'stopGiftLearning', 'getGiftLearningState',
  'createGiftLearningDiagnostics', 'reportGiftTransportIssue'];
const source = names.map(name => {
  const declaration = parsed.statements.find(value => ts.isFunctionDeclaration(value) && value.name?.text === name);
  assert.ok(declaration, name);
  return declaration.getText(parsed);
}).join('\n');
const javascript = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }
}).outputText;

function fixture({ learning = true, connection = 'connected' } = {}) {
  let now = 2_000_000;
  const logs = [], commands = [];
  const context = vm.createContext({
    ...policy, Buffer, zlib, Date: { now: () => now },
    giftRequestCredits: new Map(), recentGiftEvents: new Map(), recentGiftParseDiagnostics: new Map(),
    giftLearningCaptured: [], MAX_GIFT_LEARNING_SESSION_ITEMS: 20,
    giftLearningStartedAt: 0, giftLearningExpiresAt: 0, GIFT_LEARNING_DURATION_MS: 60_000,
    biliRoomState: { realRoomId: '42', status: connection },
    appConfig: { roomId: '42', roomConnectionEnabled: connection !== 'disconnected', learnedGifts: [], sysConfig: {
      ShowAllDanmaku: true, GiftRequestRequirements: {
        Normal: { giftId: '1' }, Captain: { giftId: '2' },
        Admiral: { giftId: '3' }, Governor: { giftId: '4' }
      }
    } },
    scheduleGiftLibrarySave() {},
    writeLog: message => logs.push(message), setGlobalStatus() {},
    enqueueDanmakuCommand: (user, message) => commands.push({ user, message })
  });
  new vm.Script(javascript).runInContext(context);
  context.giftLearningDiagnostics = context.createGiftLearningDiagnostics();
  if (learning) context.startGiftLearning();
  return { context, logs, commands, advance: milliseconds => { now += milliseconds; } };
}

function varint(value) {
  let remaining = BigInt(value);
  const bytes = [];
  do {
    const byte = Number(remaining & 127n);
    remaining >>= 7n;
    bytes.push(byte | (remaining ? 128 : 0));
  } while (remaining);
  return Buffer.from(bytes);
}
const integer = (field, value) => Buffer.concat([varint(field * 8), varint(value)]);
const bytes = (field, value) => {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([varint(field * 8 + 2), varint(buffer.length), buffer]);
};
function gift({ id = 1, quantity = 1, tid = 'transaction', rnd = '' } = {}) {
  return Buffer.concat([integer(1, id), bytes(2, `礼物${id}`), integer(3, quantity),
    bytes(9, tid), bytes(12, rnd)]);
}
function v2(items, guard = 0) {
  return { cmd: 'SEND_GIFT_V2:1', data: { pb: Buffer.concat([
    integer(1, '9007199254740993'), bytes(2, '测试观众'), integer(5, guard),
    ...items.map(item => bytes(10, item))
  ]).toString('base64') } };
}
function packet(payload, protocol = 0) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  const header = Buffer.alloc(16);
  header.writeInt32BE(16 + body.length);
  header.writeInt16BE(16, 4);
  header.writeInt16BE(protocol, 6);
  header.writeInt32BE(5, 8);
  header.writeInt32BE(1, 12);
  return Buffer.concat([header, body]);
}

for (const protocol of [0, 2, 3]) {
  test(`socket protocol ${protocol} processes every gift once and keeps the next danmaku`, () => {
    const f = fixture();
    const doc = v2([gift({ id: 2 }), gift({ quantity: 2 }), gift({ quantity: 3 })]);
    const danmaku = { cmd: 'DANMU_MSG:4:0:2', info: [[], '点歌 测试', ['99', '观众', 0], [], [], [], [], 0] };
    let frame = Buffer.concat([packet(doc), packet(danmaku)]);
    if (protocol === 2) frame = packet(zlib.deflateSync(frame), 2);
    if (protocol === 3) frame = packet(zlib.brotliCompressSync(frame), 3);
    f.context.parseBiliPacket(frame);
    assert.equal(f.context.giftRequestCredits.get('9007199254740993'), 5);
    assert.equal(f.context.appConfig.learnedGifts.length, 2);
    assert.equal(f.commands[0].message, '点歌 测试');
    f.context.parseBiliPacket(frame);
    assert.equal(f.context.giftRequestCredits.get('9007199254740993'), 5);
    assert.ok(f.logs.every(log => !log.includes(doc.data.pb)));
  });
}

test('all four viewer tiers use their configured gift and only the real quantity', () => {
  for (const [guard, id] of [[0, 1], [3, 2], [2, 3], [1, 4]]) {
    const f = fixture();
    f.context.handleRawDanmaku(v2([gift({ id, quantity: 7 })], guard));
    assert.equal(f.context.giftRequestCredits.get('9007199254740993'), 7);
    assert.equal(f.context.appConfig.learnedGifts[0].lastQuantity, 7);
  }
});

test('damaged gift item cannot discard its valid neighbor or leak protobuf into logs', () => {
  const f = fixture();
  const doc = v2([Buffer.from([0x08, 0x80]), gift({ quantity: 4 })]);
  f.context.handleRawDanmaku(doc);
  assert.equal(f.context.giftRequestCredits.get('9007199254740993'), 4);
  assert.equal(f.context.appConfig.learnedGifts.length, 1);
  assert.ok(f.logs.some(log => log.includes('已跳过无法识别')));
  f.context.handleRawDanmaku({ cmd: 'SEND_GIFT_V2', data: { pb: 'private-invalid-protobuf!' } });
  assert.equal(f.context.giftRequestCredits.get('9007199254740993'), 4);
  assert.ok(f.logs.every(log => !log.includes('private-invalid-protobuf')));
});

test('a duplicate first item does not prevent a new later gift from being credited', () => {
  const f = fixture();
  f.context.handleRawDanmaku(v2([gift({ tid: 'old' })]));
  f.context.handleRawDanmaku(v2([gift({ tid: 'old' }), gift({ tid: 'new', quantity: 3 })]));
  assert.equal(f.context.giftRequestCredits.get('9007199254740993'), 4);
});

test('replaying a maximum-sized batch cannot evict its own deduplication entries', () => {
  const f = fixture();
  const doc = v2(Array.from({ length: 1024 }, (_, index) => gift({ tid: `batch-${index}` })));
  f.context.handleRawDanmaku(doc);
  assert.equal(f.context.giftRequestCredits.get('9007199254740993'), 1024);
  f.context.handleRawDanmaku(doc);
  assert.equal(f.context.giftRequestCredits.get('9007199254740993'), 1024);
});

test('transaction replay is room scoped; gifts without transaction IDs use a short window', () => {
  const f = fixture();
  const doc = v2([gift()]);
  f.context.handleRawDanmaku(doc);
  f.context.biliRoomState.realRoomId = '43';
  f.context.handleRawDanmaku(doc);
  assert.equal(f.context.giftRequestCredits.get('9007199254740993'), 2);
  const noId = v2([gift({ tid: '', rnd: '' })]);
  f.context.handleRawDanmaku(noId);
  f.context.handleRawDanmaku(noId);
  assert.equal(f.context.giftRequestCredits.get('9007199254740993'), 3);
  f.advance(3_001);
  f.context.handleRawDanmaku(noId);
  assert.equal(f.context.giftRequestCredits.get('9007199254740993'), 4);
});

test('legacy suffixed gifts work and cumulative COMBO_SEND never grants credits', () => {
  const f = fixture();
  const data = { uid: '7', uname: '测试', giftId: 1, giftName: '礼物1', num: 2,
    combo_num: 999, blind_gift: { original_gift_price: 10000 }, rnd: '', tid: 'legacy' };
  f.context.handleRawDanmaku({ cmd: 'SEND_GIFT:1', data });
  f.context.handleRawDanmaku({ cmd: 'COMBO_SEND', data });
  f.context.handleRawDanmaku({ cmd: 'SEND_GIFT', data });
  assert.equal(f.context.giftRequestCredits.get('7'), 2);
});

test('legacy and V2 replays share transaction identity even if rnd differs', () => {
  for (const reverse of [false, true]) {
    const f = fixture();
    const legacy = { cmd: 'SEND_GIFT', data: { uid: '9007199254740993', giftId: 1,
      giftName: '礼物1', num: 2, tid: 'same-transaction', rnd: 'legacy-rnd' } };
    const modern = v2([gift({ quantity: 2, tid: 'same-transaction', rnd: 'modern-rnd' })]);
    const events = reverse ? [modern, legacy] : [legacy, modern];
    for (const doc of events) f.context.handleRawDanmaku(doc);
    assert.equal(f.context.giftRequestCredits.get('9007199254740993'), 2);
    f.context.handleRawDanmaku(v2([gift({ quantity: 3, tid: 'new-transaction', rnd: 'modern-rnd' })]));
    assert.equal(f.context.giftRequestCredits.get('9007199254740993'), 5);
  }
});

test('invalid socket headers and unsupported commands cannot grant gifts', () => {
  const f = fixture();
  for (const headerLength of [0, 15, 32767]) {
    const frame = packet(v2([gift()]));
    frame.writeInt16BE(headerLength, 4);
    f.context.parseBiliPacket(frame);
  }
  f.context.handleRawDanmaku(null);
  f.context.handleRawDanmaku({ cmd: {}, data: {} });
  assert.equal(f.context.giftRequestCredits.size, 0);
});

test('learning only starts after the room is connected, then stops capturing at expiry', () => {
  for (const connection of ['disconnected', 'connecting', 'error']) {
    const f = fixture({ learning: false, connection });
    assert.equal(f.context.startGiftLearning().success, false);
    assert.equal(f.context.getGiftLearningState().active, false);
    assert.equal(f.context.giftLearningExpiresAt, 0);
  }
  const f = fixture({ learning: false });
  assert.equal(f.context.startGiftLearning().success, true);
  f.context.handleRawDanmaku(v2([gift({ tid: 'before-expiry' })]));
  assert.equal(f.context.getGiftLearningState().capturedGifts.length, 1);
  f.advance(60_001);
  f.context.handleRawDanmaku(v2([gift({ id: 2, tid: 'after-expiry' })]));
  assert.equal(f.context.getGiftLearningState().active, false);
  assert.equal(f.context.getGiftLearningState().capturedGifts.length, 1);
});

test('learning a previously credited transaction does not grant duplicate credits', () => {
  const f = fixture({ learning: false });
  const doc = v2([gift({ quantity: 3 })]);
  f.context.handleRawDanmaku(doc);
  assert.equal(f.context.giftRequestCredits.get('9007199254740993'), 3);
  assert.equal(f.context.appConfig.learnedGifts.length, 0);
  f.context.startGiftLearning();
  f.context.handleRawDanmaku(doc);
  assert.equal(f.context.getGiftLearningState().capturedGifts.length, 1);
  assert.equal(f.context.giftRequestCredits.get('9007199254740993'), 3);
});

test('combo hints teach gift metadata without granting cumulative credits', () => {
  const f = fixture();
  f.context.handleRawDanmaku({ cmd: 'COMBO_SEND', data: {} });
  assert.notEqual(f.context.getGiftLearningState().diagnostics.lastIssue, '');
  const doc = { cmd: 'COMBO_SEND:1', data: {
    gift_id: 31036, gift_name: '测试礼物', gift_num: 0, combo_num: 99,
    uid: 'private-sender', uname: 'private-name'
  } };
  f.context.handleRawDanmaku(doc);
  f.context.handleRawDanmaku(doc);
  assert.equal(f.context.giftRequestCredits.size, 0);
  const state = f.context.getGiftLearningState();
  assert.equal(state.capturedGifts.length, 1);
  assert.equal(state.capturedGifts[0].giftId, '31036');
  assert.equal(state.capturedGifts[0].lastQuantity, 99);
  assert.equal(state.diagnostics.giftMessagesReceived, 3);
  assert.equal(state.diagnostics.lastIssue, '');
  assert.equal(state.diagnostics.lastCommand, 'COMBO_SEND');
  assert(!JSON.stringify(state).includes('private-'));
  f.context.stopGiftLearning();
  f.context.handleRawDanmaku({ cmd: 'COMBO_SEND', data: { gift_id: 7, gift_name: '停止后的礼物' } });
  assert.equal(f.context.appConfig.learnedGifts.length, 1);
});

test('learning diagnostics distinguish ordinary messages, gift parse failures and unreadable frames', () => {
  const f = fixture();
  f.context.handleRawDanmaku({ cmd: 'ONLINE_RANK_COUNT', data: {} });
  assert.equal(f.context.getGiftLearningState().diagnostics.messagesReceived, 1);
  assert.equal(f.context.getGiftLearningState().diagnostics.giftMessagesReceived, 0);
  f.context.handleRawDanmaku({ cmd: 'SEND_GIFT_V2', data: { pb: 'PRIVATE-BAD-DATA!' } });
  let diagnostics = f.context.getGiftLearningState().diagnostics;
  assert.equal(diagnostics.giftMessagesReceived, 1);
  assert.equal(diagnostics.parsedGifts, 0);
  assert.match(diagnostics.lastIssue, /invalid-base64/);
  f.context.parseBiliPacket(packet(Buffer.from('PRIVATE-BAD-DATA!'), 3));
  diagnostics = f.context.getGiftLearningState().diagnostics;
  assert.match(diagnostics.lastIssue, /解压失败/);
  assert(!JSON.stringify(diagnostics).includes('PRIVATE'));
  assert(f.logs.every(log => !log.includes('PRIVATE')));
  f.context.startGiftLearning();
  assert.equal(f.context.getGiftLearningState().diagnostics.messagesReceived, 0);
  assert.equal(f.context.getGiftLearningState().diagnostics.lastIssue, '');
});

test('compressed JSON command batches route gifts even after an invalid sibling', () => {
  const f = fixture();
  const batch = [
    { cmd: 'DANMU_MSG', info: null },
    { cmd: 'ONLINE_RANK_COUNT', data: {} },
    { ...v2([gift({ quantity: 2 })]), cmd: ' SEND_GIFT_V2:1' }
  ];
  const inner = packet(Buffer.from(JSON.stringify(batch)));
  const frame = packet(zlib.brotliCompressSync(inner), 3);
  f.context.parseBiliPacket(frame);
  assert.equal(f.context.giftRequestCredits.get('9007199254740993'), 2);
  assert.equal(f.context.getGiftLearningState().capturedGifts.length, 1);
  const diagnostics = f.context.getGiftLearningState().diagnostics;
  assert.equal(diagnostics.messagesReceived, 3);
  assert.equal(diagnostics.commandCounts.SEND_GIFT_V2, 1);
  assert.equal(diagnostics.packetCounts['5/3'], 1);
  assert.equal(diagnostics.packetCounts['5/0'], 1);
  f.context.parseBiliPacket(frame);
  assert.equal(f.context.giftRequestCredits.get('9007199254740993'), 2);
});

test('gift-star widget progress is diagnostic metadata and never a gift transaction', () => {
  const f = fixture();
  f.context.handleRawDanmaku({ cmd: 'WIDGET_GIFT_STAR_PROCESS_V2', data: {
    process_list: [{ gift_id: 31036, gift_name: '礼物星球', completed_num: 50 }],
    private_body: 'PRIVATE-CONTENT'
  } });
  const state = f.context.getGiftLearningState();
  assert.equal(state.diagnostics.messagesReceived, 1);
  assert.equal(state.diagnostics.giftMessagesReceived, 0);
  assert.equal(state.diagnostics.parsedGifts, 0);
  assert.equal(state.diagnostics.commandCounts.WIDGET_GIFT_STAR_PROCESS_V2, 1);
  assert.equal(state.capturedGifts.length, 0);
  assert.equal(f.context.giftRequestCredits.size, 0);
  assert(!JSON.stringify(state).includes('PRIVATE-CONTENT'));
  state.diagnostics.commandCounts.WIDGET_GIFT_STAR_PROCESS_V2 = 999;
  assert.equal(f.context.getGiftLearningState().diagnostics.commandCounts.WIDGET_GIFT_STAR_PROCESS_V2, 1);
});

test('unrecognized JSON and operations are visible with bounded metadata and reset between sessions', () => {
  const f = fixture();
  f.context.parseBiliPacket(packet(Buffer.from(JSON.stringify({ private_body: 'PRIVATE-CONTENT' }))));
  const unknownPacket = packet(Buffer.from('PRIVATE-CONTENT'));
  unknownPacket.writeInt32BE(1000, 8);
  f.context.parseBiliPacket(unknownPacket);
  f.context.handleRawDanmaku({ cmd: 'TOKEN_PRIVATE_CONTENT' });
  for (let i = 0; i < 100; i++) f.context.handleRawDanmaku({ cmd: `COMMAND_${i}` });
  const diagnostics = f.context.getGiftLearningState().diagnostics;
  assert.equal(diagnostics.unrecognizedMessages, 1);
  assert.equal(diagnostics.packetCounts['1000/0'], 1);
  assert.match(diagnostics.lastIssue, /op=1000/);
  assert.equal(Object.keys(diagnostics.commandCounts).length, 64);
  assert(!JSON.stringify(diagnostics).includes('PRIVATE'));
  f.context.startGiftLearning();
  const fresh = f.context.getGiftLearningState().diagnostics;
  assert.equal(fresh.unrecognizedMessages, 0);
  assert.equal(Object.keys(fresh.commandCounts).length, 0);
  assert.equal(Object.keys(fresh.packetCounts).length, 0);
});
