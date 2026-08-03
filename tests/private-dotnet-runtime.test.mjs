import test from 'node:test';
import assert from 'node:assert/strict';
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
