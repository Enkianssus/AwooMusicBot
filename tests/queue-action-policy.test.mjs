import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as policy from '../electron/queue-action-policy.ts';
import { RequestNotificationStore } from '../electron/request-notifications.ts';

const { matchesCurrentSong, resolveQueueActionTarget, isQueueIndex } = policy;
const MISSING = '队列项不存在，请刷新后重试';
const CHANGED = '队列已变化，请刷新后重试';

const song = (requestId, id, uid, name = `${id}-${uid}`) => ({
  ...(requestId ? { RequestId: requestId } : {}), Id: id, OrderedByUid: uid, SongName: name, OrderedBy: `观众${uid}`
});
const expect = item => ({ requestId: item.RequestId, id: item.Id, orderedByUid: item.OrderedByUid });

test('an index whose song still matches is used as is, and index-only bodies keep working', () => {
  const queue = [song('r1', 'a', '1'), song('r2', 'b', '2')];
  assert.deepEqual(resolveQueueActionTarget(queue, 1, expect(queue[1])), { ok: true, index: 1 });
  assert.deepEqual(resolveQueueActionTarget(queue, 1), { ok: true, index: 1 });
  assert.deepEqual(resolveQueueActionTarget(queue, 1, null), { ok: true, index: 1 });
  assert.deepEqual(resolveQueueActionTarget(queue, 2), { ok: false, message: MISSING });
});

test('a moved request is found again by request ID, never by its old position', () => {
  const target = song('r3', 'c', '3');
  // The head finished and someone used 置顶 after the snapshot was taken.
  const queue = [song('r9', 'z', '9'), song('r2', 'b', '2'), target];
  assert.deepEqual(resolveQueueActionTarget(queue, 1, expect(target)), { ok: true, index: 2 });
  // The queue shrank below the stale index; the request is still there.
  assert.deepEqual(resolveQueueActionTarget([target], 3, expect(target)), { ok: true, index: 0 });
  // Same song and viewer, but a different request: the IDs decide.
  const duplicate = song('r4', 'c', '3');
  assert.deepEqual(resolveQueueActionTarget([duplicate, target], 0, expect(target)), { ok: true, index: 1 });
});

test('without request IDs the same song and viewer nearest the old index is chosen', () => {
  const queue = [song('', 'a', '1'), song('', 'b', '2'), song('', 'a', '1'), song('', 'c', '3'), song('', 'a', '1')];
  assert.deepEqual(resolveQueueActionTarget(queue, 3, { id: 'a', orderedByUid: '1' }), { ok: true, index: 2 });
  assert.deepEqual(resolveQueueActionTarget(queue, 1, { id: 'a', orderedByUid: '1' }), { ok: true, index: 0 });
  // A client with request IDs still finds a song queued without one.
  assert.deepEqual(resolveQueueActionTarget(queue, 1, { requestId: 'r1', id: 'c', orderedByUid: '3' }), { ok: true, index: 3 });
  // Numbers from older JSON clients compare as strings.
  assert.deepEqual(resolveQueueActionTarget([song('', '42', '7')], 0, { id: 42, orderedByUid: 7 }), { ok: true, index: 0 });
});

test('a request that left the queue, or a mismatched viewer, is reported as a changed queue', () => {
  const queue = [song('r1', 'a', '1'), song('r2', 'b', '2')];
  assert.deepEqual(resolveQueueActionTarget(queue, 0, { requestId: 'gone', id: 'x', orderedByUid: '5' }), { ok: false, message: CHANGED });
  assert.deepEqual(resolveQueueActionTarget([song('', 'a', '1')], 0, { id: 'a', orderedByUid: '2' }), { ok: false, message: CHANGED });
  for (const malformed of [{}, 'a', 7, []]) {
    assert.deepEqual(resolveQueueActionTarget(queue, 0, malformed), { ok: false, message: CHANGED });
  }
  assert.deepEqual(resolveQueueActionTarget([], 0, expect(queue[0])), { ok: false, message: CHANGED });
});

test('non-integer, negative or non-numeric indexes are rejected before anything is coerced', () => {
  const queue = [song('r1', 'a', '1'), song('r2', 'b', '2')];
  for (const index of ['0', 0.5, -1, NaN, Infinity, null, undefined, true, '1']) {
    assert.deepEqual(resolveQueueActionTarget(queue, index), { ok: false, message: MISSING }, String(index));
    assert.deepEqual(resolveQueueActionTarget(queue, index, expect(queue[0])), { ok: false, message: MISSING }, String(index));
  }
  assert.equal(isQueueIndex(1, 2), true);
  for (const value of [2, -1, '1', 1.5]) assert.equal(isQueueIndex(value, 2), false);
});

test('the current song matches by request ID first, then by song ID', () => {
  const current = song('r1', 'a', '1');
  assert.equal(matchesCurrentSong(current, { requestId: 'r1', id: 'a' }), true);
  assert.equal(matchesCurrentSong(current, { requestId: 'r2', id: 'a' }), false);
  assert.equal(matchesCurrentSong(current, { id: 'a' }), true);
  assert.equal(matchesCurrentSong(current, { id: 'b' }), false);
  assert.equal(matchesCurrentSong({ Id: '123', SongName: '播放器自己的歌' }, { requestId: 'r1', id: 123 }), true);
  for (const malformed of [{}, null, 'a']) assert.equal(matchesCurrentSong(current, malformed), false);
});

// The real /api/queue/action implementation, extracted from main.ts and run
// against an inert queue without Electron, sockets or a player.
const main = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true);
const declaration = parsed.statements.find(value => ts.isFunctionDeclaration(value) && value.name?.text === 'applyQueueAction');
assert.ok(declaration, 'applyQueueAction');
const compiled = ts.transpileModule(declaration.getText(parsed), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }
}).outputText;

function fixture(queue, overrides = {}) {
  const store = new RequestNotificationStore();
  const calls = { reconciled: [], played: [], next: 0, status: [] };
  const context = vm.createContext({
    ...policy,
    targetQueue: queue, currentPlayingSong: null, playerCurrentTrack: null,
    requestNotificationStore: { publish: input => store.publish(input, 1_000) },
    reconcileQueueHeadAfterMutation: async (previousHead, reason) => { calls.reconciled.push([previousHead?.Id, reason]); },
    setGlobalStatus: message => calls.status.push(message),
    clearRecentQqGuardedCompletion() {},
    playSongNow: async item => { calls.played.push(item); return true; },
    requestPlayerNext: async () => { calls.next++; return true; },
    getQueueSongIdentity: item => item?.Id || '',
    registeredNextGuardSongIdentity: '', clearRegisteredNextGuard() {},
    skipForcePlayOnceSong: null, skipForcePlayOnce: false, writeLog() {},
    ...overrides
  });
  new vm.Script(compiled).runInContext(context);
  return {
    context, calls,
    // Copy results out of the vm realm so deepStrictEqual compares plain objects.
    run: async body => ({ ...await context.applyQueueAction(body) }),
    queue: () => context.targetQueue.map(item => item.Id),
    notices: () => store.snapshot(1_000)
  };
}

test('admin delete removes the identified request and announces it as the streamer', async () => {
  const a = song('r1', 'a', '1', '第一首');
  const b = song('r2', 'b', '2', '第二首');
  const c = song('r3', 'c', '3', '第三首');
  // The renderer saw [x, a, b, c]; x finished before the click on b (#2).
  const f = fixture([a, b, c]);
  assert.deepEqual(await f.run({ action: 'delete', index: 2, expected: expect(b) }), { success: true });
  assert.deepEqual(f.queue(), ['a', 'c']);
  assert.deepEqual(f.calls.reconciled, []);
  const [notice] = f.notices();
  assert.deepEqual(
    { kind: notice.kind, action: notice.action, title: notice.title, message: notice.message, requestedBy: notice.requestedBy },
    { kind: 'cancelled', action: 'remove', title: '第二首', message: '主播已将歌曲移出待播队列', requestedBy: '主播' }
  );

  // A request that moved to the head reconciles the native next guard.
  const head = fixture([b, c]);
  assert.deepEqual(await head.run({ action: 'delete', index: 1, expected: expect(b) }), { success: true });
  assert.deepEqual(head.calls.reconciled, [['b', '删除队首']]);
});

test('stale, coerced or unknown queue actions fail as results without touching the queue', async () => {
  const a = song('r1', 'a', '1');
  const b = song('r2', 'b', '2');
  for (const body of [
    { action: 'delete', index: '0' }, { action: 'top', index: 0.5 }, { action: 'play_now', index: 2 },
    { action: 'delete', index: 0, expected: { requestId: 'gone', id: 'x', orderedByUid: '9' } },
    { action: 'reorder', from: 0, to: 2 }, { action: 'reorder', from: '1', to: 0 },
    { action: 'unknown' }
  ]) {
    const f = fixture([a, b]);
    const result = await f.run(body);
    assert.equal(result.success, false, JSON.stringify(body));
    assert.equal(typeof result.message, 'string');
    assert.deepEqual(f.queue(), ['a', 'b']);
    assert.deepEqual(f.notices(), []);
    assert.deepEqual(f.calls.reconciled.length + f.calls.played.length + f.calls.next, 0);
  }
});

test('legacy index-only bodies keep their original behavior', async () => {
  const f = fixture([song('', 'a', '1'), song('', 'b', '2'), song('', 'c', '3')]);
  assert.equal((await f.run({ action: 'top', index: 2 })).success, true);
  assert.deepEqual(f.queue(), ['c', 'a', 'b']);
  assert.equal((await f.run({ action: 'reorder', from: 0, to: 2 })).success, true);
  assert.deepEqual(f.queue(), ['a', 'b', 'c']);
  assert.equal((await f.run({ action: 'delete', index: 0 })).success, true);
  assert.deepEqual(f.queue(), ['b', 'c']);
  assert.deepEqual(f.calls.reconciled.map(([, reason]) => reason), ['置顶队列', '重排队列', '删除队首']);
});

test('top, reorder and play_now act on the identified request after a shift', async () => {
  const a = song('r1', 'a', '1');
  const b = song('r2', 'b', '2');
  const c = song('r3', 'c', '3');
  const f = fixture([a, b, c]);
  assert.equal((await f.run({ action: 'top', index: 0, expected: expect(c) })).success, true);
  assert.deepEqual(f.queue(), ['c', 'a', 'b']);
  assert.equal((await f.run({ action: 'reorder', from: 0, to: 2, expected: expect(a) })).success, true);
  assert.deepEqual(f.queue(), ['c', 'b', 'a']);

  // The head finishes while playback is confirmed; only the played request leaves.
  const played = fixture([a, b, c], {
    playSongNow: async item => { played.context.targetQueue.shift(); return item === b; }
  });
  assert.deepEqual(await played.run({ action: 'play_now', index: 1, expected: expect(b) }), { success: true });
  assert.deepEqual(played.queue(), ['c']);

  const unconfirmed = fixture([a, b], { playSongNow: async () => false });
  const result = await unconfirmed.run({ action: 'play_now', index: 1, expected: expect(b) });
  assert.equal(result.success, false);
  assert.deepEqual(unconfirmed.queue(), ['a', 'b']);
});

test('current-song actions refuse a song the streamer did not see', async () => {
  const current = song('r1', 'a', '1');
  const skip = fixture([], { currentPlayingSong: current });
  assert.deepEqual(await skip.run({ action: 'skip_current', expectedCurrent: { requestId: 'r0', id: 'z' } }),
    { success: false, message: '当前歌曲已变化，未执行操作' });
  assert.equal(skip.calls.next, 0);
  assert.deepEqual(await skip.run({ action: 'skip_current', expectedCurrent: { requestId: 'r1', id: 'a' } }), { success: true });
  assert.deepEqual(await skip.run({ action: 'skip_current' }), { success: true });
  assert.equal(skip.calls.next, 2);

  // The requested song ended and the player moved on to its own track.
  const ownTrack = fixture([], { playerCurrentTrack: { Id: 'player-track', SongName: '歌单' } });
  assert.equal((await ownTrack.run({ action: 'skip_current', expectedCurrent: { requestId: 'r1', id: 'a' } })).success, false);
  assert.equal(ownTrack.calls.next, 0);

  const push = fixture([], { currentPlayingSong: current });
  assert.equal((await push.run({ action: 'push_current_to_queue', expectedCurrent: { id: 'z' } })).success, false);
  assert.deepEqual(push.queue(), []);
  assert.deepEqual(await push.run({ action: 'push_current_to_queue', expectedCurrent: { requestId: 'r1', id: 'a' } }), { success: true });
  assert.deepEqual(push.queue(), ['a']);
  assert.equal(push.context.skipForcePlayOnce, true);

  const idle = fixture([]);
  assert.equal((await idle.run({ action: 'push_current_to_queue' })).success, false);
  const failedSkip = fixture([], { requestPlayerNext: async () => false });
  assert.equal((await failedSkip.run({ action: 'skip_current' })).success, false);
});

test('a player failure after the queue changed reports the change instead of an error', async () => {
  const a = song('r1', 'a', '1');
  const b = song('r2', 'b', '2');
  const failing = { reconcileQueueHeadAfterMutation: async () => { throw new Error('connector timeout'); } };
  const changed = fixture([a, b], failing);
  assert.deepEqual(await changed.run({ action: 'delete', index: 0, expected: expect(a) }),
    { success: true, message: '队列已更新，播放器同步稍后重试' });
  assert.deepEqual(changed.queue(), ['b']);
  assert.equal(changed.notices().length, 1);

  const unchanged = fixture([a, b], { playSongNow: async () => { throw new Error('connector timeout'); } });
  assert.deepEqual(await unchanged.run({ action: 'play_now', index: 0, expected: expect(a) }),
    { success: false, message: '播放器通信异常，请稍后重试' });
  assert.deepEqual(unchanged.queue(), ['a', 'b']);
});
