import { createHash } from 'node:crypto';
import type { BilibiliGiftCreditEvent } from './gift-request-credit-policy.ts';
import {
  BiliProtobufError,
  biliPbIdentifier,
  biliPbText,
  createBiliProtobufBudget,
  decodeBiliBase64,
  parseBiliProtobuf,
  type BiliPbField
} from './bili-protobuf.ts';

export const MAX_GIFT_QUANTITY_PER_EVENT = 10_000;
export const MAX_BILI_GIFT_ITEMS = 1024;
const MAX_IDENTIFIER_LENGTH = 4096;

export type BilibiliGiftParseDiagnosticReason =
  | 'invalid-envelope' | 'missing-pb' | 'invalid-base64'
  | 'protobuf-size-limit' | 'protobuf-field-limit' | 'malformed-protobuf'
  | 'empty-gift-list' | 'invalid-uid' | 'invalid-user-name'
  | 'invalid-gift-item' | 'malformed-gift-item' | 'invalid-gift-identity'
  | 'invalid-quantity' | 'invalid-event-id' | 'gift-item-limit';

export interface BilibiliGiftParseDiagnostic {
  reason: BilibiliGiftParseDiagnosticReason;
  count: number;
}

type Diagnose = (reason: BilibiliGiftParseDiagnosticReason, count?: number) => void;
type GiftEventWithoutId = Omit<BilibiliGiftCreditEvent, 'eventId'>;

export function normalizeGiftQuantity(value: unknown): number {
  const quantity = Math.floor(Number(value));
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;
  return Math.min(quantity, MAX_GIFT_QUANTITY_PER_EVENT);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function identifier(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error('invalid-identifier');
  }
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    throw new Error('invalid-identifier');
  }
  const text = String(value).trim();
  if (text.length > MAX_IDENTIFIER_LENGTH) throw new Error('invalid-identifier');
  return text;
}

function displayName(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).trim().slice(0, 80) : '';
}

function hash(parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function transactionId(rnd: () => string, tid: () => string, diagnose: Diagnose): string {
  // rnd may be shared by separate sends. Prefer an explicit transaction id.
  for (const read of [tid, rnd]) {
    try {
      const value = read();
      if (value && value !== '0') return value;
    } catch { diagnose('invalid-event-id'); }
  }
  return '';
}

function withEventId(
  gift: GiftEventWithoutId,
  transaction: string,
  occurrences: Map<string, number>,
  replayId = ''
): BilibiliGiftCreditEvent {
  if (!transaction) return { ...gift, eventId: replayId };
  // Hash the FULL transaction id before adding an occurrence. Different gifts and
  // repeated items sharing one transaction must all survive the batch. Legacy and
  // V2 use the same identity so an equivalent cross-format replay is not credited twice.
  const identity = gift.giftId ? `id:${gift.giftId}` : `name:${gift.giftName.toLocaleLowerCase('zh-CN')}`;
  const base = hash([gift.uid, transaction, identity]);
  const occurrence = occurrences.get(base) || 0;
  occurrences.set(base, occurrence + 1);
  return { ...gift, eventId: `gift-tx:${hash([base, String(occurrence)])}` };
}

function parseLegacyGift(data: Record<string, unknown>, diagnose: Diagnose): BilibiliGiftCreditEvent[] {
  let uid: string;
  try { uid = identifier(data.uid); } catch { diagnose('invalid-uid'); return []; }
  if (!uid) { diagnose('invalid-uid'); return []; }
  let giftId: string;
  try { giftId = identifier(data.giftId ?? data.gift_id); }
  catch { diagnose('invalid-gift-identity'); return []; }
  const giftName = displayName(data.giftName ?? data.gift_name);
  if (!giftName && !giftId) { diagnose('invalid-gift-identity'); return []; }
  const quantity = normalizeGiftQuantity(data.num);
  if (!quantity) { diagnose('invalid-quantity'); return []; }
  const rawGuard = Number(data.guard_level ?? data.guardLevel ?? 0);
  const gift: GiftEventWithoutId = {
    uid, userName: displayName(data.uname) || `用户${uid.slice(-6)}`,
    giftName, giftId, quantity,
    guardLevel: [1, 2, 3].includes(rawGuard) ? rawGuard : 0
  };
  return [withEventId(gift, transactionId(
    () => identifier(data.rnd), () => identifier(data.tid), diagnose
  ), new Map())];
}

function first(fields: Map<number, BiliPbField[]>, field: number): BiliPbField | undefined {
  return fields.get(field)?.[0];
}

/** Fields verified against xfgryujk/blivedm/blivedm/models/pb.py (SendGift):
 * root uid=1, uname=2, guard_level=5, blind_gift=9, repeated gift_list=10;
 * item gift_id=1, gift_name=2, num=3, tid=9, timestamp=10, rnd=12.
 * The credit belongs to each actual gift_list item, including blind-box rewards.
 * Price, coin type, and optional blind-box metadata are deliberately not decoded.
 */
function parseGiftV2(data: Record<string, unknown>, diagnose: Diagnose): BilibiliGiftCreditEvent[] {
  if (typeof data.pb !== 'string' || !data.pb) { diagnose('missing-pb'); return []; }
  const output: BilibiliGiftCreditEvent[] = [];
  try {
    const bytes = decodeBiliBase64(data.pb);
    if (!bytes) { diagnose('invalid-base64'); return []; }
    const budget = createBiliProtobufBudget();
    const root = parseBiliProtobuf(bytes, budget);
    const items = root.get(10) || [];
    if (!items.length) { diagnose('empty-gift-list'); return []; }
    const uid = biliPbIdentifier(first(root, 1));
    if (!/^\d+$/.test(uid) || !/[1-9]/.test(uid)) { diagnose('invalid-uid'); return []; }
    let userName = '';
    try { userName = displayName(biliPbText(first(root, 2))); }
    catch { diagnose('invalid-user-name'); }
    userName ||= `用户${uid.slice(-6)}`;
    const guard = first(root, 5);
    const guardLevel = guard?.wireType === 0 && guard.value >= 1n && guard.value <= 3n
      ? Number(guard.value) : 0;
    const payloadHash = createHash('sha256').update(bytes).digest('hex');
    const occurrences = new Map<string, number>();
    if (items.length > MAX_BILI_GIFT_ITEMS) diagnose('gift-item-limit', items.length - MAX_BILI_GIFT_ITEMS);
    for (let index = 0; index < Math.min(items.length, MAX_BILI_GIFT_ITEMS); index++) {
      const item = items[index];
      if (item.wireType !== 2) { diagnose('invalid-gift-item'); continue; }
      try {
        const fields = parseBiliProtobuf(item.value, budget);
        const giftId = biliPbIdentifier(first(fields, 1));
        const giftName = displayName(biliPbText(first(fields, 2)));
        if ((!giftId || giftId === '0') && !giftName) { diagnose('invalid-gift-identity'); continue; }
        const count = first(fields, 3);
        if (count?.wireType !== 0 || count.value <= 0n || count.value > BigInt(Number.MAX_SAFE_INTEGER)) {
          diagnose('invalid-quantity');
          continue;
        }
        const quantity = count.value > BigInt(MAX_GIFT_QUANTITY_PER_EVENT)
          ? MAX_GIFT_QUANTITY_PER_EVENT : Number(count.value);
        const gift: GiftEventWithoutId = { uid, userName, giftId, giftName, guardLevel, quantity };
        const transaction = transactionId(
          () => biliPbIdentifier(first(fields, 12)),
          () => biliPbIdentifier(first(fields, 9)), diagnose
        );
        // Without a transaction, exact-byte replays are the only available evidence.
        // Callers must use a SHORT replay window for this prefix: two genuine,
        // byte-identical id-less sends cannot be distinguished by any decoder.
        const replayId = `gift-replay:${hash([payloadHash, String(index)])}`;
        output.push(withEventId(gift, transaction, occurrences, replayId));
      } catch (error) {
        if (error instanceof BiliProtobufError && error.reason === 'field-limit') {
          diagnose('protobuf-field-limit');
          break;
        }
        diagnose('malformed-gift-item');
      }
    }
  } catch (error) {
    diagnose(error instanceof BiliProtobufError && error.reason === 'size-limit'
      ? 'protobuf-size-limit'
      : error instanceof BiliProtobufError && error.reason === 'field-limit'
        ? 'protobuf-field-limit' : 'malformed-protobuf');
  }
  return output;
}

export function parseBilibiliGiftCreditEvents(
  document: unknown,
  onDiagnostic?: (diagnostic: BilibiliGiftParseDiagnostic) => void
): BilibiliGiftCreditEvent[] {
  const counts = new Map<BilibiliGiftParseDiagnosticReason, number>();
  const diagnose: Diagnose = (reason, count = 1) => counts.set(reason, (counts.get(reason) || 0) + count);
  try {
    const envelope = record(document);
    if (!envelope || typeof envelope.cmd !== 'string') { diagnose('invalid-envelope'); return []; }
    const command = envelope.cmd.split(':', 1)[0];
    if (command !== 'SEND_GIFT' && command !== 'SEND_GIFT_V2') return [];
    const data = record(envelope.data);
    if (!data) { diagnose('invalid-envelope'); return []; }
    return command === 'SEND_GIFT' ? parseLegacyGift(data, diagnose) : parseGiftV2(data, diagnose);
  } catch { diagnose('invalid-envelope'); return []; }
  finally {
    for (const [reason, count] of counts) {
      try { onDiagnostic?.({ reason, count }); } catch { /* Diagnostics must not discard gifts. */ }
    }
  }
}
