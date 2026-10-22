import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { BUILTIN_OVERLAY_SETTINGS } from '../electron/overlay-mod-manager.ts';

const root = path.resolve(import.meta.dirname, '..');
const styles = fs.readFileSync(path.join(root, 'examples', 'obs-overlay', 'styles.css'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'examples', 'obs-overlay', 'overlay.json'), 'utf8'));
const PRESETS = ['blue-light', 'blue-dark'];
// Values the host fills from Mod UI settings rather than from a palette.
const SETTING_TOKENS = new Set(['--panel-opacity', '--widget-scale', '--cover-spin-duration']);

function block(selector) {
  const start = styles.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing ${selector}`);
  return styles.slice(start, styles.indexOf('\n}', start));
}

function tokens(css) {
  return new Set([...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map(match => match[1]));
}

test('each blue preset redefines every palette token of the classic theme', () => {
  const classic = [...tokens(block(':root'))].filter(token => !SETTING_TOKENS.has(token));
  assert.ok(classic.length > 30);
  for (const preset of PRESETS) {
    const defined = tokens(block(`html[data-awoo-setting-theme="${preset}"] .widget`));
    assert.deepEqual(classic.filter(token => !defined.has(token)), [], preset);
  }
});

test('component rules use tokens and avoid color-mix for older OBS browsers', () => {
  let components = styles.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(components, /color-mix\(/);
  for (const selector of [':root', ...PRESETS.map(preset => `html[data-awoo-setting-theme="${preset}"] .widget`)]) {
    const start = components.indexOf(`${selector} {`);
    components = components.slice(0, start) + components.slice(components.indexOf('\n}', start) + 2);
  }
  // Glyph masks are drawn in black by definition; the page itself stays transparent.
  components = components.replace(/url\("data:image\/svg\+xml[^"]*"\)/g, '').replace('rgba(0, 0, 0, 0)', '');
  assert.deepEqual(components.match(/#[0-9a-f]{3,8}\b|rgba?\(\s*\d/gi) || [], []);
});

test('the theme setting offers exactly the presets the stylesheet defines', () => {
  const bundled = manifest.settings.find(setting => setting.key === 'theme');
  const builtin = BUILTIN_OVERLAY_SETTINGS.find(setting => setting.key === 'theme');
  for (const definition of [bundled, builtin]) {
    assert.equal(definition.type, 'select');
    assert.equal(definition.default, 'classic');
    assert.deepEqual(definition.options.map(option => option.value), ['classic', ...PRESETS]);
  }
  assert.equal(manifest.settings[0].key, 'theme', 'the theme is the first color choice');
});
