import assert from 'node:assert/strict';
import test from 'node:test';
import { selectQqArtworkCover } from '../electron/qqmusic-artwork.ts';

const missingShelter = {
  title: 'Shelter',
  artist: 'Porter Robinson\u3001Madeon',
  album: '',
  coverUrl: ''
};

const candidates = [
  {
    title: 'Shelter',
    artist: 'Porter Robinson / Madeon',
    album: 'Shelter: Complete Edition',
    coverUrl: 'complete-edition-cover'
  },
  {
    title: 'Shelter',
    artist: 'Madeon / Porter Robinson',
    album: 'Shelter',
    coverUrl: 'single-cover'
  },
  {
    title: 'Shelter',
    artist: 'Different Artist',
    album: 'Shelter',
    coverUrl: 'wrong-cover'
  }
];

test('QQ artwork fallback selects the canonical same-song single cover', () => {
  assert.equal(
    selectQqArtworkCover(missingShelter, candidates),
    'single-cover'
  );
});

test('QQ artwork fallback preserves an existing exact-track cover', () => {
  assert.equal(selectQqArtworkCover({
    ...missingShelter,
    coverUrl: 'existing-cover'
  }, candidates), 'existing-cover');
});

test('QQ artwork fallback refuses a different title or artist', () => {
  assert.equal(selectQqArtworkCover({
    ...missingShelter,
    title: 'Different Song'
  }, candidates), '');
  assert.equal(selectQqArtworkCover(missingShelter, [{
    title: 'Shelter',
    artist: 'Different Artist',
    album: 'Shelter',
    coverUrl: 'wrong-cover'
  }]), '');
});
