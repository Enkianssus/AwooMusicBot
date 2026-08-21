import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPlayerProcessAccessHint,
  buildPlayerUpgradeHint,
  compareNumericPlayerVersions
} from '../electron/player-upgrade-hint-policy.ts';

const base = {
  playerKey: 'netease',
  connected: true,
  playerVersion: '3.1.36.205322',
  testedPlayerVersion: '3.1.37.205354',
  command: 'PlaySelected',
  outcome: 'rejected',
  processId: 45592
};

test('compares dotted numeric player versions by numeric segment', () => {
  assert.equal(compareNumericPlayerVersions('3.1.36.205322', '3.1.37.205354'), -1);
  assert.equal(compareNumericPlayerVersions('3.1.37.205354', '3.1.37.205354'), 0);
  assert.equal(compareNumericPlayerVersions('3.1.38', '3.1.37.205354'), 1);
  assert.equal(compareNumericPlayerVersions('3.1.*', '3.1.37.205354'), null);
});

test('suggests upgrading after old NetEase playback controls fail', () => {
  const play = buildPlayerUpgradeHint(base);
  const insert = buildPlayerUpgradeHint({
    ...base,
    command: 'InsertNext'
  });
  assert.equal(play?.currentVersion, '3.1.36.205322');
  assert.equal(play?.testedPlayerVersion, '3.1.37.205354');
  assert.equal(play?.processId, 45592);
  assert.equal(insert?.blockedCommand, 'InsertNext');
});

test('suggests upgrading QQ Music 21.21 after playback controls fail', () => {
  for (const command of ['PlaySelected', 'InterruptSelected', 'InsertNext']) {
    const hint = buildPlayerUpgradeHint({
      ...base,
      playerKey: 'qqmusic',
      playerVersion: '21.21',
      testedPlayerVersion: '22.22 / 22.41 / 22.51 / 22.52',
      command
    });
    assert.equal(hint?.code, 'qqmusic-player-update-suggested');
    assert.equal(hint?.playerName, 'QQ 音乐');
    assert.equal(hint?.currentVersion, '21.21');
    assert.equal(
      hint?.testedPlayerVersion,
      '22.22 / 22.41 / 22.51 / 22.52'
    );
    assert.equal(hint?.blockedCommand, command);
  }
});

test('does not mistake supported QQ Music failures for an old version', () => {
  for (const playerVersion of ['22.22', '22.41', '22.51', '22.52', '23.1']) {
    assert.equal(buildPlayerUpgradeHint({
      ...base,
      playerKey: 'qqmusic',
      playerVersion,
      testedPlayerVersion: '22.22 / 22.41 / 22.51 / 22.52'
    }), null);
  }
  assert.equal(buildPlayerUpgradeHint({
    ...base,
    playerKey: 'qqmusic',
    playerVersion: '22.51',
    testedPlayerVersion: '22.22 / 22.41 / 22.51 / 22.52',
    failureCode: 'process-access-denied'
  }), null);
});

test('suggests upgrading an older KuGou player only after a rejected request control', () => {
  for (const command of ['PlaySelected', 'InsertNext']) {
    const hint = buildPlayerUpgradeHint({
      ...base,
      playerKey: 'kugou',
      playerVersion: '20.0.80.0',
      testedPlayerVersion: '20.0.81.27563',
      command
    });
    assert.equal(hint?.kind, 'upgrade');
    assert.equal(hint?.code, 'kugou-player-update-suggested');
    assert.equal(hint?.playerName, '酷狗音乐');
    assert.equal(hint?.blockedCommand, command);
  }
});

test('does not infer an old KuGou player from unsupported, uncertain, or unrelated controls', () => {
  const kugou = {
    ...base,
    playerKey: 'kugou',
    playerVersion: '20.0.80.0',
    testedPlayerVersion: '20.0.81.27563'
  };
  for (const outcome of ['unsupported', 'indeterminate', 'error']) {
    assert.equal(buildPlayerUpgradeHint({ ...kugou, outcome }), null);
  }
  for (const command of ['InterruptSelected', 'Previous', 'Pause', 'Next']) {
    assert.equal(buildPlayerUpgradeHint({ ...kugou, command }), null);
  }
  for (const playerVersion of ['20.0.81.27563', '20.0.82', '21.0']) {
    assert.equal(buildPlayerUpgradeHint({ ...kugou, playerVersion }), null);
  }
});

test('detects structured QQ process access denial without treating it as an upgrade', () => {
  const input = {
    ...base,
    playerKey: 'qqmusic',
    playerVersion: '21.21',
    failureCode: 'process-access-denied'
  };
  const access = buildPlayerProcessAccessHint(input);
  assert.equal(access?.kind, 'process-access');
  assert.equal(access?.code, 'qqmusic-control-access-denied');
  assert.equal(access?.operation, '播放器进程控制');
  assert.equal(buildPlayerUpgradeHint(input), null);
});

test('recognizes access denial from the currently released QQ connector safely', () => {
  const access = buildPlayerProcessAccessHint({
    ...base,
    playerKey: 'qqmusic',
    playerVersion: '22.51',
    message: 'Win32Exception: WriteProcessMemory failed: Access denied (Win32=5)'
  });
  assert.equal(access?.operation, 'WriteProcessMemory');
  assert.equal(buildPlayerProcessAccessHint({
    ...base,
    playerKey: 'qqmusic',
    message: 'unrelated failure (Win32=5)'
  }), null);
});

test('does not show process access guidance for success, other players, or ordinary profile rejection', () => {
  const accessBase = {
    ...base,
    playerKey: 'qqmusic',
    playerVersion: '22.51',
    failureCode: 'process-access-denied'
  };
  assert.equal(buildPlayerProcessAccessHint({ ...accessBase, outcome: 'verified' }), null);
  assert.equal(buildPlayerProcessAccessHint({ ...accessBase, playerKey: 'kugou' }), null);
  assert.equal(buildPlayerProcessAccessHint({ ...accessBase, command: 'Next' }), null);
  assert.equal(buildPlayerProcessAccessHint({
    ...accessBase,
    failureCode: '',
    message: 'QQ 音乐 21.21 没有经过校准的画像'
  }), null);
});

test('does not warn for successful or inconclusive control results', () => {
  for (const outcome of ['accepted', 'applied', 'verified', 'indeterminate']) {
    assert.equal(buildPlayerUpgradeHint({ ...base, outcome }), null);
  }
});

test('does not warn for unrelated commands, players, or disconnection', () => {
  assert.equal(buildPlayerUpgradeHint({ ...base, command: 'Next' }), null);
  assert.equal(buildPlayerUpgradeHint({ ...base, playerKey: 'folia' }), null);
  assert.equal(buildPlayerUpgradeHint({ ...base, connected: false }), null);
});

test('does not guess when the player is tested, newer, or malformed', () => {
  assert.equal(buildPlayerUpgradeHint({
    ...base,
    playerVersion: '3.1.37.205354'
  }), null);
  assert.equal(buildPlayerUpgradeHint({
    ...base,
    playerVersion: '3.1.38.0'
  }), null);
  assert.equal(buildPlayerUpgradeHint({
    ...base,
    playerVersion: 'unknown'
  }), null);
});

test('supports a future structured unsupported-version error code', () => {
  const hint = buildPlayerUpgradeHint({
    ...base,
    playerVersion: '',
    failureCode: 'player-version-unsupported'
  });
  assert.equal(hint?.reason, 'player-version-unsupported');
  assert.equal(hint?.currentVersion, '未知');
});
