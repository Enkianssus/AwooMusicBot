import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildCurrentActionBody,
    buildQueueActionBody,
    buildReorderBody,
    queueRowKeys
} from '../src/queue-action-request.ts';

const song = (Id, OrderedByUid, RequestId) => ({
    Id,
    OrderedByUid,
    SongName: `歌曲 ${Id}`,
    OrderedBy: `观众 ${OrderedByUid}`,
    ...(RequestId === undefined ? {} : { RequestId })
});

test('index actions carry the identity of the row the streamer clicked', () => {
    for (const action of ['delete', 'top', 'play_now']) {
        assert.deepEqual(buildQueueActionBody(action, 2, song('1001', '42', 'req-7')), {
            action,
            index: 2,
            expected: { requestId: 'req-7', id: '1001', orderedByUid: '42' }
        });
    }
});

test('ids are sent as strings and requestId is omitted when absent', () => {
    for (const RequestId of [undefined, null, '']) {
        const body = buildQueueActionBody('delete', 0, song(1001, 42, RequestId));
        assert.deepEqual(body, { action: 'delete', index: 0, expected: { id: '1001', orderedByUid: '42' } });
        assert.equal(Object.hasOwn(body.expected, 'requestId'), false);
        assert.equal(JSON.stringify(body).includes('requestId'), false);
    }
    assert.deepEqual(
        buildQueueActionBody('top', 1, song('7', '8', 15)).expected,
        { requestId: '15', id: '7', orderedByUid: '8' }
    );
});

test('reorder sends both positions and the moved request', () => {
    assert.deepEqual(buildReorderBody(3, 0, song('5', '6', 'req-9')), {
        action: 'reorder',
        from: 3,
        to: 0,
        expected: { requestId: 'req-9', id: '5', orderedByUid: '6' }
    });
    assert.deepEqual(buildReorderBody(0, 1, song(5, 6)), {
        action: 'reorder',
        from: 0,
        to: 1,
        expected: { id: '5', orderedByUid: '6' }
    });
});

test('current-song actions name the song that is playing', () => {
    assert.deepEqual(buildCurrentActionBody('skip_current', song('9', '3', 'req-1')), {
        action: 'skip_current',
        expectedCurrent: { requestId: 'req-1', id: '9' }
    });
    assert.deepEqual(buildCurrentActionBody('push_current_to_queue', song(9, 3)), {
        action: 'push_current_to_queue',
        expectedCurrent: { id: '9' }
    });
});

test('row keys follow each request through a reorder', () => {
    const a = song('1', 'u1', 'req-a');
    const b = song('2', 'u2', 'req-b');
    const c = song('3', 'u3', 'req-c');
    assert.deepEqual(queueRowKeys([a, b, c]), ['req-a', 'req-b', 'req-c']);
    assert.deepEqual(queueRowKeys([c, a, b]), ['req-c', 'req-a', 'req-b']);
});

test('fallback row keys are stable across reorder and unique for duplicate songs', () => {
    const a = song('1', 'u1');
    const b = song('2', 'u2');
    const keys = queueRowKeys([a, b]);
    assert.deepEqual(keys, ['1|u1|0', '2|u2|0']);
    assert.deepEqual(queueRowKeys([b, a]), [keys[1], keys[0]]);

    const repeated = queueRowKeys([a, b, song('1', 'u1'), song('1', 'u2')]);
    assert.deepEqual(repeated, ['1|u1|0', '2|u2|0', '1|u1|1', '1|u2|0']);
    assert.equal(new Set(repeated).size, repeated.length);
});

test('row keys stay unique when RequestIds are mixed with legacy rows or repeated', () => {
    const keys = queueRowKeys([
        song('1', 'u1', 'req-a'),
        song('1', 'u1'),
        song('1', 'u1', 'req-a'),
        song('1', 'u1')
    ]);
    assert.deepEqual(keys, ['req-a', '1|u1|0', 'req-a|1', '1|u1|1']);
    assert.equal(new Set(keys).size, keys.length);
    assert.deepEqual(queueRowKeys([]), []);
});
