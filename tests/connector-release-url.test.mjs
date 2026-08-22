import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  CONNECTOR_GITHUB_REPOSITORY,
  buildConnectorGitHubReleaseUrl
} from '../electron/connector-release-url.ts';

const repositoryRoot = path.resolve(import.meta.dirname, '..');

test('connector direct fallback uses the renamed canonical repository', () => {
  assert.equal(
    CONNECTOR_GITHUB_REPOSITORY,
    'Enkianssus/awoo-connectors'
  );
  assert.equal(
    buildConnectorGitHubReleaseUrl(
      'qqmusic',
      '22.52.1',
      'awoo-connector-qqmusic-22.52.1-win-x86.zip'
    ),
    'https://github.com/Enkianssus/awoo-connectors/releases/download/'
      + 'qqmusic-v22.52.1/awoo-connector-qqmusic-22.52.1-win-x86.zip'
  );
});

test('the updater keeps the public proxy catalog and download endpoints', () => {
  const updaterSource = fs.readFileSync(
    path.join(repositoryRoot, 'electron', 'connector-updater.ts'),
    'utf8'
  );
  assert.match(
    updaterSource,
    /https:\/\/app\.enkianss\.us\/connectors\/v2\/catalog\.json/
  );
  assert.match(
    updaterSource,
    /https:\/\/app\.enkianss\.us\/connectors\/v1\/catalog\.json/
  );
  assert.match(
    updaterSource,
    /https:\/\/app\.enkianss\.us\/connectors\/v1\/download\//
  );
  assert.match(
    updaterSource,
    /https:\/\/app\.enkianss\.us\/connectors\/v2\/download\//
  );
  assert.doesNotMatch(
    updaterSource,
    /github\.com\/Enkianssus\/BiliNCM-Connectors\//
  );
});
