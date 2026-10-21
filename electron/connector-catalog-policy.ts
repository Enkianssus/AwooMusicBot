/**
 * Trust rules of the connector v2 catalog: the stable endpoints, the release
 * signing key, catalog and entry validation, and package verification. This
 * module has no Electron or file system dependency so the rules can be
 * exercised directly in tests.
 */
import crypto, { type KeyLike } from 'node:crypto';
import path from 'node:path';
import {
  connectorAssetNames,
  type BrandedConnectorId
} from './connector-branding-policy.ts';
import { ConnectorDownloadError } from './connector-install-policy.ts';

/**
 * Frozen endpoint consumed by Awoo MusicBot 1.1.0 through 1.1.9.  It is
 * exported as a compatibility marker, but the current updater intentionally
 * does not fall back to it when the v2 endpoint is unavailable.
 */
export const LEGACY_CONNECTOR_CATALOG_URL =
  'https://app.enkianss.us/connectors/v1/catalog.json';
export const CATALOG_URL =
  'https://app.enkianss.us/connectors/v2/catalog.json';
export const V2_DOWNLOAD_URL_PREFIX =
  'https://app.enkianss.us/connectors/v2/download/';
export const V2_MINIMUM_CORE_VERSION = '1.1.10';
export const CONNECTOR_PROTOCOL_VERSION = 1;
export const CONNECTOR_VERSION_PATTERN = /^\d+(?:\.\d+){2,4}$/;
export const PUBLIC_KEY_ID = 'bilincm-connectors-2026-01';
export const RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEApFy/TMxhGKlxzOS2b1gjvQxnvFhjefK0sbxsCXFS2uc=
-----END PUBLIC KEY-----
`;

const CORE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
/** v2 entries carry their package only in `package`, never at the top level. */
const LEGACY_PACKAGE_FIELDS = [
  'asset',
  'size',
  'sha256',
  'signature',
  'downloadUrl',
  'runtime',
  'frameworkDependent',
  'awooPackage',
  'awooFrameworkDependent'
];

export interface V2CatalogDocument {
  schemaVersion: 2;
  publicKeyId: string;
  connectors: Record<string, unknown>;
}

export interface V2ConnectorPackageEntry {
  deployment: 'framework-dependent';
  runtime: 'win-x86' | 'win-x64';
  runtimeChannel: '8.0';
  asset: string;
  size: number;
  sha256: string;
  signature: string;
  downloadUrl: string;
}

export interface V2ConnectorCatalogEntry {
  id: BrandedConnectorId;
  version: string;
  protocolVersion: number;
  minimumCoreVersion: string;
  testedPlayerVersion?: string;
  playerVersionPolicy?: string;
  package: V2ConnectorPackageEntry;
}

export interface ConnectorArchiveDescriptor {
  size: number;
  sha256: string;
  signature: string;
}

export function assertV2Catalog(
  catalog: unknown
): asserts catalog is V2CatalogDocument {
  const document = isRecord(catalog) ? catalog : null;
  if (
    !document
    || document.schemaVersion !== 2
    || document.publicKeyId !== PUBLIC_KEY_ID
    || !isRecord(document.connectors)
  ) {
    throw new Error(
      '连接器 v2 更新清单格式或签名密钥标识不兼容'
    );
  }
}

/**
 * A v2 entry offers exactly one signed Awoo framework-dependent package
 * under /connectors/v2/download/. Any missing or mistyped field is reported
 * as an invalid entry, never as a TypeError.
 */
export function validateV2ConnectorEntry(
  connectorId: BrandedConnectorId,
  entry: unknown
): asserts entry is V2ConnectorCatalogEntry {
  if (!isValidV2ConnectorEntry(connectorId, entry)) {
    throw new Error(
      `${connectorId} v2 package framework-dependent 连接器清单字段无效`
    );
  }
}

function isValidV2ConnectorEntry(
  connectorId: BrandedConnectorId,
  entry: unknown
): boolean {
  if (!isRecord(entry) || LEGACY_PACKAGE_FIELDS.some(field => field in entry)) {
    return false;
  }
  const v2Package = entry.package;
  if (!isRecord(v2Package)) return false;
  const {
    version,
    minimumCoreVersion,
    testedPlayerVersion,
    playerVersionPolicy
  } = entry;
  const { runtime, size, asset, downloadUrl } = v2Package;
  return entry.id === connectorId
    && entry.protocolVersion === CONNECTOR_PROTOCOL_VERSION
    && typeof version === 'string'
    && CONNECTOR_VERSION_PATTERN.test(version)
    && typeof minimumCoreVersion === 'string'
    && CORE_VERSION_PATTERN.test(minimumCoreVersion)
    && compareCoreVersions(minimumCoreVersion, V2_MINIMUM_CORE_VERSION) >= 0
    && isOptionalText(testedPlayerVersion)
    && isOptionalText(playerVersionPolicy)
    && (isNonBlankText(testedPlayerVersion) || isNonBlankText(playerVersionPolicy))
    && v2Package.deployment === 'framework-dependent'
    && (runtime === 'win-x86' || runtime === 'win-x64')
    && v2Package.runtimeChannel === '8.0'
    && typeof size === 'number'
    && Number.isSafeInteger(size)
    && size > 0
    && typeof v2Package.sha256 === 'string'
    && SHA256_PATTERN.test(v2Package.sha256)
    && isNonBlankText(v2Package.signature)
    && typeof downloadUrl === 'string'
    && downloadUrl.startsWith(V2_DOWNLOAD_URL_PREFIX)
    && typeof asset === 'string'
    && path.basename(asset) === asset
    && asset === connectorAssetNames(connectorId, version, runtime, true)[0]
    && urlBasename(downloadUrl) === asset;
}

/**
 * Checks a downloaded package in order: size, SHA-256, then the Ed25519
 * release signature. Failures are typed download errors, so the installer
 * may fetch the same signed asset from its second source.
 */
export function verifyConnectorArchive(
  archive: Buffer,
  packageEntry: ConnectorArchiveDescriptor,
  publicKey: KeyLike = RELEASE_PUBLIC_KEY
): void {
  if (archive.length !== packageEntry.size) {
    throw new ConnectorDownloadError(
      'size',
      `文件大小不匹配：${archive.length}/${packageEntry.size}`
    );
  }

  const digest = crypto.createHash('sha256').update(archive).digest();
  if (
    typeof packageEntry.sha256 !== 'string'
    || !SHA256_PATTERN.test(packageEntry.sha256)
    || !crypto.timingSafeEqual(digest, Buffer.from(packageEntry.sha256, 'hex'))
  ) {
    throw new ConnectorDownloadError('hash', 'SHA-256 校验失败');
  }

  let signed = false;
  try {
    signed = crypto.verify(
      null,
      archive,
      publicKey,
      Buffer.from(String(packageEntry.signature), 'base64')
    );
  } catch {
    // A malformed signature is a failed signature, not a crash.
  }
  if (!signed) {
    throw new ConnectorDownloadError('signature', 'Ed25519 签名校验失败');
  }
}

const DNS_FAILURE_CODES = [
  'ENOTFOUND',
  'EAI_AGAIN',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_NAME_RESOLUTION_FAILED'
];
const INTERRUPTED_CODES = [
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_ABORTED',
  'ERR_CONNECTION_FAILED',
  'ERR_EMPTY_RESPONSE',
  'ERR_NETWORK_CHANGED'
];
const TIMEOUT_CODES = [
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ETIMEDOUT',
  'ABORT_ERR',
  'ERR_TIMED_OUT',
  'ERR_CONNECTION_TIMED_OUT'
];
const PROXY_FAILURE_CODES = [
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_TUNNEL_CONNECTION_FAILED',
  'ERR_PROXY_AUTH_REQUESTED',
  'ERR_PROXY_AUTH_UNSUPPORTED',
  'ERR_PROXY_CERTIFICATE_INVALID',
  'ERR_MANDATORY_PROXY_CONFIGURATION_FAILED',
  'ERR_PAC_SCRIPT_FAILED',
  'ERR_PAC_NOT_IN_DHCP',
  'ERR_PROXY_HTTP_1_1_REQUIRED',
  'UND_ERR_PRX_TLS'
];
const OFFLINE_CODES = [
  'ERR_INTERNET_DISCONNECTED',
  'ERR_ADDRESS_UNREACHABLE',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH'
];
const CERTIFICATE_FAILURE_CODES = [
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID'
];

function describeNetworkErrorCode(code: string): string | null {
  if (DNS_FAILURE_CODES.includes(code)) {
    return '无法解析更新服务器地址，请检查网络或代理';
  }
  if (INTERRUPTED_CODES.includes(code)) return '连接更新服务器被中断';
  if (TIMEOUT_CODES.includes(code)) return '连接更新服务器超时';
  if (PROXY_FAILURE_CODES.includes(code)) {
    return '无法通过代理连接更新服务器，请检查系统代理设置';
  }
  if (OFFLINE_CODES.includes(code)) return '网络不可用，请检查网络连接';
  if (
    CERTIFICATE_FAILURE_CODES.includes(code)
    || code.startsWith('ERR_CERT_')
    || code.startsWith('ERR_SSL_')
  ) {
    return '更新服务器证书校验失败，请检查系统时间或代理设置';
  }
  return null;
}

/**
 * Node's fetch reports every transport failure as 'fetch failed' with the
 * reason in `cause.code`; Electron's net.fetch reports 'net::ERR_…'. Both
 * become a readable Chinese message; any other error keeps its message.
 */
export function describeNetworkError(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && isRecord(current); depth++) {
    const codes: string[] = [];
    if (typeof current.code === 'string') codes.push(current.code.toUpperCase());
    if (current.name === 'AbortError' || current.name === 'TimeoutError') {
      codes.push('ABORT_ERR');
    }
    const netError = typeof current.message === 'string'
      ? /\bnet::(ERR_[A-Z0-9_]+)/.exec(current.message)
      : null;
    if (netError) codes.push(netError[1]);
    for (const code of codes) {
      const message = describeNetworkErrorCode(code);
      if (message) return message;
    }
    current = current.cause;
  }
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return String(error);
}

/**
 * The hint shown with versions from the last catalog that could be fetched,
 * for example '更新检查失败：连接更新服务器超时；当前显示 09:05 获取的版本信息'.
 */
export function describeStaleCatalog(
  reason: string,
  fetchedAt: number,
  now: number
): string {
  const fetched = new Date(fetchedAt);
  const time = `${String(fetched.getHours()).padStart(2, '0')}:`
    + String(fetched.getMinutes()).padStart(2, '0');
  const when = fetched.toDateString() === new Date(now).toDateString()
    ? time
    : `${fetched.getMonth() + 1}月${fetched.getDate()}日 ${time}`;
  return `更新检查失败：${reason}；当前显示 ${when} 获取的版本信息`;
}

function compareCoreVersions(left: string, right: string): number {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function urlBasename(value: string): string | null {
  try {
    return path.basename(new URL(value).pathname);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOptionalText(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

function isNonBlankText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
