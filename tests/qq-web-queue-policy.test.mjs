import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { ownsQqLogicalNext } from '../electron/qq-web-queue-policy.ts';
import { planQueueHeadMutation } from '../electron/queue-head-policy.ts';

test('only an explicit QQ connector ownership receipt disables host automatic correction', () => {
  assert.equal(ownsQqLogicalNext('qqmusic', { ownsLogicalNext: true }), true);
  for (const player of ['netease', 'kugou', 'folia', '', 'QQMusic']) {
    assert.equal(ownsQqLogicalNext(player, { ownsLogicalNext: true }), false);
  }
  for (const value of [false, undefined, null, 0, 1, 'true']) {
    assert.equal(ownsQqLogicalNext('qqmusic', { ownsLogicalNext: value }), false);
  }
  assert.equal(ownsQqLogicalNext('qqmusic', null), false);
  assert.equal(ownsQqLogicalNext('qqmusic', undefined), false);
  assert.equal(ownsQqLogicalNext('qqmusic', {}), false);
});

test('anchor independence and readiness do not imply logical-next ownership', () => {
  for (const playbackAnchorReady of [false, true, undefined]) {
    assert.equal(ownsQqLogicalNext('qqmusic', {
      requiresPlaybackAnchor: false, playbackAnchorReady
    }), false);
    assert.equal(ownsQqLogicalNext('qqmusic', {
      requiresPlaybackAnchor: true, playbackAnchorReady, ownsLogicalNext: true
    }), true);
  }
});

test('ordinary local head mutations retain append/reorder and legacy decisions', () => {
  const plan = (previousHeadIdentity, nextHeadIdentity, hadRegisteredNext, isPlaying = true) =>
    planQueueHeadMutation({ previousHeadIdentity, nextHeadIdentity, hadRegisteredNext, isPlaying });
  assert.equal(plan('', 'qqmusic|id:A', false), 'insert');
  assert.equal(plan('qqmusic|id:A', 'qqmusic|id:A', true), 'none');
  assert.equal(plan('qqmusic|id:A', 'qqmusic|id:B', true), 'arm-only');
  assert.equal(plan('qqmusic|id:A', '', true), 'cancel-native');
  assert.equal(plan('qqmusic|id:A', 'qqmusic|id:B', true, false), 'arm-only');
  assert.equal(plan('qqmusic|id:A', '', false), 'none');
});

// Narrow integration assertions intentionally read source, never import the
// Electron entry point or start a player. Pure policy tests alone would miss
// a second automatic dispatch left in one of main.ts's mismatch branches.
const main = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
const between = (start, end) => {
  const begin = main.indexOf(start);
  assert.notEqual(begin, -1, `Missing integration anchor: ${start}`);
  const finish = main.indexOf(end, begin + start.length);
  assert.notEqual(finish, -1, `Missing integration end: ${end}`);
  return main.slice(begin, finish);
};

test('both track-mismatch fallback branches register only when connector owns next', () => {
  const sync = between('async function syncTrackChangeLogic(', '// 播放器连接与控制实现位于');
  const branches = [...sync.matchAll(
    /else if \(connectorOwnsQqLogicalNext\(\)\) \{([\s\S]*?)\n\s*\} else \{/g
  )];
  assert.equal(branches.length, 2);
  for (const [, branch] of branches) {
    assert.match(branch, /await guardNextSong\(targetQueue\[0\], playbackAnchorReady\)/);
    assert.doesNotMatch(branch, /(?:await\s+playSongNow|executePlayerCommand)\(/);
  }
});

test('indeterminate Web submission does not rearm the consumed logical target', () => {
  const immediate = between('async function playSongNow(', 'function isObservedSong(');
  assert.match(immediate, /const logicalNextOwnerAtDispatch = connectorOwnsQqLogicalNext\(\)/);
  const uncertain = immediate.slice(immediate.indexOf("=== 'indeterminate'"));
  assert.match(uncertain,
    /if \(!logicalNextOwnerAtDispatch && hadRegisteredNativeNext && targetQueue\[0\]\)\s*\{\s*await armNextGuardOnly/);
  assert.doesNotMatch(uncertain, /await (?:playSongNow|guardNextSong)\(/);
});

test('removing the last logical head explicitly clears even a lost host registration', () => {
  const mutation = between('async function reconcileQueueHeadAfterMutation(', 'async function playSongNow(');
  assert.match(mutation,
    /const clearLogicalNext = connectorOwnsQqLogicalNext\(\)\s*&& Boolean\(previousHead\)\s*&& !nextHead/);
  assert.match(mutation, /if \(action === 'none' && !clearLogicalNext\) return/);
  const clear = mutation.match(
    /if \(connectorOwnsQqLogicalNext\(\)\) \{([\s\S]*?)\n\s*\}\n\s*rememberCancelledNativeNext/
  );
  assert.ok(clear);
  assert.match(clear[1], /await serializeNextGuardOperation\(\s*\(\) => executePlayerCommand\('ArmNextGuard'\)/);
  assert.match(clear[1], /return;/);
  assert.doesNotMatch(clear[1], /rememberCancelledNativeNext|requestPlayerNext\(|playSongNow\(/);
});

test('1.2.1 native terminal and recent-completion rescue cannot resubmit a Web-owned target', () => {
  const terminal = between('async function recoverQqGuardTerminalFailureIfNeeded(', 'async function recoverRecentQqGuardedCompletionIfNeeded(');
  const recent = between('async function recoverRecentQqGuardedCompletionIfNeeded(', 'async function syncTrackChangeLogic(');
  for (const recovery of [terminal, recent]) {
    const gate = recovery.indexOf("if (connectorOwnsQqLogicalNext()) return 'none';");
    assert.ok(gate >= 0);
    assert.ok(gate < recovery.indexOf('await playSongNow('));
    // Native-only recovery implementation remains available after the gate.
    assert.match(recovery, /await playSongNow\(recoverySong, 'interrupt'\)/);
  }
});
