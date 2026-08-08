import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldShowWelcomeHint } from '../electron/welcome-hint-policy.ts';

test('shows the welcome hint only on a genuinely new installation', () => {
  assert.equal(shouldShowWelcomeHint({
    alreadyShown: false,
    configExistedAtStartup: false,
    legacyHintWasShown: false
  }), true);
});

test('does not reshow the welcome hint for existing or migrated users', () => {
  assert.equal(shouldShowWelcomeHint({
    alreadyShown: true,
    configExistedAtStartup: false,
    legacyHintWasShown: false
  }), false);
  assert.equal(shouldShowWelcomeHint({
    alreadyShown: false,
    configExistedAtStartup: true,
    legacyHintWasShown: false
  }), false);
  assert.equal(shouldShowWelcomeHint({
    alreadyShown: false,
    configExistedAtStartup: false,
    legacyHintWasShown: true
  }), false);
});
