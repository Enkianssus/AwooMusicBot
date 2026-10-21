export type RequestNotificationKind = 'waiting' | 'success' | 'cancelled' | 'error';
/** Viewer request, viewer withdrawal, or a streamer removing a queued song. */
export type RequestNotificationAction = 'request' | 'cancel' | 'remove';

export interface RequestNotification {
  id: string;
  kind: RequestNotificationKind;
  action: RequestNotificationAction;
  title: string;
  message: string;
  requestedBy: string;
  createdAt: number;
  expiresAt: number;
}

export interface RequestNotificationInput {
  id?: string;
  kind: RequestNotificationKind;
  action?: RequestNotificationAction;
  title: string;
  message: string;
  requestedBy: string;
}

export const MAX_REQUEST_NOTIFICATIONS = 20;
export const REQUEST_NOTIFICATION_TTL_MS = 6_000;
export const WAITING_REQUEST_NOTIFICATION_TTL_MS = 120_000;
const REQUEST_NOTIFICATION_ACTIONS: readonly unknown[] = ['request', 'cancel', 'remove'];

function boundedText(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function notificationAction(value: unknown): RequestNotificationAction {
  return REQUEST_NOTIFICATION_ACTIONS.includes(value)
    ? value as RequestNotificationAction
    : 'request';
}

export function sanitizeRequestNotifications(
  value: unknown,
  now = Date.now()
): RequestNotification[] {
  if (!Array.isArray(value)) return [];
  const notifications = new Map<string, RequestNotification>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue;
    const source = candidate as Record<string, unknown>;
    const id = boundedText(source.id, 120);
    const kind = source.kind;
    const createdAt = source.createdAt;
    const expiresAt = source.expiresAt;
    if (
      !id
      || typeof kind !== 'string'
      || !['waiting', 'success', 'cancelled', 'error'].includes(kind)
      || typeof createdAt !== 'number' || !Number.isFinite(createdAt)
      || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)
      || createdAt < 0 || expiresAt <= createdAt || expiresAt <= now
    ) continue;
    notifications.delete(id);
    notifications.set(id, {
      id,
      kind: kind as RequestNotificationKind,
      // Older notices had no action; they were always viewer requests.
      action: notificationAction(source.action),
      title: boundedText(source.title, 200),
      message: boundedText(source.message, 500),
      requestedBy: boundedText(source.requestedBy, 80),
      createdAt,
      expiresAt
    });
  }
  return [...notifications.values()].slice(-MAX_REQUEST_NOTIFICATIONS);
}

export function parseRequestNotificationCommand(message: string): {
  action: 'request' | 'cancel';
  title: string;
} | null {
  const match = message.trim().match(/^(立即点歌|插队点歌|置顶点歌|优先点歌|点歌|點歌|撤回)(.*)$/s);
  if (!match) return null;
  const action = match[1] === '撤回' ? 'cancel' : 'request';
  return {
    action,
    title: match[2].trim() || (action === 'cancel' ? '最近一首点歌' : '未填写歌名')
  };
}

/** Retains only short-lived public UI feedback, never native player payloads. */
export class RequestNotificationStore {
  private sequence = 0;
  private notifications: RequestNotification[] = [];

  publish(input: RequestNotificationInput, now = Date.now()): string {
    const id = input.id || `${now.toString(36)}-${++this.sequence}`;
    const notification: RequestNotification = {
      id,
      kind: input.kind,
      action: notificationAction(input.action),
      title: input.title,
      message: input.message,
      requestedBy: input.requestedBy,
      createdAt: now,
      expiresAt: now + (input.kind === 'waiting'
        ? WAITING_REQUEST_NOTIFICATION_TTL_MS
        : REQUEST_NOTIFICATION_TTL_MS)
    };
    this.notifications = sanitizeRequestNotifications([
      ...this.notifications.filter(item => item.id !== id),
      notification
    ], now);
    return id;
  }

  snapshot(now = Date.now()): RequestNotification[] {
    this.notifications = sanitizeRequestNotifications(this.notifications, now);
    return this.notifications.map(notification => ({ ...notification }));
  }

  /** Withdraws a notice that no longer needs a result, such as a coalesced one. */
  remove(id: string): void {
    this.notifications = this.notifications.filter(item => item.id !== id);
  }
}
