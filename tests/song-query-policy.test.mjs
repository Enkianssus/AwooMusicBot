import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyNeteaseSongQuery,
  findQqShareUrl
} from '../electron/song-query-policy.ts';

test('NetEase id= is always an explicit song ID', () => {
  assert.deepEqual(classifyNeteaseSongQuery(' id = 1403356922 '), {
    kind: 'explicit-id',
    songId: '1403356922'
  });
  assert.deepEqual(classifyNeteaseSongQuery('id=42'), {
    kind: 'explicit-id',
    songId: '42'
  });
});

test('a long numeric NetEase query is a suspected ID with keyword fallback', () => {
  assert.deepEqual(classifyNeteaseSongQuery('1403356922'), {
    kind: 'suspected-id',
    songId: '1403356922',
    keyword: '1403356922'
  });
});

test('a short numeric NetEase title remains a normal keyword', () => {
  assert.deepEqual(classifyNeteaseSongQuery('1026'), {
    kind: 'keyword',
    query: '1026'
  });
});

test('QQ accepts full, short and bare share codes', () => {
  const expected = 'https://c6.y.qq.com/base/fcgi-bin/u?__=0eBs266kH6Oj';
  assert.equal(findQqShareUrl(expected), expected);
  assert.equal(findQqShareUrl('u?__=0eBs266kH6Oj'), expected);
  assert.equal(findQqShareUrl('0eBs266kH6Oj'), expected);
});

test('QQ does not reinterpret ordinary numeric or songMid text as a share code', () => {
  assert.equal(findQqShareUrl('1403356922'), null);
  assert.equal(findQqShareUrl('004PRTHB1nPLNT'), null);
  assert.equal(findQqShareUrl('abcde-123456'), null);
  assert.equal(findQqShareUrl('Shelter'), null);
});
