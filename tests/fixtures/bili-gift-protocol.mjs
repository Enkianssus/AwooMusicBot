// Synthetic protocol fixtures only. Field numbers follow blivedm's SendGift schema.
export function biliVarint(value) {
  let rest = BigInt(value);
  if (rest < 0n || rest > 0xffffffffffffffffn) throw new Error('Fixture uint64 out of range');
  const bytes = [];
  do {
    const part = Number(rest & 127n);
    rest >>= 7n;
    bytes.push(part | (rest ? 128 : 0));
  } while (rest);
  return bytes;
}

export function biliPbField(number, value) {
  if (typeof value === 'number' || typeof value === 'bigint') {
    return [...biliVarint(number * 8), ...biliVarint(value)];
  }
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  return [...biliVarint(number * 8 + 2), ...biliVarint(bytes.length), ...bytes];
}

export function biliPbMessage(...fields) { return Uint8Array.from(fields.flat()); }

export function giftV2Fixture(gifts = [{}], options = {}) {
  const fields = [biliPbField(1, options.uid ?? 42n)];
  if (options.uname !== null) fields.push(biliPbField(2, options.uname ?? '测试观众'));
  if (options.guardLevel !== null) fields.push(biliPbField(5, options.guardLevel ?? 3));
  if (options.blind !== undefined) fields.push(biliPbField(9, options.blind));
  gifts.forEach((gift, index) => {
    if (gift.raw) { fields.push(biliPbField(10, gift.raw)); return; }
    const item = [];
    if (gift.id !== null) item.push(biliPbField(1, gift.id ?? index + 1));
    if (gift.name !== null) item.push(biliPbField(2, gift.name ?? `实际礼物${index + 1}`));
    if (gift.count !== null) item.push(biliPbField(3, gift.count ?? 1));
    if (gift.tid !== null) item.push(biliPbField(9, gift.tid ?? `tid-${index}`));
    if (gift.timestamp !== undefined) item.push(biliPbField(10, gift.timestamp));
    if (gift.rnd !== null) item.push(biliPbField(12, gift.rnd ?? `rnd-${index}`));
    if (gift.extra) item.push(gift.extra);
    fields.push(biliPbField(10, biliPbMessage(...item)));
  });
  if (options.extra) fields.push(options.extra);
  const bytes = biliPbMessage(...fields);
  return { cmd: options.command ?? 'SEND_GIFT_V2', data: { pb: Buffer.from(bytes).toString('base64') } };
}
