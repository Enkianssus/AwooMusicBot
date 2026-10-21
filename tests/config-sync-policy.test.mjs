import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SAVE_RETRY_DELAYS_MS,
    adoptPolledSysConfig,
    isConfigSaveAccepted,
    isFoliaTokenConfigured,
    isTextEntryElement,
    mergePolledConfig,
    shouldRetrySave
} from '../src/config-sync-policy.ts';

const local = () => ({
    version: '1.2.5',
    playing: true,
    config: { PlayerType: 'NCM', DynamicCoverEnabled: false },
    widgetStyle: { theme: { bgColor: '#123456' }, timestamp: 20 }
});
const polled = () => ({
    version: '1.2.6',
    playing: false,
    config: { PlayerType: 'NCM', DynamicCoverEnabled: true },
    widgetStyle: { theme: { bgColor: '#16181e' }, timestamp: 10 }
});
const clean = { configDirty: false, widgetStyleDirty: false };

test('the first snapshot is adopted as-is', () => {
    const snapshot = polled();
    assert.equal(mergePolledConfig(null, snapshot, clean), snapshot);
    assert.equal(mergePolledConfig(undefined, snapshot, { configDirty: true, widgetStyleDirty: true }), snapshot);
});

test('a dirty config survives a poll while live status still updates', () => {
    const previous = local();
    const snapshot = polled();
    const merged = mergePolledConfig(previous, snapshot, { configDirty: true, widgetStyleDirty: false });
    assert.equal(merged.config, previous.config, 'an unsaved edit must not be reverted by the poll');
    assert.equal(merged.config.DynamicCoverEnabled, false);
    assert.equal(merged.version, '1.2.6');
    assert.equal(merged.playing, false);
    assert.equal(merged.widgetStyle, snapshot.widgetStyle);
});

test('a clean config takes the polled value', () => {
    const snapshot = polled();
    const merged = mergePolledConfig(local(), snapshot, clean);
    assert.equal(merged.config, snapshot.config);
    assert.equal(merged.widgetStyle, snapshot.widgetStyle);
    assert.deepEqual(merged, snapshot);
});

test('widgetStyle is tracked independently of config', () => {
    const previous = local();
    const snapshot = polled();
    const themeOnly = mergePolledConfig(previous, snapshot, { configDirty: false, widgetStyleDirty: true });
    assert.equal(themeOnly.widgetStyle, previous.widgetStyle);
    assert.equal(themeOnly.config, snapshot.config);

    const both = mergePolledConfig(previous, snapshot, { configDirty: true, widgetStyleDirty: true });
    assert.equal(both.widgetStyle, previous.widgetStyle);
    assert.equal(both.config, previous.config);
});

test('a response without config never replaces the local settings', () => {
    const previous = local();
    const withoutConfig = polled();
    delete withoutConfig.config;
    const merged = mergePolledConfig(previous, withoutConfig, clean);
    assert.equal(merged.config, previous.config);
    assert.equal(merged.version, '1.2.6');
});

test('a focused text field keeps the local config while live status and the theme still update', () => {
    const previous = local();
    const snapshot = polled();
    const merged = mergePolledConfig(previous, snapshot, { ...clean, editing: true });
    assert.equal(merged.config, previous.config, 'a half-typed value must not be replaced by the server copy');
    assert.equal(merged.version, '1.2.6');
    assert.equal(merged.playing, false);
    assert.equal(merged.widgetStyle, snapshot.widgetStyle, 'typing does not hold back theme updates');

    const typedThenLeft = mergePolledConfig(previous, snapshot, { ...clean, editing: false });
    assert.equal(typedThenLeft.config, snapshot.config, 'leaving the field adopts the server copy again');
});

test('a server that trims a typed gift name cannot rewrite it while the field has focus', () => {
    const typing = { ...local(), config: { GiftRequestRequirements: { Normal: { giftName: 'Love ', giftId: '' } } } };
    const trimmed = { ...polled(), config: { GiftRequestRequirements: { Normal: { giftName: 'Love', giftId: '' } } } };
    const merged = mergePolledConfig(typing, trimmed, { ...clean, editing: true });
    assert.equal(merged.config.GiftRequestRequirements.Normal.giftName, 'Love ');
});

test('without a local settings copy the polled one is adopted even while editing', () => {
    const withoutConfig = local();
    delete withoutConfig.config;
    const snapshot = polled();
    const merged = mergePolledConfig(withoutConfig, snapshot, { configDirty: false, widgetStyleDirty: false, editing: true });
    assert.equal(merged.config, snapshot.config);
});

test('adopting the server copy keeps a token typed in this window and the server flag', () => {
    const previous = { ...local(), config: { PlayerType: 'Folia', FoliaToken: 'abcdefgh', FoliaTokenConfigured: false, Cooldowns: { Normal: 5 } } };
    // The server never echoes the token; it reports FoliaTokenConfigured and its own normalized values.
    const snapshot = { ...polled(), config: { PlayerType: 'Folia', FoliaTokenConfigured: true, Cooldowns: { Normal: 0 } } };
    const merged = mergePolledConfig(previous, snapshot, clean);
    assert.deepEqual(merged.config, { PlayerType: 'Folia', FoliaTokenConfigured: true, Cooldowns: { Normal: 0 }, FoliaToken: 'abcdefgh' });
    assert.equal(isFoliaTokenConfigured(merged.config), true);
    assert.equal(snapshot.config.FoliaToken, undefined, 'the polled snapshot itself is not modified');
});

test('adoptPolledSysConfig only fills in a token the server left out', () => {
    const serverCopy = { FoliaTokenConfigured: false, PlayerType: 'Folia' };
    assert.equal(adoptPolledSysConfig({ PlayerType: 'NCM' }, serverCopy), serverCopy, 'nothing typed, nothing added');
    assert.equal(adoptPolledSysConfig(null, serverCopy), serverCopy);
    assert.equal(adoptPolledSysConfig({ FoliaToken: 42 }, serverCopy), serverCopy, 'only a string is a typed token');
    assert.deepEqual(adoptPolledSysConfig({ FoliaToken: '' }, serverCopy), { ...serverCopy, FoliaToken: '' }, 'a cleared field stays cleared');
    const echoing = { FoliaToken: 'from-server', FoliaTokenConfigured: true };
    assert.equal(adoptPolledSysConfig({ FoliaToken: 'local' }, echoing), echoing, 'a server that sends the token wins');
    assert.equal(adoptPolledSysConfig({ FoliaToken: 'local' }, undefined), undefined);
    assert.equal(adoptPolledSysConfig({ FoliaToken: 'local' }, null), null);
});

test('the token placeholder follows a locally edited token before the server flag', () => {
    assert.equal(isFoliaTokenConfigured({ FoliaTokenConfigured: true }), true);
    assert.equal(isFoliaTokenConfigured({ FoliaTokenConfigured: false }), false);
    assert.equal(isFoliaTokenConfigured({}), false);
    assert.equal(isFoliaTokenConfigured({ FoliaTokenConfigured: true, FoliaToken: '' }), false, 'a cleared field is not configured');
    assert.equal(isFoliaTokenConfigured({ FoliaTokenConfigured: true, FoliaToken: '   ' }), false, 'spaces do not count, as on the server');
    assert.equal(isFoliaTokenConfigured({ FoliaTokenConfigured: false, FoliaToken: ' abc ' }), true);
    for (const invalid of [null, undefined, 'token', []]) assert.equal(isFoliaTokenConfigured(invalid), false);
});

test('only text-like inputs and textareas count as a field being typed in', () => {
    for (const type of ['text', 'password', 'search', 'url', 'email', 'tel', 'number']) {
        assert.equal(isTextEntryElement({ tagName: 'INPUT', type }), true, type);
    }
    assert.equal(isTextEntryElement({ tagName: 'INPUT' }), true, 'no type attribute means text');
    assert.equal(isTextEntryElement({ tagName: 'input', type: 'TEXT' }), true);
    assert.equal(isTextEntryElement({ tagName: 'TEXTAREA' }), true);
    for (const type of ['checkbox', 'radio', 'range', 'color', 'button', 'submit', 'file', 'hidden']) {
        assert.equal(isTextEntryElement({ tagName: 'INPUT', type }), false, type);
    }
    assert.equal(isTextEntryElement({ tagName: 'INPUT', type: 'text', readOnly: true }), false, 'nothing can be typed');
    assert.equal(isTextEntryElement({ tagName: 'TEXTAREA', readOnly: true }), false);
    for (const tagName of ['BUTTON', 'SELECT', 'BODY', 'DIALOG']) assert.equal(isTextEntryElement({ tagName }), false, tagName);
    assert.equal(isTextEntryElement(null), false);
    assert.equal(isTextEntryElement(undefined), false);
});

test('failed saves retry twice, after 1 s and then 3 s, then stop', () => {
    assert.deepEqual([...SAVE_RETRY_DELAYS_MS], [1000, 3000]);
    assert.deepEqual(shouldRetrySave(1), { retry: true, delayMs: 1000 });
    assert.deepEqual(shouldRetrySave(2), { retry: true, delayMs: 3000 });
    assert.deepEqual(shouldRetrySave(3), { retry: false });
    assert.deepEqual(shouldRetrySave(4), { retry: false });
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        assert.deepEqual(shouldRetrySave(invalid), { retry: false }, String(invalid));
    }
});

test('a save is confirmed only by an OK reply without success:false', () => {
    assert.equal(isConfigSaveAccepted(true, { success: true }), true);
    assert.equal(isConfigSaveAccepted(true, {}), true, 'older servers omit success');
    assert.equal(isConfigSaveAccepted(true, null), true);
    assert.equal(isConfigSaveAccepted(true, { success: false, message: '保存失败' }), false);
    assert.equal(isConfigSaveAccepted(false, { success: true }), false);
    assert.equal(isConfigSaveAccepted(false, null), false);
});
