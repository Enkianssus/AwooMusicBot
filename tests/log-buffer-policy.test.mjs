import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { LOG_BUFFER_MAX, lastLogSeq, mergeLogEntries } from '../src/log-buffer-policy.ts';

const numbered = (Seq, Message, Time = '12:00:01') => ({ Seq, Time, Color: 'Cyan', Message });
const plain = (Message, Time = '12:00:01') => ({ Time, Color: 'Gray', Message });
const keys = buffer => buffer.map(entry => entry.key);

test('numbered lines after the newest buffered Seq are appended with Seq keys', () => {
    const first = mergeLogEntries([], [numbered(1, 'a'), numbered(2, 'b')]);
    assert.deepEqual(keys(first), ['1', '2']);
    assert.equal(lastLogSeq(first), 2);

    const second = mergeLogEntries(first, [numbered(3, 'c')]);
    assert.deepEqual(second.map(entry => entry.Message), ['a', 'b', 'c']);
    // Rows already on screen keep their objects, so React only appends a node.
    assert.equal(second[0], first[0]);
    assert.equal(second[1], first[1]);
});

test('lines already in the buffer are never appended twice', () => {
    const buffer = mergeLogEntries([], [numbered(1, 'a'), numbered(2, 'b')]);
    // A server that ignores ?after= sends everything again: nothing changes.
    assert.equal(mergeLogEntries(buffer, [numbered(1, 'a'), numbered(2, 'b')]), buffer);
    // Only the newer line is taken, once, even when the response repeats it.
    const next = mergeLogEntries(buffer, [numbered(1, 'a'), numbered(2, 'b'), numbered(3, 'c'), numbered(3, 'c')]);
    assert.deepEqual(keys(next), ['1', '2', '3']);
    // An empty answer to ?after= keeps the buffer itself.
    assert.equal(mergeLogEntries(next, []), next);
});

test('the client buffer keeps the newest 500 lines', () => {
    assert.equal(LOG_BUFFER_MAX, 500);
    let buffer = [];
    for (let start = 1; start <= 600; start += 100) {
        buffer = mergeLogEntries(buffer, Array.from({ length: 100 }, (_, index) => numbered(start + index, `line ${start + index}`)));
    }
    assert.equal(buffer.length, 500);
    assert.equal(buffer[0].Seq, 101);
    assert.equal(lastLogSeq(buffer), 600);
    assert.deepEqual(keys(mergeLogEntries([], [numbered(1, 'a'), numbered(2, 'b'), numbered(3, 'c')], { max: 2 })), ['2', '3']);
    assert.deepEqual(keys(mergeLogEntries([], [plain('a'), plain('b'), plain('c')], { max: 2 })), ['12:00:01|0', '12:00:01|1']);
});

test('without Seq the response replaces the buffer and lines keep their keys while the server ring moves', () => {
    const first = mergeLogEntries([], [plain('a', '12:00:01'), plain('b', '12:00:01'), plain('c', '12:00:02')]);
    assert.deepEqual(keys(first), ['12:00:01|0', '12:00:01|1', '12:00:02|0']);
    assert.equal(lastLogSeq(first), null);
    // The same array again is not a change.
    assert.equal(mergeLogEntries(first, [plain('a', '12:00:01'), plain('b', '12:00:01'), plain('c', '12:00:02')]), first);

    // The server dropped its oldest line and logged a new one.
    const shifted = mergeLogEntries(first, [plain('b', '12:00:01'), plain('c', '12:00:02'), plain('d', '12:00:03')]);
    assert.deepEqual(shifted.map(entry => entry.Message), ['b', 'c', 'd']);
    assert.equal(shifted[1].key, first[2].key);
    assert.equal(shifted[2].key, '12:00:03|0');
    assert.equal(new Set(keys(shifted)).size, shifted.length);

    // The same time on another day still gets a unique key.
    const repeatedTime = mergeLogEntries([], [plain('yesterday', '09:30:00'), plain('x', '10:00:00'), plain('today', '09:30:00')]);
    assert.equal(new Set(keys(repeatedTime)).size, 3);
    // An older server always answers with its whole log, so an empty one is the truth.
    assert.deepEqual(mergeLogEntries(first, []), []);
});

test('a numbering that started over, or a buffer from an older server, is replaced', () => {
    const fromOlderServer = mergeLogEntries([], [plain('a')]);
    assert.deepEqual(keys(mergeLogEntries(fromOlderServer, [numbered(1, 'x')])), ['1']);
    const restarted = mergeLogEntries(mergeLogEntries([], [numbered(900, 'late')]), [numbered(1, 'fresh'), numbered(2, 'next')]);
    assert.deepEqual(restarted.map(entry => entry.Message), ['fresh', 'next']);
});

test('malformed responses and entries never break the buffer', () => {
    const buffer = mergeLogEntries([], [numbered(1, 'a')]);
    assert.equal(mergeLogEntries(buffer, null), buffer);
    assert.equal(mergeLogEntries(buffer, { success: false }), buffer);
    const cleaned = mergeLogEntries([], [null, 'text', { Time: '12:00:05', Message: 42 }]);
    assert.deepEqual(cleaned.map(entry => [entry.Time, entry.Color, entry.Message, entry.key]), [['12:00:05', '', '42', '12:00:05|0']]);
});

test('the logs panel owns the only logs poll and keys rows by the buffer keys', () => {
    const root = path.resolve(import.meta.dirname, '..');
    const app = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8');
    const panel = fs.readFileSync(path.join(root, 'src', 'components', 'LogsPanel.tsx'), 'utf8');
    assert.doesNotMatch(app, /\/api\/logs/);
    assert.doesNotMatch(app, /logsEndRef|sysLogs/);
    assert.match(app, /activeTab === 'logs' && <LogsPanel /);
    assert.match(panel, /\/api\/logs/);
    assert.match(panel, /\?after=\$\{after\}/);
    assert.match(panel, /usePolling\(pollLogs, \{ intervalMs: LOG_POLL_MS/);
    assert.match(panel, /key=\{log\.key\}/);
});
