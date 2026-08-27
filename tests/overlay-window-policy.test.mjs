import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_OVERLAY_ALWAYS_ON_TOP,
  normalizeOverlayAlwaysOnTop,
  toggleOverlayAlwaysOnTop
} from '../electron/overlay-window-policy.ts';

test('overlay pin preference defaults to enabled', () => {
  assert.equal(DEFAULT_OVERLAY_ALWAYS_ON_TOP, true);
  assert.equal(normalizeOverlayAlwaysOnTop(undefined), true);
  assert.equal(normalizeOverlayAlwaysOnTop(null), true);
  assert.equal(normalizeOverlayAlwaysOnTop('false'), true);
});

test('overlay pin preference preserves explicit booleans', () => {
  assert.equal(normalizeOverlayAlwaysOnTop(true), true);
  assert.equal(normalizeOverlayAlwaysOnTop(false), false);
});

test('overlay pin preference toggles predictably', () => {
  assert.equal(toggleOverlayAlwaysOnTop(true), false);
  assert.equal(toggleOverlayAlwaysOnTop(false), true);
});
