import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as profilePolicy from '../electron/qq-profile-policy.ts';
import * as branding from '../electron/connector-branding-policy.ts';
import {
  selectQqProfileEntry, validateQqProfileDocument, verifyQqProfileArchive
} from '../electron/qq-profile-policy.ts';

const legacy = { schemaVersion: 1, minimumConnectorVersion: '22.60.2', version: '1.3.0' };
const current = { schemaVersion: 2, minimumConnectorVersion: '22.76.1', version: '1.4.0' };
test('new cores choose signed-profile schema by installed connector minimum, preserving legacy entry', () => {
  assert.equal(selectQqProfileEntry(legacy, current, '22.71.5'), legacy);
  assert.equal(selectQqProfileEntry(legacy, current, '22.76.1'), current);
  assert.equal(selectQqProfileEntry(legacy, current, '22.76.2'), current);
  assert.equal(selectQqProfileEntry(legacy, null, '22.76.1'), legacy);
  assert.equal(selectQqProfileEntry(legacy, current, '22.60.1'), null);
  assert.throws(() => selectQqProfileEntry(legacy, { ...current, schemaVersion: 3 }, '22.76.1'));
  assert.throws(() => selectQqProfileEntry(legacy, { ...current, minimumConnectorVersion: '22.*' }, '22.76.1'));
});

const document = {
  schemaVersion: 2, fileVersion: '22.76', clientSha256: '1'.repeat(64), commonSha256: '2'.repeat(64),
  apiSha256: '3'.repeat(64), abiContract: 'qqmusic-addsongs-cstring-v1', transportContract: 'type4-songid-v1',
  stringManagerGetterRva: '0x200', expectedPlayDispatchBytes: 'E8 01 02 03 04',
  ...Object.fromEntries(['singleSongPlayDispatchRva', 'getCatManagerRva', 'getQqUinExRva',
    'songItemConstructorRva', 'songItemDestructorRva', 'addSongsRva', 'hiddenCategoryIdRva',
    'getListRootRva', 'getListHelperRva', 'getCategoryCountRva', 'songItemSize'].map(k => [k, '0xA0']))
};
test('schema 2 pack accepts strict new profiles together with existing schema 1 profiles', () => {
  validateQqProfileDocument(document, '22.76.json', 2);
  validateQqProfileDocument({ ...document, schemaVersion: 1, fileVersion: '22.61' }, '22.61.json', 2);
  validateQqProfileDocument({ ...document, schemaVersion: 1 }, '22.76.json', 1);
  assert.throws(() => validateQqProfileDocument(document, '22.76.json', 1));
});
test('invalid schema, filenames, binary fingerprints, addresses and ABI contracts are rejected', () => {
  for (const changes of [
    { schemaVersion: 3 }, { apiSha256: '' }, { clientSha256: 'x'.repeat(64) },
    { commonSha256: null }, { abiContract: 'unknown' }, { transportContract: 'unknown' },
    { stringManagerGetterRva: undefined }, { stringManagerGetterRva: '0' },
    { addSongsRva: '-1' }, { songItemSize: '0x80000000' }, { expectedPlayDispatchBytes: 'E8 01' }
  ]) assert.throws(() => validateQqProfileDocument({ ...document, ...changes }, '22.76.json', 2));
  assert.throws(() => validateQqProfileDocument(document, '22.71.json', 2));
  assert.throws(() => validateQqProfileDocument(document, '../22.76.json', 2));
});
test('schema 2 archive still requires the correct Ed25519 signer and exact signed bytes', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const archive = Buffer.from(JSON.stringify(document));
  const entry = { size: archive.length, sha256: crypto.createHash('sha256').update(archive).digest('hex'),
    signature: crypto.sign(null, archive, privateKey).toString('base64') };
  verifyQqProfileArchive(archive, entry, publicKey);
  assert.throws(() => verifyQqProfileArchive(archive, { ...entry, signature: Buffer.alloc(64).toString('base64') }, publicKey), /签名/);
  assert.throws(() => verifyQqProfileArchive(archive, entry, crypto.generateKeyPairSync('ed25519').publicKey), /签名/);
  assert.throws(() => verifyQqProfileArchive(archive, { ...entry, sha256: '0'.repeat(64) }, publicKey), /SHA-256/);
  assert.throws(() => verifyQqProfileArchive(Buffer.concat([archive, Buffer.from('x')]), entry, publicKey), /大小/);
});

async function installHarness({ connectorVersion = '22.76.1', active = null,
  badSignature = false, profile = document, networkError = null, catalogJsonError = null,
  catalogStatus = 200, cachedText = null, cachedRealDirectory = null, launchEnvironment = false } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const archive = Buffer.from(JSON.stringify(profile));
  function entry(schemaVersion, version, minimumConnectorVersion) {
    const asset = `awoo-qqmusic-profiles-${version}.zip`;
    return { id: 'qqmusic', schemaVersion, version, minimumConnectorVersion, asset,
      size: archive.length, sha256: crypto.createHash('sha256').update(archive).digest('hex'),
      signature: badSignature ? Buffer.alloc(64).toString('base64') : crypto.sign(null, archive, privateKey).toString('base64'),
      downloadUrl: `https://app.enkianss.us/connectors/v1/profiles/qqmusic/download/${version}/${asset}` };
  }
  const catalog = { schemaVersion: 1, publicKeyId: 'bilincm-connectors-2026-01',
    profiles: { qqmusic: entry(1, '1.3.0', '22.60.2'), qqmusicV2: entry(2, '1.4.0', '22.76.1') } };
  const root = path.resolve('test-profile-root');
  const files = new Map(active ? [[active.directory, true]] : []);
  if (active) files.set(path.join(active.directory, `${profile.fileVersion}.json`), cachedText ?? JSON.stringify(profile));
  const requests = [];
  const logs = [];
  let verified = false;
  let extracted = 0;
  let activation = null;
  const fakeFs = { promises: {
    mkdir: async name => files.set(name, true),
    writeFile: async (name, data) => files.set(name, data),
    access: async name => { if (!files.has(name)) throw new Error('ENOENT'); },
    rm: async name => files.delete(name),
    readFile: async name => files.get(name),
    realpath: async name => name === active?.directory && cachedRealDirectory ? cachedRealDirectory : name,
    readdir: async (_name, options) => options?.withFileTypes
      ? [{ name: `${profile.fileVersion}.json`, isFile: () => true, isSymbolicLink: () => false }]
      : [`${profile.fileVersion}.json`],
    rename: async (from, to) => { files.set(to, files.get(from)); files.delete(from); }
  } };
  const source = fs.readFileSync(new URL('../electron/connector-updater.ts', import.meta.url), 'utf8');
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, {
    module, exports: module.exports, Buffer, URL, AbortController, setTimeout, clearTimeout, process: { env: {} },
    fetch: async url => {
      requests.push(url);
      if (url.endsWith('catalog.json') && networkError) throw networkError;
      return url.endsWith('catalog.json')
        ? { ok: catalogStatus === 200, status: catalogStatus, json: async () => {
          if (catalogJsonError) throw catalogJsonError;
          return catalog;
        } }
        : { ok: true, arrayBuffer: async () => archive };
    },
    require: name => {
      if (name === 'node:fs') return { default: fakeFs };
      if (name === 'node:path') return { default: path };
      if (name === 'node:crypto') return { default: crypto };
      if (name === './connector-branding-policy') return branding;
      if (name === './dev-user-data-policy') return { shouldRunAutomaticConnectorMaintenance: () => true };
      if (name === './qq-profile-policy') return { ...profilePolicy,
        verifyQqProfileArchive: (data, descriptor, actualPublicKey) => {
          // The installer always supplies its pinned production key. Substitute
          // only the fixture signer at this I/O boundary, never skip verification.
          assert.match(actualPublicKey, /MCowBQYDK2VwAyEApFy\/TMxhGKlxzOS2b1gjvQxnvFhjefK0sbxsCXFS2uc=/);
          profilePolicy.verifyQqProfileArchive(data, descriptor, publicKey);
          verified = true;
        } };
      if (name === './safe-zip.ts') return { extractZipSafely: async (_archive, staging) => {
        assert.equal(verified, true, 'signature verification precedes extraction');
        extracted++;
        files.set(staging, true);
        files.set(path.join(staging, `${profile.fileVersion}.json`), JSON.stringify(profile));
      } };
      return {};
    }
  });
  const updater = Object.create(module.exports.ConnectorUpdater.prototype);
  Object.assign(updater, {
    readActiveQQMusicProfiles: async () => active,
    readActive: async () => ({ version: connectorVersion }),
    getQQMusicProfileRoot: () => root,
    writeActiveQQMusicProfiles: async value => { activation = value; }, onLog: message => logs.push(message)
  });
  let error = null;
  let result = null;
  try {
    result = launchEnvironment ? await updater.getLaunchEnvironment('qqmusic') : await updater.ensureQQMusicProfilesInternal();
  } catch (caught) { error = caught; }
  return { requests, activation, extracted, error, result, root, logs };
}

test('real updater selects v2, verifies and validates it before activation', async () => {
  const result = await installHarness();
  assert.equal(result.error, null);
  assert.match(result.requests[1], /\/1\.4\.0\//);
  assert.equal(result.activation.schemaVersion, 2);
  assert.equal(result.activation.minimumConnectorVersion, '22.76.1');
  assert.equal(result.result, path.join(result.root, '1.4.0'));
});

test('real updater does not hand an active schema 2 cache to an older connector', async () => {
  const result = await installHarness({ connectorVersion: '22.71.5',
    profile: { ...document, schemaVersion: 1 },
    active: { version: '1.4.0', schemaVersion: 2, directory: path.resolve('test-profile-root/1.4.0') } });
  assert.equal(result.error, null);
  assert.match(result.requests[1], /\/1\.3\.0\//);
  assert.equal(result.activation.schemaVersion, 1);
});

test('real updater rejects bad signatures before extraction and unknown profiles before activation', async () => {
  const signature = await installHarness({ badSignature: true });
  assert.match(signature.error.message, /签名/);
  assert.equal(signature.extracted, 0);
  assert.equal(signature.activation, null);
  const schema = await installHarness({ profile: { ...document, schemaVersion: 3 } });
  assert.match(schema.error.message, /画像文件无效/);
  assert.equal(schema.activation, null);
});

const cachedV2 = { version: '1.4.0', schemaVersion: 2, minimumConnectorVersion: '22.76.1',
  directory: path.resolve('test-profile-root/1.4.0') };
test('offline catalog fetch revalidates compatible active profiles and logs use of cache', async () => {
  for (const networkError of [new TypeError('fetch failed'), new DOMException('timeout', 'TimeoutError')]) {
    const result = await installHarness({ active: cachedV2, networkError, launchEnvironment: true });
    assert.equal(result.error, null);
    assert.equal(result.result.BILINCM_QQMUSIC_PROFILE_DIR, cachedV2.directory);
    assert.equal(result.requests.length, 1);
    assert.equal(result.extracted, 0);
    assert.match(result.logs[0], /使用缓存画像 1\.4\.0/);
  }
});
test('offline launch with no compatible cache keeps bundled profiles', async () => {
  for (const options of [{}, { active: cachedV2, connectorVersion: '22.71.5' }]) {
    const result = await installHarness({ ...options, networkError: new TypeError('offline'), launchEnvironment: true });
    assert.equal(result.result.BILINCM_QQMUSIC_PROFILE_DIR, undefined);
    assert.ok(result.logs.some(message => /继续使用连接器内置画像/.test(message)));
    assert.ok(result.logs.every(message => !/使用缓存画像/.test(message)));
  }
});
test('historical schema 1 cache uses its original minimum; schema 2 requires explicit minimum', async () => {
  const legacyCache = { version: '1.3.0', directory: path.resolve('test-profile-root/1.3.0') };
  const accepted = await installHarness({ active: legacyCache, profile: { ...document, schemaVersion: 1 },
    connectorVersion: '22.51.1', networkError: new TypeError('offline') });
  assert.equal(accepted.result, legacyCache.directory);
  const rejected = await installHarness({ active: { ...cachedV2, minimumConnectorVersion: undefined },
    networkError: new TypeError('offline') });
  assert.match(rejected.error.message, /最低版本/);
});
test('broken, unknown or out-of-root cache does not turn network failure into success', async () => {
  for (const options of [
    { cachedText: '{broken' }, { profile: { ...document, schemaVersion: 3 } },
    { cachedRealDirectory: path.resolve('outside-profile-root/1.4.0') },
    { active: { ...cachedV2, schemaVersion: 3 } }
  ]) {
    const result = await installHarness({ active: cachedV2, ...options, networkError: new TypeError('offline') });
    assert.notEqual(result.error, null);
    assert.equal(result.result, null);
    assert.ok(result.logs.every(message => !/使用缓存画像/.test(message)));
  }
});
test('invalid catalog JSON, HTTP errors and bad new signatures never fall back to active cache', async () => {
  for (const options of [
    { catalogJsonError: new SyntaxError('invalid JSON') }, { catalogStatus: 500 },
    { badSignature: true, active: { ...cachedV2, version: '1.3.9', directory: path.resolve('test-profile-root/1.3.9') } }
  ]) {
    const result = await installHarness({ active: cachedV2, ...options });
    assert.notEqual(result.error, null);
    assert.equal(result.result, null);
    assert.ok(result.logs.every(message => !/使用缓存画像/.test(message)));
  }
});
