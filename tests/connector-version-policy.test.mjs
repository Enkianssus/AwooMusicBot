import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canAutoUpdateConnector,
  classifyConnectorUpdate,
  requiresManualConnectorUpdate
} from '../electron/connector-version-policy.ts';

test('missing connectors install automatically', () => {
  assert.equal(classifyConnectorUpdate(null, '1.5.0'), 'install');
  assert.equal(canAutoUpdateConnector(null, '1.5.0'), true);
});

test('a higher patch on the same player branch updates automatically', () => {
  assert.equal(classifyConnectorUpdate('1.5.0', '1.5.1'), 'patch');
  assert.equal(canAutoUpdateConnector('1.5.0', '1.5.1'), true);
  assert.equal(requiresManualConnectorUpdate('1.5.0', '1.5.1'), false);
});

test('a higher player branch is manual only', () => {
  assert.equal(classifyConnectorUpdate('1.4.9', '1.5.0'), 'player');
  assert.equal(canAutoUpdateConnector('1.4.9', '1.5.0'), false);
  assert.equal(requiresManualConnectorUpdate('1.4.9', '1.5.0'), true);
});

test('a higher major connector protocol is also manual only', () => {
  assert.equal(classifyConnectorUpdate('1.9.9', '2.0.0'), 'major');
  assert.equal(canAutoUpdateConnector('1.9.9', '2.0.0'), false);
  assert.equal(requiresManualConnectorUpdate('1.9.9', '2.0.0'), true);
});

test('older and malformed catalog versions never update', () => {
  assert.equal(classifyConnectorUpdate('1.5.1', '1.5.0'), 'none');
  assert.equal(classifyConnectorUpdate('1.5.1', 'invalid'), 'none');
  assert.equal(canAutoUpdateConnector('1.5.1', '1.5.0'), false);
});

test('a higher KuGou connector revision updates automatically', () => {
  assert.equal(
    classifyConnectorUpdate('20.0.81.1', '20.0.81.2'),
    'patch'
  );
  assert.equal(canAutoUpdateConnector('20.0.81.1', '20.0.81.2'), true);
});

test('a different KuGou player branch remains manual', () => {
  assert.equal(
    classifyConnectorUpdate('20.0.81.9', '20.0.82.1'),
    'player'
  );
  assert.equal(
    requiresManualConnectorUpdate('20.0.81.9', '20.0.82.1'),
    true
  );
});

test('legacy connector version migrates to player-scoped version once', () => {
  assert.equal(classifyConnectorUpdate('1.5.5', '20.0.81.1'), 'patch');
  assert.equal(canAutoUpdateConnector('1.5.5', '20.0.81.1'), true);
});

test('NetEase keeps its full player build and updates only the revision', () => {
  assert.equal(
    classifyConnectorUpdate(
      '3.1.37.205354.1',
      '3.1.37.205354.2',
      'netease'
    ),
    'patch'
  );
  assert.equal(
    classifyConnectorUpdate(
      '3.1.37.205354.9',
      '3.1.38.205900.1',
      'netease'
    ),
    'player'
  );
});

test('QQ uses its player branch plus connector revision', () => {
  assert.equal(
    classifyConnectorUpdate('22.41.1', '22.41.2', 'qqmusic'),
    'patch'
  );
  assert.equal(
    classifyConnectorUpdate('22.41.9', '22.42.1', 'qqmusic'),
    'player'
  );
  assert.equal(
    canAutoUpdateConnector('1.4.1', '22.41.1', 'qqmusic'),
    true
  );
});
