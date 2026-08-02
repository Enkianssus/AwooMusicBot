import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isLoopbackRemoteAddress,
  normalizeLocalSongKeyword,
  normalizeLocalSongRequestMode
} from '../electron/local-test-api-policy.ts';

test('local test API defaults to a normal queue request', () => {
  assert.equal(normalizeLocalSongRequestMode(undefined), 'normal');
});

test('local test API accepts friendly mode aliases', () => {
  assert.equal(normalizeLocalSongRequestMode('queue'), 'normal');
  assert.equal(normalizeLocalSongRequestMode('priority'), 'top');
  assert.equal(normalizeLocalSongRequestMode('insert'), 'interrupt');
  assert.equal(normalizeLocalSongRequestMode('immediate'), 'play_now');
});

test('local test API rejects an unknown mode', () => {
  assert.equal(normalizeLocalSongRequestMode('random'), null);
});

test('local test API trims and bounds the search keyword', () => {
  assert.equal(normalizeLocalSongKeyword('  Shelter  '), 'Shelter');
  assert.equal(normalizeLocalSongKeyword(''), null);
  assert.equal(normalizeLocalSongKeyword('x'.repeat(201)), null);
  assert.equal(normalizeLocalSongKeyword(123), null);
});

test('local test API accepts only loopback socket addresses', () => {
  assert.equal(isLoopbackRemoteAddress('127.0.0.1'), true);
  assert.equal(isLoopbackRemoteAddress('::1'), true);
  assert.equal(isLoopbackRemoteAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackRemoteAddress('::ffff:7f00:1'), true);
  assert.equal(isLoopbackRemoteAddress('192.168.1.2'), false);
  assert.equal(isLoopbackRemoteAddress(undefined), false);
});
