import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { managedActionExpirationAt } from '../electron/managed-action-lifetime-policy.ts';
import * as queue from '../electron/queue-head-policy.ts';
import { isSuccessfulPlayerResult } from '../electron/players/types.ts';

test('only an in-flight logical-next owner receives a bounded attribution extension', () => {
  const action = { startedAt: 1000, expiresAt: 13000, inFlight: true, logicalNextOwnerAtDispatch: true };
  assert.equal(managedActionExpirationAt(action), 26000);
  assert.equal(managedActionExpirationAt({ ...action, inFlight: false }), 13000);
  assert.equal(managedActionExpirationAt({ ...action, logicalNextOwnerAtDispatch: false }), 13000);
});

// Execute the actual entry-point functions with an inert command promise and
// fake clock. Never import Electron, create a process, or control a player.
const main = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('main.ts', main, ts.ScriptTarget.Latest, true);
const names = [
  'playSongNow', 'isObservedSong', 'scheduleManagedActionExpiration',
  'expireManagedAction', 'updatePlayerCurrentTrack', 'cacheSongCover'
];
const functions = names.map(name => {
  const declaration = parsed.statements.find(statement =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  assert.ok(declaration, name);
  return declaration.getText(parsed);
}).join('\n');
const javascript = ts.transpileModule(functions, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS }
}).outputText;

function fixture(web = true) {
  let now = 1000;
  let resolveCommand;
  const commands = [];
  const timers = [];
  const command = new Promise(resolve => { resolveCommand = resolve; });
  const context = vm.createContext({
    ...queue, managedActionExpirationAt, isSuccessfulPlayerResult,
    Date: { now: () => now },
    setTimeout(callback, delay) { timers.push({ callback, due: now + delay }); },
    currentPlayingSong: null, playerCurrentTrack: null,
    playerPausedAfterRequests: false, activeManagedPlayerAction: null,
    managedPlayerActionSequence: 0, queueHeadNeedsGuardOnlyAfterCurrentChange: false,
    registeredNextGuardKey: '', registeredNextGuardSongIdentity: '', targetQueue: [],
    songCoverCache: new Map(),
    connectorOwnsQqLogicalNext: () => web,
    getSelectedPlayerKey: () => web ? 'qqmusic' : 'netease',
    getQueueSongIdentity: song => queue.queueSongIdentity(song, web ? 'qqmusic' : 'netease'),
    getNextGuardKey: () => '', clearDeferredQqInsert() {}, clearRegisteredNextGuard() {},
    serializeNextGuardOperation: operation => operation(),
    executePlayerCommand(name, song) { commands.push({ name, song }); return command; },
    armNextGuardOnly() { throw new Error('Regression must not re-arm or send another command'); },
    writeLog() {}, setGlobalStatus() {}
  });
  new vm.Script(javascript).runInContext(context);
  return {
    context, commands,
    resolve: resolveCommand,
    at(time) {
      now = time;
      for (;;) {
        const index = timers.findIndex(timer => timer.due <= now);
        if (index < 0) break;
        timers.splice(index, 1)[0].callback();
      }
    }
  };
}

const song = {
  Id: '123', SongName: 'Unity', ArtistName: 'TheFatRat', PlayerKey: 'qqmusic',
  CoverUrl: 'https://example.invalid/album.jpg', OrderedBy: 'dev 联测', OrderedByUid: 'local-test-api'
};

test('a 16-second real target observation retains requester and catalog artwork after the legacy deadline', async () => {
  const f = fixture();
  const operation = f.context.playSongNow(song);
  f.at(13100);
  assert.equal(f.context.activeManagedPlayerAction.inFlight, true);
  assert.equal(f.context.currentPlayingSong, song);
  // The second expiry entry point must obey the same in-flight bound.
  f.context.expireManagedAction(f.context.activeManagedPlayerAction);
  assert.equal(f.context.currentPlayingSong, song);
  f.at(17000);
  f.context.updatePlayerCurrentTrack('Unity|TheFatRat', 'Unity', 'TheFatRat', '');
  f.context.activeManagedPlayerAction.targetObserved = true;
  f.resolve({ outcome: 'applied', message: 'target metadata observed' });
  assert.equal(await operation, true);
  f.at(30000);
  assert.equal(f.context.currentPlayingSong.OrderedBy, 'dev 联测');
  assert.equal(f.context.currentPlayingSong.OrderedByUid, 'local-test-api');
  assert.equal(f.context.currentPlayingSong.CoverUrl, song.CoverUrl);
  assert.equal(f.context.playerCurrentTrack.CoverUrl, song.CoverUrl);
  assert.equal(f.commands.length, 1);
});

test('unknown completion without target metadata releases the request and never re-dispatches', async () => {
  const f = fixture();
  const operation = f.context.playSongNow(song);
  f.at(17000);
  f.resolve({ outcome: 'indeterminate', message: 'not observed' });
  assert.equal(await operation, false);
  f.at(30000);
  assert.equal(f.context.currentPlayingSong, null);
  assert.equal(f.context.activeManagedPlayerAction, null);
  assert.equal(f.commands.length, 1);
});

test('an ACK without observed target cannot preserve Web attribution after completion', async () => {
  const f = fixture();
  const operation = f.context.playSongNow(song);
  f.at(17000);
  f.resolve({ outcome: 'accepted', message: 'ACK only' });
  await operation;
  f.at(17100);
  assert.equal(f.context.currentPlayingSong, null);
  assert.equal(f.context.activeManagedPlayerAction, null);
  assert.equal(f.commands.length, 1);
});

test('Web has a hard in-flight cap and non-Web retains the original 12-second expiry', async () => {
  for (const [web, before, after] of [[true, 25999, 26100], [false, 12999, 13100]]) {
    const f = fixture(web);
    const operation = f.context.playSongNow(song);
    f.at(before);
    assert.equal(f.context.currentPlayingSong, song);
    f.at(after);
    assert.equal(f.context.currentPlayingSong, null);
    assert.equal(f.context.activeManagedPlayerAction, null);
    f.resolve({ outcome: 'indeterminate' });
    await operation;
    assert.equal(f.commands.length, 1);
  }
});

test('track-change and timer expiry use the same bounded lifetime policy', () => {
  assert.match(main, /if \(managedAction && Date\.now\(\) >= managedActionExpirationAt\(managedAction\)\)/);
  assert.match(main, /if \(Date\.now\(\) < managedActionExpirationAt\(action\)\) return;/);
  assert.match(main, /if \(logicalNextOwnerAtDispatch\) scheduleManagedActionExpiration\(managedAction\)/);
});
