import crypto, { type KeyLike } from 'node:crypto';

interface ProfileEntryIdentity {
  schemaVersion: number;
  minimumConnectorVersion: string;
}

const VERSION = /^\d+\.\d+\.\d+$/;
const HASH = /^[a-f0-9]{64}$/i;

function atLeast(version: string, minimum: string): boolean {
  if (!VERSION.test(version) || !VERSION.test(minimum)) return false;
  const actual = version.split('.').map(Number);
  const required = minimum.split('.').map(Number);
  if (![...actual, ...required].every(Number.isSafeInteger)) return false;
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== required[i]) return actual[i] > required[i];
  }
  return true;
}

export function canUseCachedQqProfiles(
  active: { schemaVersion?: number; minimumConnectorVersion?: string },
  connectorVersion: string
): boolean {
  const schema = active.schemaVersion ?? 1;
  if (schema !== 1 && schema !== 2) throw new Error('QQ 缓存画像 schema 无效');
  // The historical signed schema 1 catalog uses this exact minimum.
  const minimum = active.minimumConnectorVersion ?? (schema === 1 ? '22.51.1' : '');
  if (!VERSION.test(minimum)) throw new Error('QQ 缓存画像缺少有效的连接器最低版本');
  return atLeast(connectorVersion, minimum);
}

export function isQqProfileNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error
    && (error.name === 'AbortError' || error.name === 'TimeoutError'));
}

/** The old catalog entry remains usable by old cores/connectors. */
export function selectQqProfileEntry<T extends ProfileEntryIdentity>(
  legacy: T | null | undefined,
  current: T | null | undefined,
  connectorVersion: string
): T | null {
  if (current) {
    if (current.schemaVersion !== 2 || !VERSION.test(current.minimumConnectorVersion)) {
      throw new Error('QQ 音乐新版画像更新清单无效');
    }
    if (atLeast(connectorVersion, current.minimumConnectorVersion)) return current;
  }
  if (!legacy) return null;
  if (legacy.schemaVersion !== 1 || !VERSION.test(legacy.minimumConnectorVersion)) {
    throw new Error('QQ 音乐画像更新清单无效');
  }
  return atLeast(connectorVersion, legacy.minimumConnectorVersion) ? legacy : null;
}

const RVA_FIELDS = [
  'singleSongPlayDispatchRva', 'getCatManagerRva', 'getQqUinExRva',
  'songItemConstructorRva', 'songItemDestructorRva', 'addSongsRva',
  'hiddenCategoryIdRva', 'getListRootRva', 'getListHelperRva',
  'getCategoryCountRva', 'songItemSize'
];

function positiveInt32(value: unknown): boolean {
  if (typeof value !== 'string' || !/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)) return false;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 0x7fffffff;
}

export function validateQqProfileDocument(
  value: unknown,
  filename: string,
  packageSchema: number
): void {
  const document = value as Record<string, unknown> | null;
  const schema = document?.schemaVersion;
  if (!document || Array.isArray(document)
      || (packageSchema !== 1 && packageSchema !== 2)
      || (schema !== 1 && schema !== 2) || Number(schema) > packageSchema
      || typeof document.fileVersion !== 'string'
      || !/^\d+\.\d+$/.test(document.fileVersion)
      || filename.toLowerCase() !== `${document.fileVersion}.json`
      || typeof document.clientSha256 !== 'string' || !HASH.test(document.clientSha256)
      || typeof document.commonSha256 !== 'string' || !HASH.test(document.commonSha256)
      || !RVA_FIELDS.every(field => positiveInt32(document[field]))
      || typeof document.expectedPlayDispatchBytes !== 'string'
      || !/^[a-f0-9]{2}(?:[ \-:]+[a-f0-9]{2}){4}$/i.test(document.expectedPlayDispatchBytes)) {
    throw new Error(`QQ 画像文件无效：${filename}`);
  }
  if (schema === 2 && (
    typeof document.apiSha256 !== 'string' || !HASH.test(document.apiSha256)
    || document.abiContract !== 'qqmusic-addsongs-cstring-v1'
    || document.transportContract !== 'type4-songid-v1'
    || !positiveInt32(document.stringManagerGetterRva)
  )) {
    throw new Error(`QQ 画像原生调用合同无效：${filename}`);
  }
}

export function verifyQqProfileArchive(
  archive: Buffer,
  entry: { size: number; sha256: string; signature: string },
  publicKey: KeyLike
): void {
  if (archive.length !== entry.size) throw new Error('QQ 画像大小不匹配');
  const digest = crypto.createHash('sha256').update(archive).digest('hex');
  if (!HASH.test(entry.sha256) || !crypto.timingSafeEqual(
    Buffer.from(digest, 'hex'), Buffer.from(entry.sha256, 'hex')
  )) throw new Error('QQ 画像 SHA-256 校验失败');
  if (!crypto.verify(null, archive, publicKey, Buffer.from(entry.signature, 'base64'))) {
    throw new Error('QQ 画像 Ed25519 签名校验失败');
  }
}
