import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseBilibiliGiftCreditEvents as parse,
  parseBilibiliGiftCreditEvent as parseOne,
  normalizeGiftQuantity
} from '../electron/gift-request-credit-policy.ts';
import { MAX_BILI_GIFT_ITEMS } from '../electron/bili-gift-protocol.ts';
import {
  decodeBiliBase64,
  parseBiliProtobuf,
  BiliProtobufError,
  MAX_BILI_PROTOBUF_BYTES,
  MAX_BILI_PROTOBUF_FIELDS
} from '../electron/bili-protobuf.ts';
import { biliVarint, biliPbField, biliPbMessage, giftV2Fixture } from './fixtures/bili-gift-protocol.mjs';

const legacy = (data = {}, cmd = 'SEND_GIFT') => ({
  cmd, data: { uid: 42, uname: '测试观众', giftId: 1, giftName: '实际礼物1', num: 2, guard_level: 3, ...data }
});
const reasons = document => {
  const diagnostics = [];
  const events = parse(document, diagnostic => diagnostics.push(diagnostic));
  return { events, diagnostics };
};

test('legacy plural parsing accepts command suffixes and retains count and aliases', () => {
  const [event] = parse(legacy({ giftId: undefined, giftName: undefined, gift_id: '99', gift_name: '礼物', num: '3', combo_num: 999 }, 'SEND_GIFT:1:2'));
  assert.equal(event.giftId, '99');
  assert.equal(event.giftName, '礼物');
  assert.equal(event.quantity, 3);
  assert.equal(event.guardLevel, 3);
  assert.equal(event.eventId, '');
  assert.deepEqual(parse(legacy({}, 'COMBO_SEND:1')), []);
});

test('the singular legacy API retains its existing event id and command semantics', () => {
  const event = parseOne(legacy({ rnd: 'original-rnd', tid: 'other-tid' }));
  assert.equal(event.eventId, 'original-rnd');
  assert.equal(parseOne(legacy({}, 'SEND_GIFT:1')), null);
  assert.equal(parseOne(giftV2Fixture()), null);
  assert.equal(normalizeGiftQuantity(50_000), 10_000);
});

test('V2 emits every gift item and preserves each guard tier including absence', () => {
  for (const guardLevel of [null, 0, 1, 2, 3]) {
    const events = parse(giftV2Fixture([{ id: 11, count: 2 }, { id: 12, count: 3 }], { guardLevel, command: 'SEND_GIFT_V2:1' }));
    assert.equal(events.length, 2);
    assert.deepEqual(events.map(event => event.giftId), ['11', '12']);
    assert.deepEqual(events.map(event => event.quantity), [2, 3]);
    assert(events.every(event => event.guardLevel === (guardLevel ?? 0)));
  }
});

test('uint64 uid and gift identity stay exact, and large transaction identifiers differ', () => {
  const uid = 18446744073709551615n;
  const giftId = 9007199254740993n;
  const [first] = parse(giftV2Fixture([{ id: giftId, tid: uid, rnd: null }], { uid }));
  const [second] = parse(giftV2Fixture([{ id: giftId, tid: uid - 1n, rnd: null }], { uid }));
  assert.equal(first.uid, '18446744073709551615');
  assert.equal(first.giftId, '9007199254740993');
  assert.notEqual(first.eventId, second.eventId);
  assert.match(first.eventId, /^gift-tx:[a-f0-9]{64}$/);
});

test('unsafe JSON numeric identities are rejected while decimal string identities are preserved', () => {
  const id = '9007199254740993';
  const [event] = parse(legacy({ uid: id, giftId: id }));
  assert.equal(event.uid, id);
  assert.equal(event.giftId, id);
  assert.deepEqual(parse(legacy({ uid: Number(id) })), []);
  assert.deepEqual(parse(legacy({ giftId: Number(id) })), []);
});

test('shared transaction identifiers retain repeated and different gift items with stable replay ids', () => {
  const document = giftV2Fixture([
    { id: 1, tid: 'batch-tid', rnd: 'batch-rnd' },
    { id: 1, tid: 'batch-tid', rnd: 'batch-rnd' },
    { id: 2, tid: 'batch-tid', rnd: 'batch-rnd' }
  ]);
  const first = parse(document);
  assert.equal(first.length, 3);
  assert.equal(new Set(first.map(event => event.eventId)).size, 3);
  assert.deepEqual(parse(document), first);
});

test('distinct tids sharing a rnd remain distinct across envelopes', () => {
  const first = parse(giftV2Fixture([{ tid: 'tid-one', rnd: 'shared-rnd' }]))[0];
  const second = parse(giftV2Fixture([{ tid: 'tid-two', rnd: 'shared-rnd' }]))[0];
  assert.notEqual(first.eventId, second.eventId);
});

test('transaction fallback handles empty or zero ids without truncation collisions', () => {
  const prefix = 'x'.repeat(120);
  const one = parse(giftV2Fixture([{ tid: `${prefix}1`, rnd: '0' }]))[0];
  const two = parse(giftV2Fixture([{ tid: `${prefix}2`, rnd: '' }]))[0];
  assert.notEqual(one.eventId, two.eventId);
  for (const tid of ['', '0', null]) {
    const fallback = parse(giftV2Fixture([{ tid, rnd: 'fallback' }]))[0];
    const equivalent = parse(legacy({ tid: '', rnd: 'fallback' }))[0];
    assert.equal(fallback.eventId, equivalent.eventId);
  }
});

test('legacy and V2 equivalent sends use the same deduplication identity', () => {
  const old = parse(legacy({ tid: 'same-tid', rnd: 'same-rnd' }))[0];
  const current = parse(giftV2Fixture([{ id: 1, count: 2, tid: 'same-tid', rnd: 'same-rnd' }]))[0];
  assert.deepEqual(current, old);
});

test('id-less V2 batches retain identical items and use stable payload replay identities', () => {
  const document = giftV2Fixture([{ id: 1, tid: null, rnd: null }, { id: 1, tid: null, rnd: null }]);
  const first = parse(document);
  assert.equal(first.length, 2);
  assert.notEqual(first[0].eventId, first[1].eventId);
  assert(first.every(event => /^gift-replay:[a-f0-9]{64}$/.test(event.eventId)));
  assert.deepEqual(parse(document), first);
  const wrapped = { ...document, data: { pb: document.data.pb.replace(/(.{20})/g, '$1\n') } };
  assert.deepEqual(parse(wrapped), first);
});

test('a malformed gift between two valid gifts is isolated', () => {
  const { events, diagnostics } = reasons(giftV2Fixture([
    { id: 10 }, { raw: Uint8Array.of(8, 128) }, { id: 20 }
  ]));
  assert.deepEqual(events.map(event => event.giftId), ['10', '20']);
  assert.deepEqual(diagnostics, [{ reason: 'malformed-gift-item', count: 1 }]);
});

test('a wrong-wire gift list item is ignored without losing valid items', () => {
  const { events, diagnostics } = reasons(giftV2Fixture([{ id: 7 }], { extra: biliPbField(10, 123) }));
  assert.equal(events.length, 1);
  assert.deepEqual(diagnostics, [{ reason: 'invalid-gift-item', count: 1 }]);
});

test('truncated outer protobuf is rejected as one packet, not partially credited', () => {
  const document = giftV2Fixture([{}, {}]);
  document.data.pb = Buffer.from(document.data.pb, 'base64').subarray(0, -1).toString('base64');
  const result = reasons(document);
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.diagnostics, [{ reason: 'malformed-protobuf', count: 1 }]);
});

test('unrelated fixed-width and uint64 fields preserve framing', () => {
  const unknown = [
    ...biliVarint(61 * 8 + 1), ...new Array(8).fill(255),
    ...biliVarint(62 * 8 + 5), ...new Array(4).fill(255),
    ...biliPbField(63, 18446744073709551615n)
  ];
  assert.equal(parse(giftV2Fixture([{ id: 15, extra: unknown }], { extra: unknown }))[0].giftId, '15');
});

test('invalid quantities cannot mint credits and the established quantity cap remains', () => {
  const result = reasons(giftV2Fixture([
    { count: 0 }, { count: null }, { count: 18446744073709551615n },
    { count: 9007199254740992n }, { count: 50_000 }
  ]));
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].quantity, 10_000);
  assert.deepEqual(result.diagnostics, [{ reason: 'invalid-quantity', count: 4 }]);
});

test('gift credit and blind-box learning use actual gifts without requiring financial metadata', () => {
  const badOptionalMetadata = biliPbMessage(
    biliPbField(5, Uint8Array.of(255)), biliPbField(7, 18446744073709551615n),
    biliPbField(8, Uint8Array.of(255))
  );
  const document = giftV2Fixture([{ id: 99, name: '开出的礼物', count: 2, extra: [...badOptionalMetadata] }], {
    // Opaque malformed nested blind-box metadata must not invalidate actual gifts.
    blind: Uint8Array.of(8, 128)
  });
  const { events, diagnostics } = reasons(document);
  assert.equal(events[0].giftId, '99');
  assert.equal(events[0].giftName, '开出的礼物');
  assert.equal(events[0].quantity, 2);
  assert.deepEqual(diagnostics, []);
  assert.equal(parse(giftV2Fixture())[0].quantity, 1);
});

test('base64 validation permits canonical padding and URL-safe input but rejects malformed input', () => {
  assert.deepEqual([...decodeBiliBase64('_w')], [255]);
  assert.deepEqual([...decodeBiliBase64(' /w==\n')], [255]);
  for (const invalid of ['A', 'AB==', 'AA=', '====', 'AA!A', '中文']) {
    assert.equal(decodeBiliBase64(invalid), null);
  }
  assert.deepEqual(reasons({ cmd: 'SEND_GIFT_V2', data: { pb: 'AB==' } }).diagnostics,
    [{ reason: 'invalid-base64', count: 1 }]);
});

test('protobuf byte and total field limits fail with fixed diagnostics', () => {
  const large = Buffer.alloc(MAX_BILI_PROTOBUF_BYTES + 1).toString('base64');
  assert.deepEqual(reasons({ cmd: 'SEND_GIFT_V2', data: { pb: large } }).diagnostics,
    [{ reason: 'protobuf-size-limit', count: 1 }]);
  const fields = new Array(MAX_BILI_PROTOBUF_FIELDS + 1).fill(biliPbField(61, 1));
  const excessive = { cmd: 'SEND_GIFT_V2', data: { pb: Buffer.from(biliPbMessage(...fields)).toString('base64') } };
  assert.deepEqual(reasons(excessive).diagnostics, [{ reason: 'protobuf-field-limit', count: 1 }]);
});

test('protobuf reader rejects invalid tags, overlong uint64, and unsupported groups', () => {
  for (const bytes of [Uint8Array.of(0), Uint8Array.of(8, ...new Array(10).fill(255)), Uint8Array.of(11)]) {
    assert.throws(() => parseBiliProtobuf(bytes), BiliProtobufError);
  }
});

test('all items up to the batch bound survive and excess items are explicitly counted', () => {
  const gifts = Array.from({ length: MAX_BILI_GIFT_ITEMS + 1 }, () => ({ id: 1, tid: 'shared', rnd: 'shared' }));
  const result = reasons(giftV2Fixture(gifts));
  assert.equal(result.events.length, MAX_BILI_GIFT_ITEMS);
  assert.equal(new Set(result.events.map(event => event.eventId)).size, MAX_BILI_GIFT_ITEMS);
  assert.deepEqual(result.diagnostics, [{ reason: 'gift-item-limit', count: 1 }]);
});

test('diagnostics expose only fixed reasons and counts and cannot abort accepted gifts', () => {
  const document = giftV2Fixture([{ count: 0 }, {}], { uname: 'PRIVATE-USER-SECRET' });
  const { events, diagnostics } = reasons(document);
  assert.equal(events.length, 1);
  assert.deepEqual(diagnostics, [{ reason: 'invalid-quantity', count: 1 }]);
  assert(!JSON.stringify(diagnostics).includes('PRIVATE'));
  assert(!JSON.stringify(diagnostics).includes(document.data.pb));
  assert.equal(parse(document, () => { throw new Error('consumer error'); }).length, 1);
  assert.deepEqual(reasons({ cmd: 'SEND_GIFT_V2', data: {} }).diagnostics, [{ reason: 'missing-pb', count: 1 }]);
});
