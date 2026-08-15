export const FEEDBACK_HISTORY_STORAGE_KEY = 'awoo-feedback-history-v1';
export const FEEDBACK_HISTORY_LIMIT = 30;

const FEEDBACK_PUBLIC_ID_PATTERN = /^[A-Z0-9][A-Z0-9-]{7,39}$/;

export interface LocalFeedbackHistoryItem {
  id: string;
  title: string;
  category: string;
  priority: string;
  submittedAt: string;
  status: string;
  updatedAt: string;
  trackingUrl: string;
  reply: string;
  lastCheckedAt: string;
  unreadReply: boolean;
}

export interface FeedbackSubmissionSummary {
  title: string;
  category: string;
  priority: string;
}

export interface FeedbackSubmissionResult {
  id: string;
  status?: string;
  trackingUrl?: string;
}

export interface PublicFeedbackStatus {
  id: string;
  title?: string;
  category?: string;
  status?: string;
  updatedAt?: string;
  reply?: string;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asTimestamp(value: unknown): string {
  const text = asString(value);
  return text && Number.isFinite(Date.parse(text)) ? text : '';
}

function normalizeHistoryItem(value: unknown): LocalFeedbackHistoryItem | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const id = normalizeFeedbackPublicId(item.id);
  if (!id) return null;

  return {
    id,
    title: asString(item.title) || '未命名反馈',
    category: asString(item.category) || 'other',
    priority: asString(item.priority) || 'normal',
    submittedAt: asTimestamp(item.submittedAt),
    status: asString(item.status) || 'open',
    updatedAt: asTimestamp(item.updatedAt),
    trackingUrl: asString(item.trackingUrl)
      || `https://app.enkianss.us/feedback?id=${encodeURIComponent(id)}`,
    reply: asString(item.reply),
    lastCheckedAt: asTimestamp(item.lastCheckedAt),
    unreadReply: item.unreadReply === true && asString(item.reply).length > 0
  };
}

function normalizeHistory(items: unknown[]): LocalFeedbackHistoryItem[] {
  const seen = new Set<string>();
  const normalized: LocalFeedbackHistoryItem[] = [];
  for (const value of items) {
    const item = normalizeHistoryItem(value);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    normalized.push(item);
    if (normalized.length >= FEEDBACK_HISTORY_LIMIT) break;
  }
  return normalized;
}

export function normalizeFeedbackPublicId(value: unknown): string {
  const id = asString(value).toUpperCase();
  return FEEDBACK_PUBLIC_ID_PATTERN.test(id) ? id : '';
}

export function parseFeedbackHistory(
  serialized: string | null | undefined
): LocalFeedbackHistoryItem[] {
  if (!serialized) return [];
  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (Array.isArray(parsed)) return normalizeHistory(parsed);
    if (!parsed || typeof parsed !== 'object') return [];
    const envelope = parsed as Record<string, unknown>;
    return Array.isArray(envelope.items)
      ? normalizeHistory(envelope.items)
      : [];
  } catch {
    return [];
  }
}

export function serializeFeedbackHistory(
  items: LocalFeedbackHistoryItem[]
): string {
  return JSON.stringify({
    version: 1,
    items: normalizeHistory(items)
  });
}

export function recordFeedbackSubmission(
  items: LocalFeedbackHistoryItem[],
  submission: FeedbackSubmissionSummary,
  result: FeedbackSubmissionResult,
  submittedAt: string
): LocalFeedbackHistoryItem[] {
  const id = normalizeFeedbackPublicId(result.id);
  if (!id) return normalizeHistory(items);
  const existing = items.find(item => item.id === id);
  const timestamp = asTimestamp(submittedAt) || new Date().toISOString();
  const next: LocalFeedbackHistoryItem = {
    id,
    title: asString(submission.title) || existing?.title || '未命名反馈',
    category: asString(submission.category) || existing?.category || 'other',
    priority: asString(submission.priority) || existing?.priority || 'normal',
    submittedAt: existing?.submittedAt || timestamp,
    status: asString(result.status) || existing?.status || 'open',
    updatedAt: existing?.updatedAt || '',
    trackingUrl: asString(result.trackingUrl)
      || existing?.trackingUrl
      || `https://app.enkianss.us/feedback?id=${encodeURIComponent(id)}`,
    reply: existing?.reply || '',
    lastCheckedAt: existing?.lastCheckedAt || '',
    unreadReply: existing?.unreadReply === true
  };
  return normalizeHistory([next, ...items.filter(item => item.id !== id)]);
}

export function mergeFeedbackStatus(
  items: LocalFeedbackHistoryItem[],
  idValue: string,
  remote: PublicFeedbackStatus,
  checkedAt: string
): LocalFeedbackHistoryItem[] {
  const id = normalizeFeedbackPublicId(idValue);
  const checkedTimestamp = asTimestamp(checkedAt) || new Date().toISOString();
  return items.map(item => {
    if (!id || item.id !== id) return item;
    const remoteId = normalizeFeedbackPublicId(remote.id);
    if (remoteId !== id) return item;

    const remoteUpdatedAt = asTimestamp(remote.updatedAt);
    const localUpdatedAt = asTimestamp(item.updatedAt);
    if (
      remoteUpdatedAt
      && localUpdatedAt
      && Date.parse(remoteUpdatedAt) < Date.parse(localUpdatedAt)
    ) {
      return { ...item, lastCheckedAt: checkedTimestamp };
    }

    const nextReply = asString(remote.reply);
    const replyChanged = nextReply !== item.reply;
    return {
      ...item,
      title: asString(remote.title) || item.title,
      category: asString(remote.category) || item.category,
      status: asString(remote.status) || item.status,
      updatedAt: remoteUpdatedAt || item.updatedAt,
      reply: nextReply,
      lastCheckedAt: checkedTimestamp,
      unreadReply: nextReply.length > 0
        ? item.unreadReply || replyChanged
        : false
    };
  });
}

export function markFeedbackReplyRead(
  items: LocalFeedbackHistoryItem[],
  idValue?: string
): LocalFeedbackHistoryItem[] {
  const id = idValue ? normalizeFeedbackPublicId(idValue) : '';
  return items.map(item => (
    (!idValue || item.id === id) && item.reply
      ? { ...item, unreadReply: false }
      : item
  ));
}

export function countUnreadFeedbackReplies(
  items: LocalFeedbackHistoryItem[]
): number {
  return items.filter(item => item.reply && item.unreadReply).length;
}
