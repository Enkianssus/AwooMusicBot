import {
  createEmptyGiftRequestRequirements,
  normalizeGiftRequestRequirements,
  type GiftRequestRequirements
} from './gift-request-credit-policy.ts';
import {
  DEFAULT_EXTERNAL_API_PORT,
  DEFAULT_INTERNAL_API_PORT,
  normalizeLocalApiPort
} from './internal-api-port.ts';

/**
 * The one definition of the persisted settings (bili_bot_config.json) and of
 * how a saved or posted copy is coerced back into shape.
 *
 * Every known key is coerced to the meaning the running code already gives
 * it, so a normalized file behaves like the raw one did; settings that decide
 * who may command the bot can only become stricter. Keys this version does
 * not know are kept unchanged: a newer release may have written them, and a
 * downgrade must not erase them.
 */

export const PLAYER_TYPES = ['NCM', 'Kugou', 'QQMusic', 'Folia'] as const;
export type PlayerType = typeof PLAYER_TYPES[number];

export const REQUESTED_SONG_ARTWORK_MODES = ['bili_avatar', 'song_cover'] as const;
export type RequestedSongArtwork = typeof REQUESTED_SONG_ARTWORK_MODES[number];

export const COOLDOWN_TIERS = ['Normal', 'Captain', 'Admiral', 'Governor'] as const;
export type CooldownTier = typeof COOLDOWN_TIERS[number];
export type Cooldowns = Record<CooldownTier, number>;

/** The danmaku command permissions the control panel can edit. */
export const PERMISSION_KEYS = [
  'OrderPermission',
  'SkipPermission',
  'PriorityPermission',
  'CancelPermission',
  'ToggleAcceptPermission',
  'ForceControlPermission'
] as const;
export type PermissionKey = typeof PERMISSION_KEYS[number];

/** -1 room managers and super users only, 0 everyone, 1-3 that guard level or higher. */
export const PERMISSION_GUARD_TYPES: readonly number[] = [-1, 0, 1, 2, 3];

export interface PermissionConfig {
  AllowManager: boolean;
  MinGuardType: number;
  MinMedalLevel: number;
  [key: string]: unknown;
}

export const MAX_SUPER_USERS = 200;
export const MAX_SUPER_USER_LENGTH = 32;

/** Settings of removed features; they are dropped whenever a config is normalized. */
export const LEGACY_SYS_CONFIG_KEYS = ['EnableCDP', 'CdpPort', 'NcmExePath'] as const;

/** Added to the public copy of the settings only; never persisted. */
const DERIVED_SYS_CONFIG_KEYS = ['FoliaTokenConfigured'] as const;

export interface SysConfig {
  PlayerType: PlayerType;
  FoliaToken: string;
  Cooldowns: Cooldowns;
  GiftRequestRequirements: GiftRequestRequirements;
  IdleWaitNext: boolean;
  ShowPlayerCurrentTrack: boolean;
  PauseAfterRequests: boolean;
  RequestedSongArtwork: RequestedSongArtwork;
  DynamicCoverEnabled: boolean;
  ShowAllDanmaku: boolean;
  SuperUsers: string[];
  ExternalHttpEnabled: boolean;
  ExternalWebSocketEnabled: boolean;
  ExternalApiPort: number;
  InternalApiPort: number;
  [key: string]: unknown;
}

export interface SysConfigOptions {
  /** The internal API port requested through the environment; the default for InternalApiPort. */
  envInternalPort?: number;
}

export interface NormalizeSysConfigOptions extends SysConfigOptions {
  /**
   * The top-level `superUsers` list of very old configs, used when `raw` is
   * not a settings object. loadConfig passes it only for a saved sysConfig
   * that is empty (null, false, 0 or ''), as 1.2.5 did.
   */
  legacySuperUsers?: unknown;
}

export type UiColorMode = 'light' | 'dark';

export interface DefaultAppConfig {
  roomId: number;
  roomConnectionEnabled: boolean;
  myRoomId: number;
  biliCookie: string;
  biliUid: number;
  learnedGifts: unknown[];
  widgetStyle: Record<string, unknown> | null;
  sysConfig: SysConfig;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolveEnvInternalPort(options: SysConfigOptions): number {
  return normalizeLocalApiPort(options.envInternalPort, DEFAULT_INTERNAL_API_PORT);
}

export function createDefaultCooldowns(): Cooldowns {
  return { Normal: 0, Captain: 0, Admiral: 0, Governor: 0 };
}

/**
 * The permission the danmaku command check applies when none is saved:
 * managers may always act, and only the queue-forcing commands are limited
 * to managers and super users.
 */
export function createDefaultPermission(key: string): PermissionConfig {
  return {
    AllowManager: true,
    MinGuardType: key === 'ForceControlPermission' ? -1 : 0,
    MinMedalLevel: 0
  };
}

export function createDefaultSysConfig(options: SysConfigOptions = {}): SysConfig {
  return {
    PlayerType: 'NCM',
    FoliaToken: '',
    Cooldowns: createDefaultCooldowns(),
    GiftRequestRequirements: createEmptyGiftRequestRequirements(),
    IdleWaitNext: true,
    ShowPlayerCurrentTrack: true,
    PauseAfterRequests: false,
    RequestedSongArtwork: 'bili_avatar',
    DynamicCoverEnabled: true,
    ShowAllDanmaku: false,
    SuperUsers: [],
    ExternalHttpEnabled: false,
    ExternalWebSocketEnabled: false,
    ExternalApiPort: DEFAULT_EXTERNAL_API_PORT,
    InternalApiPort: resolveEnvInternalPort(options)
  };
}

/** The in-memory settings before bili_bot_config.json is read. */
export function createDefaultAppConfig(options: SysConfigOptions = {}): DefaultAppConfig {
  return {
    roomId: 0,
    roomConnectionEnabled: false,
    myRoomId: 0,
    biliCookie: '',
    biliUid: 0,
    learnedGifts: [],
    widgetStyle: null,
    sysConfig: createDefaultSysConfig(options)
  };
}

/*
 * Cooldowns, permissions and super users decide who may command the bot.
 * Their normalized form must never let anyone through whom the command
 * checks in main.ts would stop for the raw saved value. Those checks compare
 * with `>` and read flags by truthiness, so the coercions below follow
 * JavaScript's own conversion, and a value is only ever made stricter.
 */

/** The number a JavaScript comparison such as `value > 0` sees. */
function comparedNumber(value: unknown): number {
  if (value === undefined || typeof value === 'symbol' || typeof value === 'bigint') return Number.NaN;
  return Number(value);
}

/**
 * A positive limit compared with whole numbers (seconds waited, medal
 * levels): rounding up keeps exactly the same people out, and a limit too
 * large for JSON stays the largest safe integer instead of becoming no limit.
 */
function wholeLimit(value: unknown): number {
  const limit = comparedNumber(value);
  if (!(limit > 0)) return 0;
  const whole = Math.ceil(limit);
  return Number.isSafeInteger(whole) ? whole : Number.MAX_SAFE_INTEGER;
}

export function normalizeCooldowns(value: unknown): Cooldowns {
  const defaults = createDefaultCooldowns();
  if (!isPlainObject(value)) return defaults;
  const result: Record<string, unknown> = { ...value };
  for (const tier of COOLDOWN_TIERS) {
    // Only a positive number starts a cooldown; anything else means none.
    result[tier] = wholeLimit(value[tier]) || defaults[tier];
  }
  return result as Cooldowns;
}

/**
 * The guard requirement the command check applies: -1 lets only managers
 * through, a positive value admits guard levels 1-3 that do not exceed it,
 * and anything else does not restrict. A value between 0 and 1 admits no
 * guard level, which is the same as -1. A numeric string "-1" is read as -1,
 * as the control panel already displays it.
 */
function normalizeGuardType(value: unknown, whenMissing: number): number {
  if (value === undefined) return whenMissing;
  const level = comparedNumber(value);
  if (level === -1) return -1;
  if (!(level > 0)) return 0;
  if (level >= 3) return 3;
  if (level >= 2) return 2;
  if (level >= 1) return 1;
  return -1;
}

/**
 * A saved permission in the default shape. Each field keeps the effect the
 * command check gives the raw value: AllowManager is read by truthiness, so a
 * missing flag stays false. A missing guard requirement takes the default
 * only where that is stricter (ForceControlPermission: managers only).
 * A value that is not an object takes the default permission, which is never
 * more permissive than the check reading such a value. Unknown fields are kept.
 */
export function normalizePermission(value: unknown, key: string): PermissionConfig {
  const defaults = createDefaultPermission(key);
  if (!isPlainObject(value)) return defaults;
  return {
    ...value,
    AllowManager: Boolean(value.AllowManager),
    MinGuardType: normalizeGuardType(value.MinGuardType, defaults.MinGuardType),
    MinMedalLevel: wholeLimit(value.MinMedalLevel)
  };
}

/**
 * Super users are Bilibili user names or UIDs, compared exactly. Entries are
 * kept as written; blank, overlong, repeated and non-text entries are dropped
 * rather than changed, because a changed name could match a different viewer.
 */
export function normalizeSuperUsers(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (result.length >= MAX_SUPER_USERS) break;
    const text = typeof item === 'string'
      ? item
      : typeof item === 'number' && Number.isSafeInteger(item) && item > 0
        ? String(item)
        : '';
    if (!text.trim() || Array.from(text).length > MAX_SUPER_USER_LENGTH || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function normalizeFoliaToken(value: unknown): string {
  if (typeof value === 'string') return value;
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? value as T
    : fallback;
}

/**
 * Coerces a saved or posted sysConfig. The result is a new object; `raw` is
 * not modified. Use it both when loading the file and after merging a POST
 * /api/config body, so the two paths cannot drift apart again.
 */
export function normalizeSysConfig(
  raw: unknown,
  options: NormalizeSysConfigOptions = {}
): SysConfig {
  const envInternalPort = resolveEnvInternalPort(options);
  const source: Record<string, unknown> = isPlainObject(raw)
    ? { ...raw }
    : {
        ...createDefaultSysConfig({ envInternalPort }),
        SuperUsers: options.legacySuperUsers ?? []
      };

  // Before per-tier cooldowns existed one value in minutes applied to everyone.
  if (source.CooldownMinutes !== undefined && !source.Cooldowns) {
    const seconds = comparedNumber(source.CooldownMinutes) * 60;
    source.Cooldowns = { Normal: seconds, Captain: seconds, Admiral: seconds, Governor: seconds };
    delete source.CooldownMinutes;
  }

  const config: Record<string, unknown> = {
    ...source,
    PlayerType: oneOf(source.PlayerType, PLAYER_TYPES, 'NCM'),
    FoliaToken: normalizeFoliaToken(source.FoliaToken),
    Cooldowns: normalizeCooldowns(source.Cooldowns),
    GiftRequestRequirements: normalizeGiftRequestRequirements(source.GiftRequestRequirements),
    // Each boolean keeps the reading the rest of the app applies to it.
    IdleWaitNext: source.IdleWaitNext !== false,
    ShowPlayerCurrentTrack: source.ShowPlayerCurrentTrack !== false,
    PauseAfterRequests: source.PauseAfterRequests === true,
    RequestedSongArtwork: oneOf(source.RequestedSongArtwork, REQUESTED_SONG_ARTWORK_MODES, 'bili_avatar'),
    DynamicCoverEnabled: source.DynamicCoverEnabled !== false,
    ShowAllDanmaku: Boolean(source.ShowAllDanmaku),
    SuperUsers: normalizeSuperUsers(source.SuperUsers),
    ExternalHttpEnabled: source.ExternalHttpEnabled === true,
    ExternalWebSocketEnabled: source.ExternalWebSocketEnabled === true,
    ExternalApiPort: normalizeLocalApiPort(source.ExternalApiPort, DEFAULT_EXTERNAL_API_PORT),
    InternalApiPort: normalizeLocalApiPort(source.InternalApiPort, envInternalPort)
  };

  // A permission that was never saved stays absent; the command check then
  // applies createDefaultPermission, which is also what the panel shows.
  for (const key of PERMISSION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      config[key] = normalizePermission(source[key], key);
    }
  }
  for (const key of LEGACY_SYS_CONFIG_KEYS) delete config[key];
  for (const key of DERIVED_SYS_CONFIG_KEYS) delete config[key];
  return config as SysConfig;
}

function parseRoomId(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * A live room ID is a safe positive integer (a digit string is accepted).
 * Anything else keeps `previous`, or 0 when that is not a room ID either.
 */
export function normalizeRoomId(value: unknown, previous: unknown = 0): number {
  return parseRoomId(value) || parseRoomId(previous);
}

/** The control panel opens dark unless the last mode it reported was light. */
export function normalizeUiColorMode(value: unknown): UiColorMode {
  return value === 'light' ? 'light' : 'dark';
}
