import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNeteaseConnectorSuccessMessage,
  shouldWaitForConnectorPlayer
} from '../src/connector-update-feedback-policy.ts';

test('does not wait for a player that was already closed before NetEase install', () => {
  const lifecycle = { neteasePlayerWasRunning: false };
  assert.equal(
    shouldWaitForConnectorPlayer('netease', lifecycle),
    false
  );
  assert.match(
    buildNeteaseConnectorSuccessMessage('reinstall', lifecycle),
    /^✅ .*网易云未启动/
  );
});

test('does not turn a successful connector install into a warning on restart failure', () => {
  const lifecycle = {
    neteasePlayerWasRunning: true,
    neteasePlayerRestarted: false
  };
  assert.equal(
    shouldWaitForConnectorPlayer('netease', lifecycle),
    false
  );
  assert.match(
    buildNeteaseConnectorSuccessMessage('update', lifecycle),
    /^✅ .*自动启动失败/
  );
});

test('waits only when NetEase was restored or lifecycle is still unknown', () => {
  assert.equal(shouldWaitForConnectorPlayer('netease', {
    neteasePlayerWasRunning: true,
    neteasePlayerRestarted: true
  }), true);
  assert.equal(shouldWaitForConnectorPlayer('netease', {}), true);
  assert.equal(shouldWaitForConnectorPlayer('qqmusic', {
    neteasePlayerWasRunning: false
  }), true);
});
