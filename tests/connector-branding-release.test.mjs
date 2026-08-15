import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const connectorRoot = path.join(repositoryRoot, 'BiliNCM-Connectors');
const hash = 'a'.repeat(64);
const signature = Buffer.from('signed').toString('base64');

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

test('future connector catalogs prefer Awoo packages and retain old-core aliases', () => {
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

test('future QQ profile catalogs expose an Awoo package without breaking old cores', () => {
  withTemporaryDirectory(directory => {
    fs.writeFileSync(
      path.join(directory, 'qqmusic-profile-catalog.json'),
      JSON.stringify({ profiles: { qqmusic: null } })
    );
    runScript(
      path.join(connectorRoot, 'scripts', 'update-profile-catalog.mjs'),
      [
        '1.2.0',
        'awoo-qqmusic-profiles-1.2.0.zip',
        hash,
        signature,
        '11',
        'bilincm-qqmusic-profiles-1.2.0.zip',
        hash,
        signature,
        '11'
      ],
      directory
    );
    const entry = JSON.parse(fs.readFileSync(
      path.join(directory, 'qqmusic-profile-catalog.json'),
      'utf8'
    )).profiles.qqmusic;
    assert.equal(entry.asset, 'bilincm-qqmusic-profiles-1.2.0.zip');
    assert.equal(
      entry.awooPackage.asset,
      'awoo-qqmusic-profiles-1.2.0.zip'
    );
  });
});

test('all newly built connector assemblies use Awoo executable names', () => {
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
