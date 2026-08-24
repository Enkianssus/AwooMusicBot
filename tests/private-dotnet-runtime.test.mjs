import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  PrivateDotnetRuntimeManager,
  buildPrivateDotnetEnvironment,
  readDotnetDownloadSize,
  selectDotnetRuntimeArtifact
} from '../electron/private-dotnet-runtime.ts';

const SHA512 = 'a'.repeat(128);

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createStoredZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const [name, value] of entries) {
    const fileName = Buffer.from(name, 'utf8');
    const data = Buffer.from(value);
    const crc = crc32(data);
    const local = Buffer.alloc(30 + fileName.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    fileName.copy(local, 30);
    data.copy(local, 30 + fileName.length);
    localParts.push(local);

    const central = Buffer.alloc(46 + fileName.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(localOffset, 42);
    fileName.copy(central, 46);
    centralParts.push(central);
    localOffset += local.length;
  }

  const central = Buffer.concat(centralParts);
  const local = Buffer.concat(localParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

function runtimeArchive({ padded = false } = {}) {
  const padding = padded ? Buffer.alloc(1024 * 1024 + 1, 0x5a) : Buffer.alloc(0);
  return createStoredZip([
    ['dotnet.exe', 'runtime'],
    ['shared/Microsoft.NETCore.App/8.0.17/coreclr.dll', 'runtime'],
    ...(padding.length ? [['padding.bin', padding]] : [])
  ]);
}

function runtimeMetadata(hash) {
  const metadata = metadataFixture();
  metadata.releases[1].runtime.files[1].hash = hash;
  return metadata;
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function runtimeFetchFixture({ archive, hash, rangeProbeStatus, useHead }) {
  const requests = [];
  const metadata = runtimeMetadata(hash);
  const fetchImpl = async (url, init = {}) => {
    const method = init.method || 'GET';
    const range = new Headers(init.headers || {}).get('Range');
    requests.push({ url, method, range });
    if (url.includes('/release-metadata/')) return jsonResponse(metadata);
    if (method === 'HEAD') {
      if (useHead) {
        return new Response(null, {
          status: 200,
          headers: { 'Content-Length': String(archive.length) }
        });
      }
      return new Response(null, { status: 400 });
    }
    if (range) {
      if (rangeProbeStatus === 200) {
        return new Response(archive, {
          status: 200,
          headers: { 'Content-Length': String(archive.length) }
        });
      }
      if (rangeProbeStatus) return new Response(null, { status: rangeProbeStatus });
      const match = range.match(/^bytes=(\d+)-(\d+)$/);
      assert.ok(match, `unexpected range: ${range}`);
      const start = Number(match[1]);
      const end = Number(match[2]);
      return new Response(archive.subarray(start, end + 1), {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${archive.length}`
        }
      });
    }
    return new Response(archive, {
      status: 200,
      headers: { 'Content-Length': String(archive.length) }
    });
  };
  return { fetchImpl, requests };
}

function metadataFixture() {
  return {
    'channel-version': '8.0',
    'latest-runtime': '8.0.17',
    releases: [
      {
        'release-version': '8.0.16',
        runtime: {
          version: '8.0.16',
          files: [{
            name: 'dotnet-runtime-8.0.16-win-x64.zip',
            rid: 'win-x64',
            url: 'https://builds.dotnet.microsoft.com/dotnet/Runtime/8.0.16/dotnet-runtime.zip',
            hash: SHA512
          }]
        }
      },
      {
        'release-version': '8.0.17',
        runtime: {
          version: '8.0.17',
          files: [
            {
              name: 'dotnet-runtime-8.0.17-win-x86.zip',
              rid: 'win-x86',
              url: 'https://builds.dotnet.microsoft.com/dotnet/Runtime/8.0.17/dotnet-runtime-win-x86.zip',
              hash: SHA512
            },
            {
              name: 'dotnet-runtime-8.0.17-win-x64.zip',
              rid: 'win-x64',
              url: 'https://download.visualstudio.microsoft.com/download/pr/runtime-win-x64.zip',
              hash: SHA512
            }
          ]
        }
      }
    ]
  };
}

test('selects latest runtime archive for the requested RID', () => {
  const artifact = selectDotnetRuntimeArtifact(
    metadataFixture(),
    'win-x64',
    '8.0'
  );
  assert.deepEqual(artifact, {
    channel: '8.0',
    version: '8.0.17',
    rid: 'win-x64',
    url: 'https://download.visualstudio.microsoft.com/download/pr/runtime-win-x64.zip',
    sha512: SHA512,
    name: 'dotnet-runtime-8.0.17-win-x64.zip'
  });
});

test('rejects untrusted hosts, invalid hashes, missing RIDs, and versions', () => {
  const untrustedHost = metadataFixture();
  untrustedHost.releases[1].runtime.files[0].url = 'https://example.com/runtime.zip';
  assert.throws(
    () => selectDotnetRuntimeArtifact(untrustedHost, 'win-x86'),
    /主机不受信任/
  );

  const invalidHash = metadataFixture();
  invalidHash.releases[1].runtime.files[0].hash = 'deadbeef';
  assert.throws(
    () => selectDotnetRuntimeArtifact(invalidHash, 'win-x86'),
    /SHA-512/
  );

  const missingRid = metadataFixture();
  missingRid.releases[1].runtime.files = [
    missingRid.releases[1].runtime.files[1]
  ];
  assert.throws(
    () => selectDotnetRuntimeArtifact(missingRid, 'win-x86'),
    /未找到 win-x86/
  );

  const invalidVersion = metadataFixture();
  invalidVersion['latest-runtime'] = '9.0.1';
  assert.throws(
    () => selectDotnetRuntimeArtifact(invalidVersion, 'win-x64'),
    /最新版本无效/
  );
});

test('builds architecture-specific private runtime environment', () => {
  assert.deepEqual(
    buildPrivateDotnetEnvironment('win-x86', 'runtime/win-x86/8.0.17'),
    {
      DOTNET_ROOT: path.resolve('runtime/win-x86/8.0.17'),
      DOTNET_ROOT_X86: path.resolve('runtime/win-x86/8.0.17'),
      DOTNET_MULTILEVEL_LOOKUP: '0'
    }
  );
  assert.deepEqual(
    buildPrivateDotnetEnvironment('win-x64', 'runtime/win-x64/8.0.17'),
    {
      DOTNET_ROOT: path.resolve('runtime/win-x64/8.0.17'),
      DOTNET_ROOT_X64: path.resolve('runtime/win-x64/8.0.17'),
      DOTNET_MULTILEVEL_LOOKUP: '0'
    }
  );
});

test('uses Content-Range total for a partial HEAD response', () => {
  const headers = new Headers({
    'Content-Length': '20',
    'Content-Range': 'bytes 0-19/30496794'
  });
  assert.equal(readDotnetDownloadSize(206, headers), 30496794);
  assert.equal(
    readDotnetDownloadSize(200, new Headers({ 'Content-Length': '42' })),
    42
  );
});

test('reuses a verified runtime and deduplicates concurrent ensure calls', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awoo-dotnet-runtime-'));
  try {
    const versionRoot = path.join(root, 'win-x64', '8.0.17');
    await fs.mkdir(
      path.join(versionRoot, 'shared', 'Microsoft.NETCore.App', '8.0.17'),
      { recursive: true }
    );
    await fs.writeFile(path.join(versionRoot, 'dotnet.exe'), 'runtime');
    await fs.writeFile(
      path.join(
        versionRoot,
        'shared',
        'Microsoft.NETCore.App',
        '8.0.17',
        'coreclr.dll'
      ),
      'runtime'
    );
    await fs.writeFile(
      path.join(versionRoot, '.awoo-dotnet-runtime.json'),
      JSON.stringify({
        schemaVersion: 1,
        channel: '8.0',
        rid: 'win-x64',
        version: '8.0.17',
        sha512: SHA512
      })
    );

    let calls = 0;
    const runtime = new PrivateDotnetRuntimeManager({
      rootDirectory: root,
      fetchImpl: async () => {
        calls += 1;
        throw new Error('network should not be used for a verified cache');
      },
      onLog: () => undefined
    });
    const [first, second] = await Promise.all([
      runtime.ensure('win-x64'),
      runtime.ensure('win-x64')
    ]);
    assert.equal(first, versionRoot);
    assert.equal(second, versionRoot);
    assert.equal(calls, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('falls back to one streamed full download when the range probe returns HTTP 400', async () => {
  const archive = runtimeArchive();
  const hash = crypto.createHash('sha512').update(archive).digest('hex');
  const { fetchImpl, requests } = runtimeFetchFixture({
    archive,
    hash,
    rangeProbeStatus: 400,
    useHead: false
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awoo-dotnet-runtime-fallback-'));
  const logs = [];
  try {
    const runtime = new PrivateDotnetRuntimeManager({
      rootDirectory: root,
      fetchImpl,
      onLog: message => logs.push(message)
    });
    const installed = await runtime.ensure('win-x64');
    assert.equal(installed, path.join(root, 'win-x64', '8.0.17'));
    assert.equal(
      requests.filter(request => request.range === 'bytes=0-0').length,
      1
    );
    assert.equal(
      requests.filter(request => (
        request.url.endsWith('.zip')
        && request.method === 'GET'
        && !request.range
      )).length,
      1
    );
    assert.equal(logs.some(message => message.includes('改用完整下载')), true);
    assert.equal(
      (await fs.readdir(path.join(root, 'win-x64'))).some(name => name.startsWith('.download-')),
      false
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('still verifies SHA-512 after a streamed full-download fallback', async () => {
  const archive = runtimeArchive();
  const { fetchImpl } = runtimeFetchFixture({
    archive,
    hash: 'b'.repeat(128),
    rangeProbeStatus: 400,
    useHead: false
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awoo-dotnet-runtime-hash-'));
  try {
    const runtime = new PrivateDotnetRuntimeManager({
      rootDirectory: root,
      fetchImpl
    });
    await assert.rejects(
      runtime.ensure('win-x64'),
      /SHA-512 校验失败/
    );
    assert.equal(
      await fs
        .stat(path.join(root, 'win-x64', '8.0.17'))
        .then(() => true)
        .catch(() => false),
      false
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('uses the existing ranged path when the Range probe is valid', async () => {
  const archive = runtimeArchive({ padded: true });
  const hash = crypto.createHash('sha512').update(archive).digest('hex');
  const { fetchImpl, requests } = runtimeFetchFixture({
    archive,
    hash,
    useHead: false
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awoo-dotnet-runtime-ranged-'));
  const logs = [];
  try {
    const runtime = new PrivateDotnetRuntimeManager({
      rootDirectory: root,
      fetchImpl,
      onLog: message => logs.push(message)
    });
    await runtime.ensure('win-x64');
    assert.equal(requests.filter(request => request.range === 'bytes=0-0').length, 1);
    assert.equal(
      requests.filter(request => (
        request.url.endsWith('.zip')
        && request.method === 'GET'
        && request.range
        && request.range !== 'bytes=0-0'
      )).length,
      1
    );
    assert.equal(
      requests.filter(request => (
        request.url.endsWith('.zip')
        && request.method === 'GET'
        && !request.range
      )).length,
      0
    );
    assert.equal(logs.some(message => message.includes('改用完整下载')), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('reuses a complete HTTP 200 Range-probe response without a duplicate GET', async () => {
  const archive = runtimeArchive();
  const hash = crypto.createHash('sha512').update(archive).digest('hex');
  const { fetchImpl, requests } = runtimeFetchFixture({
    archive,
    hash,
    rangeProbeStatus: 200,
    useHead: false
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awoo-dotnet-runtime-200-'));
  try {
    const runtime = new PrivateDotnetRuntimeManager({
      rootDirectory: root,
      fetchImpl
    });
    await runtime.ensure('win-x64');
    assert.equal(requests.filter(request => request.range === 'bytes=0-0').length, 1);
    assert.equal(
      requests.filter(request => (
        request.url.endsWith('.zip')
        && request.method === 'GET'
        && !request.range
      )).length,
      0
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
