import test from 'node:test';
import assert from 'node:assert/strict';
import {
    CORE_UPDATE_STALL_MS,
    announcementDismissalKey,
    automaticAnnouncementMode,
    countPendingAnnouncements,
    describeConnectorProgress,
    describeDownloadedBytes,
    formatUpdateBytes,
    isCoreProgressVisible,
    isCoreUpdateActive,
    isCoreUpdateStalled,
    normalizeAnnouncementSnapshot,
    parseDismissedAnnouncementKeys,
    planAnnouncementDismissal,
    rememberDismissedAnnouncements,
    safeReleaseNotesUrl,
    selectUpdateActions,
    selectVisibleAnnouncements,
    trackCoreUpdateProgress,
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

test('only receipts and installable non-manual updates open the dialog by themselves', () => {
    const receipt = { id: 'install-1', name: 'QQ 音乐', version: '22.60.2', previousVersion: null, completedAt: '' };
    const manual = update('qqmusic', { manualUpdate: true, supportedPlayerVersion: '22.80' });
    const blocked = update('netease', { canUpdate: false, blockedReason: '需要点歌机 1.3.0 或以上版本' });
    assert.equal(automaticAnnouncementMode(snapshot([], [receipt]), freshSession()), 'success');
    assert.equal(automaticAnnouncementMode(snapshot([manual, blocked], [receipt]), freshSession()), 'success');
    assert.equal(automaticAnnouncementMode(snapshot([update('kugou')]), freshSession()), 'updates');
    assert.equal(automaticAnnouncementMode(snapshot([manual]), freshSession()), null);
    assert.equal(automaticAnnouncementMode(snapshot([blocked]), freshSession()), null);
    assert.equal(automaticAnnouncementMode(snapshot([manual, blocked, update('core')]), freshSession()), 'updates');
    // A stale candidate that is not newer than the installed version never counts.
    assert.equal(automaticAnnouncementMode(snapshot([update('core', { version: '1.2.3' })]), freshSession()), null);
});

test('manual and blocked dismissals are remembered per component version across launches', () => {
    const manual = update('qqmusic', { version: 'v22.80.1', manualUpdate: true });
    const blocked = update('netease', { canUpdate: false });
    assert.equal(announcementDismissalKey(manual), 'qqmusic@22.80.1');
    assert.equal(announcementDismissalKey(update('core', { version: '1.2.4' })), 'core@1.2.4');

    const remembered = rememberDismissedAnnouncements([], [manual, blocked, update('core')]);
    assert.deepEqual(remembered, ['netease@1.2.4', 'qqmusic@22.80.1']);
    assert.equal(rememberDismissedAnnouncements(remembered, [manual]), remembered, 'unchanged lists keep their identity');
    assert.deepEqual(rememberDismissedAnnouncements(['kugou@20.0.81.5'], [blocked, manual]), ['kugou@20.0.81.5', 'netease@1.2.4', 'qqmusic@22.80.1']);
    // A newer manual version is announced again.
    assert.equal(countPendingAnnouncements([update('qqmusic', { version: '22.81.1', manualUpdate: true })], remembered), 1);

    const many = Array.from({ length: 60 }, (_, index) => `kugou@20.0.81.${index}`);
    assert.equal(rememberDismissedAnnouncements(many, [manual]).length, 40);
    assert.equal(rememberDismissedAnnouncements(many, [manual]).at(-1), 'qqmusic@22.80.1');

    assert.deepEqual(parseDismissedAnnouncementKeys(JSON.stringify(remembered)), remembered);
    assert.deepEqual(parseDismissedAnnouncementKeys('{"qqmusic@1":true}'), []);
    assert.deepEqual(parseDismissedAnnouncementKeys('not json'), []);
    assert.deepEqual(parseDismissedAnnouncementKeys(null), []);
    assert.deepEqual(parseDismissedAnnouncementKeys(JSON.stringify(['core@1.2.4', 'core@1.2.4', 7, '<img>', 'Core@1'])), ['core@1.2.4']);
});

test('the badge counts installable updates, and manual or blocked ones until dismissed', () => {
    const items = [update('core'), update('qqmusic', { manualUpdate: true }), update('netease', { canUpdate: false }), update('kugou', { version: '1.2.3' })];
    assert.equal(countPendingAnnouncements(items, []), 3);
    assert.equal(countPendingAnnouncements(items, rememberDismissedAnnouncements([], items)), 1);
    // Installable updates keep the badge after “稍后再说”.
    assert.equal(countPendingAnnouncements([update('core')], ['core@1.2.4']), 1);
    assert.equal(countPendingAnnouncements([], []), 0);
});

test('closing the success view acknowledges its receipts like “知道了”', () => {
    const receipts = [{ id: 'install-1', name: 'QQ 音乐', version: '22.60.2', previousVersion: null, completedAt: '' }];
    const state = snapshot([update('qqmusic', { manualUpdate: true }), update('core')], receipts);
    assert.deepEqual(planAnnouncementDismissal('success', state, []), { acknowledgeIds: ['install-1'], dismissedKeys: [] });
    assert.deepEqual(planAnnouncementDismissal('updates', state, []), { acknowledgeIds: [], dismissedKeys: ['qqmusic@1.2.4'] });
    const kept = ['kugou@20.0.81.5'];
    assert.equal(planAnnouncementDismissal('updates', null, kept).dismissedKeys, kept);
    assert.deepEqual(planAnnouncementDismissal('success', null, kept).acknowledgeIds, []);
});

test('core progress shows bytes when the package size is known', () => {
    assert.equal(describeDownloadedBytes(50, 168_000_000), '已下载 80.1 MB / 160.2 MB');
    assert.equal(describeDownloadedBytes(0, 168_000_000), '已下载 0.0 MB / 160.2 MB');
    assert.equal(describeDownloadedBytes(150, 2 * 1024 ** 3), '已下载 2.00 GB / 2.00 GB');
    assert.equal(describeDownloadedBytes(50, undefined), null);
    assert.equal(describeDownloadedBytes(50, null), null);
    assert.equal(describeDownloadedBytes(50, 0), null);
    assert.equal(describeDownloadedBytes(null, 1000), null);
    assert.equal(describeDownloadedBytes(50, '1000'), null);
    assert.equal(formatUpdateBytes(512 * 1024), '512 KB');
    assert.equal(isCoreUpdateActive('downloading'), true);
    assert.equal(isCoreUpdateActive('error'), false);
    assert.equal(isCoreProgressVisible('error'), true);
    assert.equal(isCoreProgressVisible('no-update'), false);
    assert.equal(isCoreProgressVisible(undefined), false);
});

test('a download is reported as stalled only after two minutes without a progress change', () => {
    let mark = trackCoreUpdateProgress(null, { state: 'downloading', progress: 10 }, 1_000);
    mark = trackCoreUpdateProgress(mark, { state: 'downloading', progress: 10 }, 60_000);
    assert.equal(mark.changedAt, 1_000, 'repeated polls do not reset the timer');
    assert.equal(isCoreUpdateStalled(mark, 1_000 + CORE_UPDATE_STALL_MS - 1), false);
    assert.equal(isCoreUpdateStalled(mark, 1_000 + CORE_UPDATE_STALL_MS), true);
    mark = trackCoreUpdateProgress(mark, { state: 'downloading', progress: 11 }, 200_000);
    assert.equal(isCoreUpdateStalled(mark, 250_000), false);
    const applying = trackCoreUpdateProgress(mark, { state: 'applying', progress: 100 }, 250_000);
    assert.equal(isCoreUpdateStalled(applying, 250_000 + CORE_UPDATE_STALL_MS * 2), false);
    assert.equal(isCoreUpdateStalled(null, Number.MAX_SAFE_INTEGER), false);
});

test('connector progress uses readable phase labels and an optional percent', () => {
    assert.deepEqual(describeConnectorProgress({ phase: 'download', percent: 45.4, updatedAt: '2026-10-21T00:00:00.000Z' }), { label: '下载', percent: 45, text: '下载 45%' });
    assert.deepEqual(describeConnectorProgress({ phase: 'runtime', percent: null }), { label: '准备运行环境', percent: null, text: '准备运行环境' });
    assert.equal(describeConnectorProgress({ phase: 'verify', percent: 140 }).text, '校验 100%');
    assert.equal(describeConnectorProgress({ phase: 'install' }).text, '安装');
    assert.equal(describeConnectorProgress({ phase: 'restart', percent: -3 }).text, '重启连接器 0%');
    assert.equal(describeConnectorProgress({ phase: 'toString', percent: 1 }), null);
    assert.equal(describeConnectorProgress({ phase: 'unknown', percent: 1 }), null);
    assert.equal(describeConnectorProgress(null), null);
    assert.equal(describeConnectorProgress('download'), null);
});

test('a reported package size reaches the core confirmation; invalid sizes are dropped', () => {
    const result = normalizeAnnouncementSnapshot({ success: true, ...snapshot([
        update('core', { sizeBytes: 168_000_000 }),
        update('netease', { sizeBytes: '168000000' }),
        update('kugou', { sizeBytes: -1 }),
        update('qqmusic', { sizeBytes: Number.POSITIVE_INFINITY }),
    ]) });
    assert.deepEqual(result.items.map(item => item.sizeBytes), [168_000_000, undefined, undefined, undefined]);
    assert.equal('sizeBytes' in result.items[1], false);
});

test('a rolled-back connector keeps its quarantine flag; anything but true is dropped', () => {
    const notes = '**该版本在本机无法连接播放器，已自动回退并暂停自动更新；如需重试，请手动更新。**\n\n- 修复连接';
    const result = normalizeAnnouncementSnapshot({ success: true, ...snapshot([
        update('qqmusic', { version: '22.80.2', currentVersion: '22.80.1', manualUpdate: true, quarantined: true, notes, supportedPlayerVersion: '22.80' }),
        update('kugou', { quarantined: 'true' }),
        update('netease', { quarantined: 1 }),
        update('folia'),
    ]) });
    assert.deepEqual(result.items.map(item => item.quarantined), [true, undefined, undefined, undefined]);
    assert.equal('quarantined' in result.items[1], false);
    const [retry] = result.items;
    assert.equal(retry.manualUpdate, true);
    assert.equal(retry.notes, notes, 'the notes carry the explanation');
    // A retry never opens the dialog by itself and leaves the badge once dismissed.
    assert.equal(automaticAnnouncementMode(snapshot([retry]), freshSession()), null);
    assert.equal(countPendingAnnouncements([retry], rememberDismissedAnnouncements([], [retry])), 0);
});

test('malformed snapshots cannot manufacture successful updates', () => {
    assert.throws(() => normalizeAnnouncementSnapshot({ success: false, sessionId: 'launch' }));
    const result = normalizeAnnouncementSnapshot({ success: true, sessionId: 'launch', items: [{ id: 'untrusted', version: '9.9.9' }, update('core', { canUpdate: 'true' })], receipts: [{ id: 'x', name: 'QQ', version: '' }, null] });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].canUpdate, false);
    assert.deepEqual(result.receipts, []);
});
