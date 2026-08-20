export type GiftRequestTier =
  | 'Normal'
  | 'Captain'
  | 'Admiral'
  | 'Governor';

export interface GiftRequestRequirement {
  giftName: string;
  giftId: string;
}

export type GiftRequestRequirements = Record<
  GiftRequestTier,
  GiftRequestRequirement
>;

export interface BilibiliGiftCreditEvent {
  uid: string;
  userName: string;
  giftName: string;
  giftId: string;
  guardLevel: number;
  quantity: number;
  eventId: string;
}

export interface LearnedGift {
  giftName: string;
  giftId: string;
  lastSeenAt: number;
  lastQuantity: number;
}

const TIER_KEYS: readonly GiftRequestTier[] = [
  'Normal',
  'Captain',
  'Admiral',
  'Governor'
];

const MAX_GIFT_QUANTITY_PER_EVENT = 10_000;
const MAX_SESSION_CREDITS = 1_000_000;
export const MAX_LEARNED_GIFTS = 50;

export function createEmptyGiftRequestRequirements(): GiftRequestRequirements {
  return {
    Normal: { giftName: '', giftId: '' },
    Captain: { giftName: '', giftId: '' },
    Admiral: { giftName: '', giftId: '' },
    Governor: { giftName: '', giftId: '' }
  };
}

function normalizeIdentifier(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') {
    return String(value).trim().slice(0, 80);
  }
  return '';
}

export function normalizeGiftRequestRequirements(
  value: unknown
): GiftRequestRequirements {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const result = createEmptyGiftRequestRequirements();
  for (const tier of TIER_KEYS) {
    const raw = source[tier];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const requirement = raw as Record<string, unknown>;
    result[tier] = {
      giftName: normalizeIdentifier(
        requirement.giftName ?? requirement.GiftName
      ),
      giftId: normalizeIdentifier(
        requirement.giftId ?? requirement.GiftId
      )
    };
  }
  return result;
}

export function giftRequestTierFromGuardLevel(
  guardLevel: unknown
): GiftRequestTier {
  switch (Number(guardLevel)) {
    case 3:
      return 'Captain';
    case 2:
      return 'Admiral';
    case 1:
      return 'Governor';
    default:
      return 'Normal';
  }
}

export function giftRequestTierLabel(tier: GiftRequestTier): string {
  switch (tier) {
    case 'Captain': return '舰长';
    case 'Admiral': return '提督';
    case 'Governor': return '总督';
    default: return '普通观众';
  }
}

export function isGiftRequestRequirementEnabled(
  requirement: GiftRequestRequirement | null | undefined
): boolean {
  return Boolean(
    normalizeIdentifier(requirement?.giftName)
    || normalizeIdentifier(requirement?.giftId)
  );
}

export function matchesGiftRequestRequirement(
  requirement: GiftRequestRequirement | null | undefined,
  gift: { giftName?: unknown; giftId?: unknown }
): boolean {
  if (!isGiftRequestRequirementEnabled(requirement)) return false;
  const configuredName = normalizeIdentifier(requirement?.giftName)
    .toLocaleLowerCase('zh-CN');
  const configuredId = normalizeIdentifier(requirement?.giftId);
  const eventName = normalizeIdentifier(gift.giftName)
    .toLocaleLowerCase('zh-CN');
  const eventId = normalizeIdentifier(gift.giftId);
  if (configuredId) return Boolean(eventId && eventId === configuredId);
  return Boolean(configuredName && eventName === configuredName);
}

function learnedGiftKey(
  gift: Pick<LearnedGift, 'giftName' | 'giftId'>
): string {
  const id = normalizeIdentifier(gift.giftId);
  if (id) return `id:${id}`;
  return `name:${normalizeIdentifier(gift.giftName).toLocaleLowerCase('zh-CN')}`;
}

export function normalizeLearnedGifts(
  value: unknown,
  limit = MAX_LEARNED_GIFTS
): LearnedGift[] {
  if (!Array.isArray(value)) return [];
  const byKey = new Map<string, LearnedGift>();

  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const source = raw as Record<string, unknown>;
    const giftName = normalizeIdentifier(source.giftName ?? source.GiftName);
    const giftId = normalizeIdentifier(source.giftId ?? source.GiftId);
    if (!giftName && !giftId) continue;

    const timestamp = Number(source.lastSeenAt);
    const lastSeenAt = Number.isFinite(timestamp) && timestamp > 0
      ? Math.floor(timestamp)
      : 0;
    const lastQuantity = normalizeGiftQuantity(
      source.lastQuantity ?? source.quantity
    ) || 1;
    const gift: LearnedGift = {
      giftName,
      giftId,
      lastSeenAt,
      lastQuantity
    };
    const key = learnedGiftKey(gift);
    const previous = byKey.get(key);
    if (!previous || gift.lastSeenAt >= previous.lastSeenAt) {
      byKey.set(key, gift);
    }
  }

  const safeLimit = Math.max(0, Math.min(
    MAX_LEARNED_GIFTS,
    Math.floor(Number(limit) || 0)
  ));
  return [...byKey.values()]
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
    .slice(0, safeLimit);
}

export function rememberLearnedGift(
  existing: unknown,
  gift: { giftName?: unknown; giftId?: unknown; quantity?: unknown },
  seenAt: unknown,
  limit = MAX_LEARNED_GIFTS
): LearnedGift[] {
  const giftName = normalizeIdentifier(gift.giftName);
  const giftId = normalizeIdentifier(gift.giftId);
  if (!giftName && !giftId) return normalizeLearnedGifts(existing, limit);

  const timestamp = Number(seenAt);
  const next: LearnedGift = {
    giftName,
    giftId,
    lastSeenAt: Number.isFinite(timestamp) && timestamp > 0
      ? Math.floor(timestamp)
      : 0,
    lastQuantity: normalizeGiftQuantity(gift.quantity) || 1
  };
  const key = learnedGiftKey(next);
  return normalizeLearnedGifts([
    next,
    ...normalizeLearnedGifts(existing, limit).filter(item => (
      learnedGiftKey(item) !== key
    ))
  ], limit);
}

export function normalizeGiftQuantity(value: unknown): number {
  const quantity = Math.floor(Number(value));
  if (!Number.isFinite(quantity) || quantity <= 0) return 0;
  return Math.min(quantity, MAX_GIFT_QUANTITY_PER_EVENT);
}

export function parseBilibiliGiftCreditEvent(
  document: unknown
): BilibiliGiftCreditEvent | null {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return null;
  }
  const envelope = document as Record<string, unknown>;
  if (envelope.cmd !== 'SEND_GIFT') return null;
  const rawData = envelope.data;
  if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) {
    return null;
  }
  const data = rawData as Record<string, unknown>;
  const uid = normalizeIdentifier(data.uid);
  const giftName = normalizeIdentifier(data.giftName ?? data.gift_name);
  const giftId = normalizeIdentifier(data.giftId ?? data.gift_id);
  const quantity = normalizeGiftQuantity(data.num);
  if (!uid || (!giftName && !giftId) || quantity <= 0) return null;
  const rawGuardLevel = Number(data.guard_level ?? data.guardLevel ?? 0);
  const guardLevel = [1, 2, 3].includes(rawGuardLevel)
    ? rawGuardLevel
    : 0;
  return {
    uid,
    userName: normalizeIdentifier(data.uname) || `用户${uid.slice(-6)}`,
    giftName,
    giftId,
    guardLevel,
    quantity,
    eventId: normalizeIdentifier(data.rnd ?? data.tid)
  };
}

export function addGiftRequestCredits(
  currentBalance: unknown,
  quantity: unknown
): number {
  const current = Math.max(0, Math.floor(Number(currentBalance) || 0));
  return Math.min(
    MAX_SESSION_CREDITS,
    current + normalizeGiftQuantity(quantity)
  );
}

export function canRequestWithGiftCredits(
  requirement: GiftRequestRequirement | null | undefined,
  currentBalance: unknown,
  isSuperUser: boolean
): boolean {
  return isSuperUser
    || !isGiftRequestRequirementEnabled(requirement)
    || Math.floor(Number(currentBalance) || 0) > 0;
}

export function consumeGiftRequestCredit(
  requirement: GiftRequestRequirement | null | undefined,
  currentBalance: unknown,
  isSuperUser: boolean,
  requestSucceeded: boolean
): number {
  const current = Math.max(0, Math.floor(Number(currentBalance) || 0));
  if (
    !requestSucceeded
    || isSuperUser
    || !isGiftRequestRequirementEnabled(requirement)
  ) return current;
  return Math.max(0, current - 1);
}

export function describeGiftRequestRequirement(
  requirement: GiftRequestRequirement
): string {
  const name = normalizeIdentifier(requirement.giftName);
  const id = normalizeIdentifier(requirement.giftId);
  if (name && id) return `“${name}”（ID ${id}）`;
  if (name) return `“${name}”`;
  return `礼物 ID ${id}`;
}
