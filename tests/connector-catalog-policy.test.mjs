import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import {
  assertV2Catalog,
  CATALOG_URL,
  CONNECTOR_PROTOCOL_VERSION,
  describeNetworkError,
  describeStaleCatalog,
  LEGACY_CONNECTOR_CATALOG_URL,
  PUBLIC_KEY_ID,
  RELEASE_PUBLIC_KEY,
  V2_DOWNLOAD_URL_PREFIX,
  V2_MINIMUM_CORE_VERSION,
  validateV2ConnectorEntry,
  verifyConnectorArchive
} from '../electron/connector-catalog-policy.ts';
import { isConnectorDownloadError } from '../electron/connector-install-policy.ts';

test('stable endpoints and the pinned release signing key are unchanged', () => {
  assert.equal(PUBLIC_KEY_ID, 'bilincm-connectors-2026-01');
  assert.equal(CATALOG_URL, 'https://app.enkianss.us/connectors/v2/catalog.json');
  assert.ok(CATALOG_URL.endsWith('/connectors/v2/catalog.json'));
  assert.equal(LEGACY_CONNECTOR_CATALOG_URL, 'https://app.enkianss.us/connectors/v1/catalog.json');
  assert.equal(V2_DOWNLOAD_URL_PREFIX, 'https://app.enkianss.us/connectors/v2/download/');
  assert.equal(V2_MINIMUM_CORE_VERSION, '1.1.10');
  assert.equal(CONNECTOR_PROTOCOL_VERSION, 1);
  const key = crypto.createPublicKey(RELEASE_PUBLIC_KEY);
  assert.equal(key.asymmetricKeyType, 'ed25519');
  assert.equal(
    key.export({ format: 'der', type: 'spki' }).toString('base64'),
    'MCowBQYDK2VwAyEApFy/TMxhGKlxzOS2b1gjvQxnvFhjefK0sbxsCXFS2uc='
  );
});

test('the frozen v1 catalog is documented as never being a fallback', () => {
  const source = fs.readFileSync(
    new URL('../electron/connector-catalog-policy.ts', import.meta.url),
    'utf8'
  );
  assert.match(source, /does not fall back to it when the v2 endpoint is unavailable/);
});

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const archive = Buffer.from('awoo connector package bytes');

function descriptorFor(bytes, signer = privateKey) {
  return {
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    signature: crypto.sign(null, bytes, signer).toString('base64')
  };
}

function rejectsDownload(run, kind, message) {
  assert.throws(run, error => {
    assert.equal(isConnectorDownloadError(error), true);
    assert.equal(error.kind, kind);
    assert.match(error.message, message);
    return true;
  });
}

test('a correctly signed archive passes size, SHA-256 and Ed25519 checks', () => {
  verifyConnectorArchive(archive, descriptorFor(archive), publicKey);
});

test('tampered, resized, mis-hashed and foreign-signed archives are rejected as download errors', () => {
  const descriptor = descriptorFor(archive);
  const tampered = Buffer.from(archive);
  tampered[3] ^= 0x01;
  rejectsDownload(
    () => verifyConnectorArchive(tampered, descriptor, publicKey),
    'hash',
    /^SHA-256 校验失败$/
  );
  rejectsDownload(
    () => verifyConnectorArchive(Buffer.concat([archive, Buffer.from('x')]), descriptor, publicKey),
    'size',
    new RegExp(`^文件大小不匹配：${archive.length + 1}/${archive.length}$`)
  );
  rejectsDownload(
    () => verifyConnectorArchive(archive, { ...descriptor, sha256: '0'.repeat(64) }, publicKey),
    'hash',
    /SHA-256 校验失败/
  );
  rejectsDownload(
    () => verifyConnectorArchive(archive, { ...descriptor, sha256: 'not-a-digest' }, publicKey),
    'hash',
    /SHA-256 校验失败/
  );
  const foreign = crypto.generateKeyPairSync('ed25519').privateKey;
  rejectsDownload(
    () => verifyConnectorArchive(archive, descriptorFor(archive, foreign), publicKey),
    'signature',
    /^Ed25519 签名校验失败$/
  );
  rejectsDownload(
    () => verifyConnectorArchive(archive, { ...descriptor, signature: 'AAAA' }, publicKey),
    'signature',
    /Ed25519 签名校验失败/
  );
});

test('the production key is the default verifier, so a test signature never passes it', () => {
  rejectsDownload(
    () => verifyConnectorArchive(archive, descriptorFor(archive)),
    'signature',
    /Ed25519 签名校验失败/
  );
});

test('only a schema 2 catalog signed with the pinned key id is accepted', () => {
  const catalog = { schemaVersion: 2, publicKeyId: PUBLIC_KEY_ID, connectors: {} };
  assertV2Catalog(catalog);
  for (const invalid of [
    { ...catalog, schemaVersion: 1 },
    { ...catalog, schemaVersion: '2' },
    { ...catalog, publicKeyId: 'bilincm-connectors-2027-01' },
    { ...catalog, connectors: null },
    { ...catalog, connectors: [] },
    null,
    [],
    'catalog'
  ]) {
    assert.throws(
      () => assertV2Catalog(invalid),
      /^Error: 连接器 v2 更新清单格式或签名密钥标识不兼容$/
    );
  }
});

function v2Entry(overrides = {}, packageOverrides = {}) {
  const asset = 'awoo-connector-qqmusic-22.52.1-win-x86-framework-dependent.zip';
  return {
    id: 'qqmusic',
    name: 'QQ音乐',
    channel: 'stable',
    version: '22.52.1',
    protocolVersion: 1,
    minimumCoreVersion: '1.1.10',
    playerVersionPolicy: '22.*',
    testedPlayerVersion: '22.52',
    publishedAt: '2026-09-04T18:55:26.521Z',
    package: {
      deployment: 'framework-dependent',
      runtime: 'win-x86',
      runtimeChannel: '8.0',
      asset,
      size: 6795490,
      sha256: 'a'.repeat(64),
      signature: 'c2lnbmF0dXJl',
      downloadUrl: `https://app.enkianss.us/connectors/v2/download/qqmusic/22.52.1/${asset}`,
      ...packageOverrides
    },
    ...overrides
  };
}

const FIELD_INVALID = /^Error: qqmusic v2 package framework-dependent 连接器清单字段无效$/;

test('a published-shape v2 entry is accepted for its own connector only', () => {
  validateV2ConnectorEntry('qqmusic', v2Entry());
  validateV2ConnectorEntry('qqmusic', v2Entry({ testedPlayerVersion: null }));
  validateV2ConnectorEntry('qqmusic', v2Entry({ minimumCoreVersion: '1.2.6' }));
  const asset = 'awoo-connector-netease-3.1.38.205386.1-win-x64-framework-dependent.zip';
  validateV2ConnectorEntry('netease', v2Entry({ id: 'netease', version: '3.1.38.205386.1' }, {
    runtime: 'win-x64',
    asset,
    downloadUrl: `https://app.enkianss.us/connectors/v2/download/netease/3.1.38.205386.1/${asset}`
  }));
  assert.throws(() => validateV2ConnectorEntry('kugou', v2Entry()), /kugou v2 package/);
});

test('leftover legacy or awooPackage fields are rejected', () => {
  for (const field of [
    'asset', 'size', 'sha256', 'signature', 'downloadUrl', 'runtime',
    'frameworkDependent', 'awooPackage', 'awooFrameworkDependent'
  ]) {
    assert.throws(
      () => validateV2ConnectorEntry('qqmusic', v2Entry({ [field]: v2Entry().package[field] ?? {} })),
      FIELD_INVALID,
      field
    );
  }
});

test('every malformed entry field reports the field-invalid message, never a TypeError', () => {
  const cases = [
    ['self-contained deployment', v2Entry({}, { deployment: 'self-contained' })],
    ['wrong runtime channel', v2Entry({}, { runtimeChannel: '9.0' })],
    ['unknown runtime', v2Entry({}, { runtime: 'win-arm64' })],
    ['non-v2 download prefix', v2Entry({}, {
      downloadUrl: 'https://app.enkianss.us/connectors/v1/download/qqmusic/22.52.1/'
        + 'awoo-connector-qqmusic-22.52.1-win-x86-framework-dependent.zip'
    })],
    ['foreign download host', v2Entry({}, {
      downloadUrl: 'https://example.com/connectors/v2/download/'
        + 'awoo-connector-qqmusic-22.52.1-win-x86-framework-dependent.zip'
    })],
    ['asset and URL basename mismatch', v2Entry({}, {
      downloadUrl: 'https://app.enkianss.us/connectors/v2/download/qqmusic/22.52.1/other.zip'
    })],
    ['legacy asset name', v2Entry({}, {
      asset: 'bilincm-connector-qqmusic-22.52.1-win-x86-framework-dependent.zip',
      downloadUrl: 'https://app.enkianss.us/connectors/v2/download/qqmusic/22.52.1/'
        + 'bilincm-connector-qqmusic-22.52.1-win-x86-framework-dependent.zip'
    })],
    ['asset with a directory', v2Entry({}, { asset: 'x/awoo-connector-qqmusic-22.52.1-win-x86-framework-dependent.zip' })],
    ['minimumCoreVersion below 1.1.10', v2Entry({ minimumCoreVersion: '1.1.9' })],
    ['missing downloadUrl', v2Entry({}, { downloadUrl: undefined })],
    ['numeric downloadUrl', v2Entry({}, { downloadUrl: 42 })],
    ['missing asset', v2Entry({}, { asset: undefined })],
    ['missing sha256', v2Entry({}, { sha256: undefined })],
    ['short sha256', v2Entry({}, { sha256: 'abc' })],
    ['missing signature', v2Entry({}, { signature: undefined })],
    ['numeric signature', v2Entry({}, { signature: 7 })],
    ['zero size', v2Entry({}, { size: 0 })],
    ['string size', v2Entry({}, { size: '6795490' })],
    ['missing package', v2Entry({ package: undefined })],
    ['null package', v2Entry({ package: null })],
    ['missing version', v2Entry({ version: undefined })],
    ['two-part version', v2Entry({ version: '22.52' })],
    ['wrong protocol', v2Entry({ protocolVersion: 2 })],
    ['missing minimumCoreVersion', v2Entry({ minimumCoreVersion: undefined })],
    ['numeric testedPlayerVersion', v2Entry({ testedPlayerVersion: 22 })],
    ['no player version metadata', v2Entry({ testedPlayerVersion: ' ', playerVersionPolicy: undefined })],
    ['wrong id', v2Entry({ id: 'kugou' })]
  ];
  for (const [label, entry] of cases) {
    assert.throws(() => validateV2ConnectorEntry('qqmusic', entry), FIELD_INVALID, label);
  }
  for (const entry of [null, undefined, 'qqmusic', [], 42]) {
    assert.throws(() => validateV2ConnectorEntry('qqmusic', entry), FIELD_INVALID, String(entry));
  }
});

test('transport failures become readable Chinese messages', () => {
  const fetchFailed = cause => Object.assign(new TypeError('fetch failed'), { cause });
  const cases = [
    [fetchFailed({ code: 'ENOTFOUND' }), '无法解析更新服务器地址，请检查网络或代理'],
    [new Error('net::ERR_NAME_NOT_RESOLVED'), '无法解析更新服务器地址，请检查网络或代理'],
    [fetchFailed({ code: 'ECONNREFUSED' }), '连接更新服务器被中断'],
    [fetchFailed({ code: 'ECONNRESET' }), '连接更新服务器被中断'],
    [new Error('net::ERR_CONNECTION_RESET'), '连接更新服务器被中断'],
    [fetchFailed(Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' })), '连接更新服务器超时'],
    [fetchFailed({ code: 'ETIMEDOUT' }), '连接更新服务器超时'],
    [new DOMException('This operation was aborted', 'AbortError'), '连接更新服务器超时'],
    [new DOMException('The operation timed out.', 'TimeoutError'), '连接更新服务器超时'],
    [new Error('net::ERR_TIMED_OUT'), '连接更新服务器超时'],
    [new Error('net::ERR_PROXY_CONNECTION_FAILED'), '无法通过代理连接更新服务器，请检查系统代理设置'],
    [new Error('net::ERR_TUNNEL_CONNECTION_FAILED'), '无法通过代理连接更新服务器，请检查系统代理设置'],
    [new Error('net::ERR_INTERNET_DISCONNECTED'), '网络不可用，请检查网络连接'],
    [new Error('net::ERR_CERT_AUTHORITY_INVALID'), '更新服务器证书校验失败，请检查系统时间或代理设置'],
    [fetchFailed({ cause: { code: 'ENOTFOUND' } }), '无法解析更新服务器地址，请检查网络或代理']
  ];
  for (const [error, message] of cases) {
    assert.equal(describeNetworkError(error), message, String(error.message));
  }
  assert.equal(describeNetworkError(new Error('清单 HTTP 503')), '清单 HTTP 503');
  assert.equal(describeNetworkError(new Error('连接器 v2 更新清单格式或签名密钥标识不兼容')),
    '连接器 v2 更新清单格式或签名密钥标识不兼容');
  assert.equal(describeNetworkError(fetchFailed({ code: 'EUNKNOWN' })), 'fetch failed');
  assert.equal(describeNetworkError('plain failure'), 'plain failure');
});

test('the stale hint names the failure and when the shown catalog was fetched', () => {
  const fetchedAt = new Date(2026, 9, 21, 9, 5).getTime();
  assert.equal(
    describeStaleCatalog('连接更新服务器超时', fetchedAt, new Date(2026, 9, 21, 18, 0).getTime()),
    '更新检查失败：连接更新服务器超时；当前显示 09:05 获取的版本信息'
  );
  assert.equal(
    describeStaleCatalog('连接更新服务器超时', fetchedAt, new Date(2026, 9, 22, 8, 0).getTime()),
    '更新检查失败：连接更新服务器超时；当前显示 10月21日 09:05 获取的版本信息'
  );
});
