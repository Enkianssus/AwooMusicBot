import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const connectorRoot = path.join(repositoryRoot, 'BiliNCM-Connectors');
// An app-only checkout skips the connector contracts; CI sets
// AWOO_REQUIRE_CONNECTOR_CONTRACTS=1 so a missing checkout fails instead.
const checkConnectorContracts = fs.existsSync(connectorRoot)
  || process.env.AWOO_REQUIRE_CONNECTOR_CONTRACTS === '1';
const contractTest = checkConnectorContracts ? test : () => {};
if (!checkConnectorContracts) {
  test.skip('connector contracts not checked out');
}
const hash = 'a'.repeat(64);
const signature = Buffer.alloc(64, 1).toString('base64');

function withTemporaryDirectory(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awoo-catalog-test-'));
  try {
    callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function runScript(script, args, cwd) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

contractTest('future connector catalogs prefer Awoo packages and retain old-core aliases', () => {
  withTemporaryDirectory(directory => {
    fs.writeFileSync(
      path.join(directory, 'catalog.json'),
      JSON.stringify({ connectors: { kugou: null } })
    );
    runScript(
      path.join(connectorRoot, 'scripts', 'update-catalog.mjs'),
      [
        'kugou',
        '20.0.81.5',
        'awoo-connector-kugou-20.0.81.5-win-x86.zip',
        hash,
        signature,
        '101',
        'bilincm-connector-kugou-20.0.81.5-win-x86.zip',
        hash,
        signature,
        '102',
        'win-x86',
        'awoo-connector-kugou-20.0.81.5-win-x86-framework-dependent.zip',
        hash,
        signature,
        '51',
        'bilincm-connector-kugou-20.0.81.5-win-x86-framework-dependent.zip',
        hash,
        signature,
        '52',
        '8.0'
      ],
      directory
    );
    const entry = JSON.parse(fs.readFileSync(
      path.join(directory, 'catalog.json'),
      'utf8'
    )).connectors.kugou;
    assert.equal(
      entry.asset,
      'bilincm-connector-kugou-20.0.81.5-win-x86.zip'
    );
    assert.equal(
      entry.awooPackage.asset,
      'awoo-connector-kugou-20.0.81.5-win-x86.zip'
    );
    assert.equal(
      entry.awooFrameworkDependent.asset,
      'awoo-connector-kugou-20.0.81.5-win-x86-framework-dependent.zip'
    );
  });
});

contractTest('future QQ profile catalogs expose an Awoo package without breaking old cores', () => {
  withTemporaryDirectory(directory => {
    const legacy = {
      id: 'qqmusic', version: '1.3.0', schemaVersion: 1, minimumConnectorVersion: '22.51.1',
      asset: 'bilincm-qqmusic-profiles-1.3.0.zip', size: 11, sha256: hash, signature,
      downloadUrl: 'https://app.enkianss.us/connectors/v1/profiles/qqmusic/download/1.3.0/bilincm-qqmusic-profiles-1.3.0.zip',
      awooPackage: { asset: 'awoo-qqmusic-profiles-1.3.0.zip', size: 11, sha256: hash, signature }
    };
    fs.writeFileSync(
      path.join(directory, 'qqmusic-profile-catalog.json'),
      JSON.stringify({ schemaVersion: 1, publicKeyId: 'bilincm-connectors-2026-01',
        repository: 'Enkianssus/awoo-connectors', profiles: { qqmusic: legacy } })
    );
    runScript(
      path.join(connectorRoot, 'scripts', 'update-profile-catalog.mjs'),
      [
        '1.4.0',
        'awoo-qqmusic-profiles-1.4.0.zip',
        hash,
        signature,
        '11',
        'bilincm-qqmusic-profiles-1.4.0.zip',
        hash,
        signature,
        '11'
      ],
      directory
    );
    const catalog = JSON.parse(fs.readFileSync(
      path.join(directory, 'qqmusic-profile-catalog.json'),
      'utf8'
    ));
    assert.equal(catalog.schemaVersion, 1);
    assert.equal(catalog.publicKeyId, 'bilincm-connectors-2026-01');
    assert.deepEqual(catalog.profiles.qqmusic, legacy, 'old cores keep exactly their signed schema 1 entry');
    const entry = catalog.profiles.qqmusicV2;
    assert.equal(entry.schemaVersion, 2);
    assert.equal(entry.minimumConnectorVersion, '22.76.1');
    assert.equal(entry.asset, 'bilincm-qqmusic-profiles-1.4.0.zip');
    assert.equal(
      entry.awooPackage.asset,
      'awoo-qqmusic-profiles-1.4.0.zip'
    );
  });
});

contractTest('all newly built connector assemblies use Awoo executable names', () => {
  for (const player of ['Netease', 'Kugou', 'QQMusic', 'Folia']) {
    const project = fs.readFileSync(
      path.join(
        connectorRoot,
        'src',
        player,
        `BiliNCM.Connector.${player}.csproj`
      ),
      'utf8'
    );
    assert.match(
      project,
      new RegExp(`<AssemblyName>Awoo\\.Connector\\.${player}</AssemblyName>`)
    );
  }
});

contractTest('connector proxy uses the renamed repository without changing public contracts', () => {
  const workerSource = fs.readFileSync(
    path.join(connectorRoot, 'cloudflare', 'appdownload', 'worker.js'),
    'utf8'
  );
  assert.match(
    workerSource,
    /const CONNECTOR_REPO = 'Enkianssus\/awoo-connectors';/
  );
  assert.doesNotMatch(
    workerSource,
    /Enkianssus\/BiliNCM-Connectors/
  );
  assert.match(
    workerSource,
    /\/connectors\/v1\/catalog\.json/
  );
  assert.match(
    workerSource,
    /qqmusic-profiles-v\$\{version\}/
  );
  assert.match(
    workerSource,
    /\$\{connectorId\}-v\$\{version\}/
  );

  for (const fileName of ['catalog.json', 'qqmusic-profile-catalog.json']) {
    const catalog = JSON.parse(fs.readFileSync(
      path.join(connectorRoot, fileName),
      'utf8'
    ));
    assert.equal(catalog.repository, 'Enkianssus/awoo-connectors');
    assert.equal(catalog.publicKeyId, 'bilincm-connectors-2026-01');
  }
});
