import test from 'node:test';
import assert from 'node:assert/strict';
import {
    automaticAnnouncementMode,
    normalizeAnnouncementSnapshot,
    safeReleaseNotesUrl,
    selectUpdateActions,
    selectVisibleAnnouncements,
} from '../src/update-announcement-policy.ts';

const update = (id, overrides = {}) => ({ id, name: id, currentVersion: '1.2.3', version: '1.2.4', notes: '', notesUrl: null, canUpdate: true, manualUpdate: false, ...overrides });
const freshSession = () => ({ updatesDismissed: false, dismissedReceiptIds: [] });
const snapshot = (items = [], receipts = []) => ({ sessionId: 'launch-a', items, receipts, errors: [] });

test('offers actions only for actual update candidates that the backend permits', () => {
    const items = [update('core'), update('netease', { version: '1.2.3' }), update('qqmusic', { canUpdate: false }), update('kugou', { version: '1.2.2' })];
    assert.deepEqual(selectUpdateActions(items).map(item => item.id), ['core']);
    assert.deepEqual(selectVisibleAnnouncements(items).map(item => item.id), ['core', 'qqmusic']);
});

test('normalizes version prefixes, removes duplicates, and keeps the newest candidate per component', () => {
    assert.deepEqual(selectVisibleAnnouncements([update('core', { version: 'v1.2.3' })]), []);
    assert.deepEqual(selectVisibleAnnouncements([update('core', { version: '1.2.3.0' })]), []);
    assert.deepEqual(selectVisibleAnnouncements([update('qqmusic'), update('qqmusic', { version: '1.2.5' }), update('core')]).map(item => [item.id, item.version]), [['core', '1.2.4'], ['qqmusic', '1.2.5']]);
});

test('fresh installed versions control actions; historical receipts cannot hide an update after rollback', () => {
    assert.equal(selectVisibleAnnouncements([update('qqmusic', { currentVersion: '1.2.4' })]).length, 0);
    const state = snapshot([update('qqmusic')], [{ id: 'old-install', componentId: 'qqmusic', name: 'qqmusic', version: '1.2.4', previousVersion: '1.2.3', completedAt: '' }]);
    assert.equal(selectUpdateActions(state.items).length, 1);
    assert.equal(automaticAnnouncementMode(state, { updatesDismissed: false, dismissedReceiptIds: ['old-install'] }), 'updates');
});

test('success takes priority; dismissed receipts do not keep reopening during the same session', () => {
    const state = snapshot([update('core')], [{ id: 'install-1', name: 'QQ 音乐', version: '22.60.2' }]);
    assert.equal(automaticAnnouncementMode(state, freshSession()), 'success');
    assert.equal(automaticAnnouncementMode(state, { updatesDismissed: true, dismissedReceiptIds: ['install-1'] }), null);
    assert.equal(automaticAnnouncementMode(state, { updatesDismissed: true, dismissedReceiptIds: [] }), 'success');
    assert.equal(automaticAnnouncementMode(state, freshSession()), 'success');
});

test('update announcement appears again on a fresh launch but empty and error-only snapshots stay quiet', () => {
    assert.equal(automaticAnnouncementMode(snapshot([update('core')]), freshSession()), 'updates');
    assert.equal(automaticAnnouncementMode(snapshot([update('core')]), { updatesDismissed: true, dismissedReceiptIds: [] }), null);
    assert.equal(automaticAnnouncementMode(snapshot([update('core')]), freshSession()), 'updates');
    assert.equal(automaticAnnouncementMode({ ...snapshot(), errors: ['网络暂不可用'] }, freshSession()), null);
});

test('all four connector kinds can expose independent buttons', () => {
    assert.deepEqual(selectUpdateActions(['qqmusic', 'folia', 'netease', 'kugou'].map(id => update(id))).map(item => item.id), ['netease', 'kugou', 'qqmusic', 'folia']);
});

test('release notes are retained as plain text and unsafe links are rejected', () => {
    const notes = '<img src=x onerror=alert(1)>\n修复礼物接收';
    const result = normalizeAnnouncementSnapshot({ success: true, ...snapshot([update('core', { notes, notesUrl: 'javascript:alert(1)' })]) });
    assert.equal(result.items[0].notes, notes);
    assert.equal(result.items[0].notesUrl, null);
    assert.equal(safeReleaseNotesUrl('file:///C:/test'), null);
    assert.equal(safeReleaseNotesUrl('https://user:password@example.com/'), null);
    assert.equal(safeReleaseNotesUrl('https://github.com/Enkianssus/AwooMusicBot/releases/tag/v1.2.4'), 'https://github.com/Enkianssus/AwooMusicBot/releases/tag/v1.2.4');
});

test('malformed snapshots cannot manufacture successful updates', () => {
    assert.throws(() => normalizeAnnouncementSnapshot({ success: false, sessionId: 'launch' }));
    const result = normalizeAnnouncementSnapshot({ success: true, sessionId: 'launch', items: [{ id: 'untrusted', version: '9.9.9' }, update('core', { canUpdate: 'true' })], receipts: [{ id: 'x', name: 'QQ', version: '' }, null] });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].canUpdate, false);
    assert.deepEqual(result.receipts, []);
});
