import { createHash } from 'node:crypto';

const NETEASE_PIC_MAGIC = '3go8&$8*3*3h0k(2)2';

export function buildNeteaseCoverUrlFromPicId(picId: unknown): string {
  const normalizedId = String(picId || '').trim();
  if (!/^\d+$/.test(normalizedId)) return '';

  const source = Buffer.from(normalizedId, 'ascii');
  const magic = Buffer.from(NETEASE_PIC_MAGIC, 'ascii');
  const encrypted = Buffer.allocUnsafe(source.length);
  for (let index = 0; index < source.length; index++) {
    encrypted[index] = source[index] ^ magic[index % magic.length];
  }
  const token = createHash('md5')
    .update(encrypted)
    .digest('base64')
    .replace(/\//g, '_')
    .replace(/\+/g, '-');
  return `https://p1.music.126.net/${token}/${normalizedId}.jpg`;
}
