import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('builtin Mod UI morphs avatars only when rotation is disabled', () => {
  const appSource = fs.readFileSync(
    path.join(root, 'examples', 'obs-overlay', 'app.js'),
    'utf8'
  );
  const styleSource = fs.readFileSync(
    path.join(root, 'examples', 'obs-overlay', 'styles.css'),
    'utf8'
  );

  assert.match(appSource, /kind: 'requester_avatar', value: song\.requestedByAvatar/);
  assert.match(appSource, /kind: 'album_cover', value: song\.coverUrl/);
  assert.match(appSource, /currentCoverFrame\.dataset\.artworkKind = candidate\.kind/);
  assert.match(styleSource, /\.cover-frame\[data-artwork-kind="requester_avatar"\][\s\S]*border-radius: 50%/);
  assert.match(styleSource, /data-awoo-setting-cover-rotation="true"[\s\S]*animation: awoo-cover-spin/);
  assert.match(styleSource, /data-awoo-setting-cover-rotation="true"\]\s+\.cover-frame\s*\{[\s\S]{0,120}border-radius: 50%;[\s\S]{0,120}transition: none/);
  assert.doesNotMatch(styleSource, /data-awoo-setting-artwork-source="requester_avatar"[\s\S]{0,160}animation:\s*none/);
  assert.doesNotMatch(styleSource, /animation-play-state:\s*paused/);
});
