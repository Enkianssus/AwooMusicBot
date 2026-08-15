import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AWOO_CONNECTOR_EXECUTABLE_NAMES,
  connectorAssetNames,
  connectorExecutableNames,
  isRecognizedConnectorAssetName,
  isRecognizedQQMusicProfileAssetName,
  qqMusicProfileAssetNames
} from '../electron/connector-branding-policy.ts';

test('new connector executables use the Awoo brand', () => {
  assert.equal(
    AWOO_CONNECTOR_EXECUTABLE_NAMES.qqmusic,
    'Awoo.Connector.QQMusic.exe'
  );
  assert.deepEqual(connectorExecutableNames('netease'), [
    'Awoo.Connector.Netease.exe',
    'BiliNCM.Connector.Netease.exe'
  ]);
});

test('new connector archives use Awoo names while old signed catalogs remain valid', () => {
  const names = connectorAssetNames(
    'kugou',
    '20.0.81.5',
    'win-x86',
    true
  );
  assert.deepEqual(names, [
    'awoo-connector-kugou-20.0.81.5-win-x86-framework-dependent.zip',
    'bilincm-connector-kugou-20.0.81.5-win-x86-framework-dependent.zip'
  ]);
  for (const name of names) {
    assert.equal(isRecognizedConnectorAssetName(
      name,
      'kugou',
      '20.0.81.5',
      'win-x86',
      true
    ), true);
  }
  assert.equal(isRecognizedConnectorAssetName(
    'other.zip',
    'kugou',
    '20.0.81.5',
    'win-x86',
    true
  ), false);
});

test('QQ Music profile archives migrate to Awoo without breaking old releases', () => {
  assert.deepEqual(qqMusicProfileAssetNames('1.2.0'), [
    'awoo-qqmusic-profiles-1.2.0.zip',
    'bilincm-qqmusic-profiles-1.2.0.zip'
  ]);
  assert.equal(isRecognizedQQMusicProfileAssetName(
    'awoo-qqmusic-profiles-1.2.0.zip',
    '1.2.0'
  ), true);
  assert.equal(isRecognizedQQMusicProfileAssetName(
    'bilincm-qqmusic-profiles-1.2.0.zip',
    '1.2.0'
  ), true);
});
