import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JSONL_MAX_BUFFERED_CHARS,
  createJsonlLineBuffer
} from '../electron/jsonl-line-buffer.ts';

function collector(options = {}) {
  const messages = [];
  const invalid = [];
  const overflows = [];
  const buffer = createJsonlLineBuffer({
    onMessage: value => messages.push(value),
    onInvalid: (line, reason) => invalid.push([line, reason]),
    onOverflow: droppedChars => overflows.push(droppedChars),
    ...options
  });
  return { buffer, messages, invalid, overflows };
}

test('an object split across chunks is delivered once', () => {
  const c = collector();
  c.buffer.push('{"id":"1",');
  c.buffer.push('"ok":true');
  assert.deepEqual(c.messages, []);
  c.buffer.push('}\n');
  c.buffer.push('');
  c.buffer.push('\n');
  assert.deepEqual(c.messages, [{ id: '1', ok: true }]);
  assert.deepEqual(c.invalid, []);
});

test('non-object and non-JSON lines are reported and a later line in the chunk still arrives', () => {
  const c = collector();
  assert.doesNotThrow(() => c.buffer.push('0\ntrue\nnull\n"text"\n[1]\nconnector banner\n{"id":"2"}\n'));
  assert.deepEqual(c.invalid, [
    ['0', 'not-object'],
    ['true', 'not-object'],
    ['null', 'not-object'],
    ['"text"', 'not-object'],
    ['[1]', 'not-object'],
    ['connector banner', 'invalid-json']
  ]);
  assert.deepEqual(c.messages, [{ id: '2' }]);
});

test('CRLF endings, blank lines and a UTF-8 BOM are tolerated', () => {
  const c = collector();
  c.buffer.push('﻿{"a":1}\r\n\r\n   \r\n{"b":2}\r');
  c.buffer.push('\n');
  assert.deepEqual(c.messages, [{ a: 1 }, { b: 2 }]);
  assert.deepEqual(c.invalid, []);
});

test('an over-long line is dropped up to its newline and later lines still arrive', () => {
  assert.equal(JSONL_MAX_BUFFERED_CHARS, 4 * 1024 * 1024);
  const c = collector({ maxBufferedChars: 16 });
  const head = '{"text":"0123456789';
  c.buffer.push(head);
  assert.deepEqual(c.overflows, [head.length]);
  c.buffer.push('abcdef');
  c.buffer.push('"}\n{"id":"3"}\n');
  assert.deepEqual(c.messages, [{ id: '3' }]);
  assert.deepEqual(c.invalid, [], 'the tail of the dropped line is not parsed');

  const complete = '{"text":"0123456789abcdef"}';
  c.buffer.push(`${complete}\n{"id":"4"}\n`);
  assert.deepEqual(c.overflows, [head.length, complete.length]);
  assert.deepEqual(c.messages, [{ id: '3' }, { id: '4' }]);
});

test('a throwing handler does not block later lines', () => {
  const c = collector({
    onMessage(value) {
      if (value.fail) throw new Error('handler failed');
      c.messages.push(value);
    }
  });
  assert.doesNotThrow(() => c.buffer.push('{"fail":true}\n{"id":"5"}\n'));
  assert.deepEqual(c.messages, [{ id: '5' }]);
  assert.deepEqual(c.invalid, [['{"fail":true}', 'handler-error']]);
});

test('throwing reporters never escape push', () => {
  const messages = [];
  const buffer = createJsonlLineBuffer({
    maxBufferedChars: 8,
    onMessage: value => messages.push(value),
    onInvalid() { throw new Error('log failed'); },
    onOverflow() { throw new Error('log failed'); }
  });
  assert.doesNotThrow(() => buffer.push('0\n{"id":6}\n0123456789'));
  assert.deepEqual(messages, [{ id: 6 }]);
});

test('reset discards a partial line, including from inside a handler', () => {
  const c = collector();
  c.buffer.push('{"id":');
  c.buffer.reset();
  c.buffer.push('{"id":"7"}\n');
  assert.deepEqual(c.messages, [{ id: '7' }]);
  assert.deepEqual(c.invalid, []);

  const d = collector({
    onMessage(value) {
      d.messages.push(value);
      if (value.reset) d.buffer.reset();
    }
  });
  d.buffer.push('{"reset":true}\n{"stale":true}\n{"partial"');
  d.buffer.push('{"id":"8"}\n');
  assert.deepEqual(d.messages, [{ reset: true }, { id: '8' }]);
});
