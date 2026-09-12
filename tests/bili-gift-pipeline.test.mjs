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
  'claimGiftEvent', 'captureGiftForLearning', 'getGiftRequirementForGuardLevel', 'reportGiftParseDiagnostic'];
const source = names.map(name => {
  const declaration = parsed.statements.find(value => ts.isFunctionDeclaration(value) && value.name?.text === name);
  assert.ok(declaration, name);
  return declaration.getText(parsed);
}).join('\n');
const javascript = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }
}).outputText;

function fixture() {
  let now = 2_000_000;
  const logs = [], commands = [];
  const context = vm.createContext({
    ...policy, Buffer, zlib, Date: { now: () => now },
    giftRequestCredits: new Map(), recentGiftEvents: new Map(), recentGiftParseDiagnostics: new Map(),
    giftLearningCaptured: [], MAX_GIFT_LEARNING_SESSION_ITEMS: 20,
    biliRoomState: { realRoomId: '42' },
    appConfig: { roomId: '42', learnedGifts: [], sysConfig: {
      ShowAllDanmaku: true, GiftRequestRequirements: {
        Normal: { giftId: '1' }, Captain: { giftId: '2' },
        Admiral: { giftId: '3' }, Governor: { giftId: '4' }
      }
    } },
    isGiftLearningActive: () => true, scheduleGiftLibrarySave() {},
    writeLog: message => logs.push(message), setGlobalStatus() {},
    enqueueDanmakuCommand: (user, message) => commands.push({ user, message })
  });
  new vm.Script(javascript).runInContext(context);
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
