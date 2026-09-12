/** Minimal bounded reader for Bilibili's gift messages; no dynamic schema execution. */
export type BiliPbField =
  | { wireType: 0; value: bigint }
  | { wireType: 2; value: Uint8Array };

export const MAX_BILI_PROTOBUF_BYTES = 1024 * 1024;
export const MAX_BILI_PROTOBUF_FIELDS = 16_384;
export const MAX_BILI_PROTOBUF_TEXT_BYTES = 4096;

export class BiliProtobufError extends Error {
  readonly reason: 'size-limit' | 'field-limit' | 'malformed';

  constructor(reason: 'size-limit' | 'field-limit' | 'malformed') {
    super(reason);
    this.reason = reason;
  }
}

export interface BiliProtobufBudget { remainingFields: number }

export function createBiliProtobufBudget(): BiliProtobufBudget {
  return { remainingFields: MAX_BILI_PROTOBUF_FIELDS };
}

export function decodeBiliBase64(value: string): Uint8Array | null {
  // Bound work before stripping whitespace or decoding an allocation.
  if (value.length > Math.ceil(MAX_BILI_PROTOBUF_BYTES / 3) * 4 + 1024) {
    throw new BiliProtobufError('size-limit');
  }
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
  if (!normalized || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return null;
  const unpadded = normalized.replace(/=+$/, '');
  if (!unpadded || unpadded.length % 4 === 1
    || (normalized.includes('=') && normalized.length % 4 !== 0)) return null;
  const bytes = Buffer.from(normalized, 'base64');
  if (bytes.length > MAX_BILI_PROTOBUF_BYTES) throw new BiliProtobufError('size-limit');
  // Node's decoder is permissive; reject non-zero pad bits and malformed encodings.
  return bytes.toString('base64').replace(/=+$/, '') === unpadded ? bytes : null;
}

export function parseBiliProtobuf(
  bytes: Uint8Array,
  budget: BiliProtobufBudget = createBiliProtobufBudget()
): Map<number, BiliPbField[]> {
  if (bytes.length > MAX_BILI_PROTOBUF_BYTES) throw new BiliProtobufError('size-limit');
  const fields = new Map<number, BiliPbField[]>();
  let offset = 0;
  const malformed = (): never => { throw new BiliProtobufError('malformed'); };
  const readVarint = (): bigint => {
    let value = 0n;
    for (let index = 0; index < 10; index++) {
      if (offset >= bytes.length) return malformed();
      const part = bytes[offset++];
      if (index === 9 && part > 1) return malformed();
      value |= BigInt(part & 0x7f) << BigInt(index * 7);
      if (!(part & 0x80)) return value;
    }
    return malformed();
  };
  while (offset < bytes.length) {
    if (--budget.remainingFields < 0) throw new BiliProtobufError('field-limit');
    const rawTag = readVarint();
    if (rawTag > 0xffffffffn) return malformed();
    const tag = Number(rawTag);
    const fieldNumber = Math.floor(tag / 8);
    const wireType = tag % 8;
    if (!fieldNumber) return malformed();
    let field: BiliPbField | undefined;
    if (wireType === 0) field = { wireType, value: readVarint() };
    else if (wireType === 2) {
      const length = readVarint();
      if (length > BigInt(bytes.length - offset)) return malformed();
      const end = offset + Number(length);
      field = { wireType, value: bytes.subarray(offset, end) };
      offset = end;
    } else if (wireType === 1 || wireType === 5) {
      offset += wireType === 1 ? 8 : 4;
      if (offset > bytes.length) return malformed();
    } else return malformed();
    if (field) {
      const values = fields.get(fieldNumber) || [];
      values.push(field);
      fields.set(fieldNumber, values);
    }
  }
  return fields;
}

export function biliPbText(field: BiliPbField | undefined): string {
  if (!field || field.wireType !== 2) return '';
  if (field.value.length > MAX_BILI_PROTOBUF_TEXT_BYTES) throw new BiliProtobufError('size-limit');
  return new TextDecoder('utf-8', { fatal: true }).decode(field.value);
}

export function biliPbIdentifier(field: BiliPbField | undefined): string {
  return field?.wireType === 0 ? field.value.toString() : biliPbText(field).trim();
}
