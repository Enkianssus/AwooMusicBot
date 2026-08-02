import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildNeteaseCoverUrlFromPicId
} from '../electron/netease-cover.ts';

test('NetEase picId is converted to its signed CDN cover URL', () => {
  assert.equal(
    buildNeteaseCoverUrlFromPicId('109951165911363831'),
    'https://p1.music.126.net/2qW-OYZod7SgrzxTwtyBqA==/109951165911363831.jpg'
  );
});

test('invalid NetEase picId does not produce a cover URL', () => {
  assert.equal(buildNeteaseCoverUrlFromPicId('not-an-id'), '');
});
