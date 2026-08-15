import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEEDBACK_HISTORY_LIMIT,
  countUnreadFeedbackReplies,
  markFeedbackReplyRead,
  mergeFeedbackStatus,
  normalizeFeedbackPublicId,
  parseFeedbackHistory,
  recordFeedbackSubmission,
  serializeFeedbackHistory
} from '../src/feedback-history-policy.ts';

const submittedAt = '2026-08-09T10:00:00.000Z';

function submitted(id = 'FB-20260809-ABCDEF12') {
  return recordFeedbackSubmission(
    [],
    { title: '播放器没有响应', category: 'bug', priority: 'normal' },
    { id, status: 'open', trackingUrl: `https://app.enkianss.us/feedback?id=${id}` },
    submittedAt
  );
}

test('normalizes supported public feedback ids', () => {
  assert.equal(normalizeFeedbackPublicId(' fb-20260809-abcdef12 '), 'FB-20260809-ABCDEF12');
  assert.equal(normalizeFeedbackPublicId('bad/id'), '');
  assert.equal(normalizeFeedbackPublicId('short'), '');
});

test('parses malformed storage safely and round-trips valid history', () => {
  assert.deepEqual(parseFeedbackHistory(null), []);
  assert.deepEqual(parseFeedbackHistory('{broken'), []);
  const history = submitted();
  assert.deepEqual(parseFeedbackHistory(serializeFeedbackHistory(history)), history);
});

test('deduplicates stored ids and enforces the local history limit', () => {
  const items = Array.from({ length: FEEDBACK_HISTORY_LIMIT + 5 }, (_, index) => ({
    ...submitted(`FB-20260809-${index.toString(16).toUpperCase().padStart(8, '0')}`)[0]
  }));
  items.splice(1, 0, items[0]);
  const parsed = parseFeedbackHistory(JSON.stringify({ version: 1, items }));
  assert.equal(parsed.length, FEEDBACK_HISTORY_LIMIT);
  assert.equal(new Set(parsed.map(item => item.id)).size, FEEDBACK_HISTORY_LIMIT);
});

test('records a submission locally and keeps the newest item first', () => {
  const first = submitted('FB-20260809-11111111');
  const next = recordFeedbackSubmission(
    first,
    { title: '新问题', category: 'feature', priority: 'low' },
    { id: 'fb-20260809-22222222', status: 'open' },
    '2026-08-09T11:00:00.000Z'
  );
  assert.deepEqual(next.map(item => item.id), [
    'FB-20260809-22222222',
    'FB-20260809-11111111'
  ]);
  assert.equal(next[0].title, '新问题');
});

test('marks a newly published reply unread and does not retrigger for the same text', () => {
  const initial = submitted();
  const replied = mergeFeedbackStatus(initial, initial[0].id, {
    id: initial[0].id,
    status: 'working',
    updatedAt: '2026-08-09T10:05:00.000Z',
    reply: '已经收到，正在排查。'
  }, '2026-08-09T10:05:01.000Z');
  assert.equal(countUnreadFeedbackReplies(replied), 1);

  const read = markFeedbackReplyRead(replied, initial[0].id);
  const unchanged = mergeFeedbackStatus(read, initial[0].id, {
    id: initial[0].id,
    status: 'resolved',
    updatedAt: '2026-08-09T10:06:00.000Z',
    reply: '已经收到，正在排查。'
  }, '2026-08-09T10:06:01.000Z');
  assert.equal(countUnreadFeedbackReplies(unchanged), 0);
});

test('edited reply becomes unread again while an empty reply never does', () => {
  const initial = submitted();
  const firstReply = mergeFeedbackStatus(initial, initial[0].id, {
    id: initial[0].id,
    reply: '第一条回复',
    updatedAt: '2026-08-09T10:05:00.000Z'
  }, '2026-08-09T10:05:01.000Z');
  const read = markFeedbackReplyRead(firstReply);
  const edited = mergeFeedbackStatus(read, initial[0].id, {
    id: initial[0].id,
    reply: '补充后的回复',
    updatedAt: '2026-08-09T10:06:00.000Z'
  }, '2026-08-09T10:06:01.000Z');
  assert.equal(countUnreadFeedbackReplies(edited), 1);

  const cleared = mergeFeedbackStatus(edited, initial[0].id, {
    id: initial[0].id,
    reply: '',
    updatedAt: '2026-08-09T10:07:00.000Z'
  }, '2026-08-09T10:07:01.000Z');
  assert.equal(countUnreadFeedbackReplies(cleared), 0);
});

test('an older response cannot overwrite newer local feedback state', () => {
  const initial = mergeFeedbackStatus(submitted(), 'FB-20260809-ABCDEF12', {
    id: 'FB-20260809-ABCDEF12',
    status: 'resolved',
    reply: '新回复',
    updatedAt: '2026-08-09T10:10:00.000Z'
  }, '2026-08-09T10:10:01.000Z');
  const stale = mergeFeedbackStatus(initial, initial[0].id, {
    id: initial[0].id,
    status: 'open',
    reply: '',
    updatedAt: '2026-08-09T10:09:00.000Z'
  }, '2026-08-09T10:11:00.000Z');
  assert.equal(stale[0].status, 'resolved');
  assert.equal(stale[0].reply, '新回复');
});
