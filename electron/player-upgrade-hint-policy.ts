export const NETEASE_TESTED_PLAYER_VERSION = '3.1.37.205354';
export const KUGOU_TESTED_PLAYER_VERSION = '20.0.81.27563';
export const QQMUSIC_TESTED_PLAYER_VERSIONS = '22.22 / 22.41 / 22.51 / 22.52';

const PLAYER_UPGRADE_PROFILES = {
  netease: {
    code: 'netease-player-update-suggested',
    playerName: '网易云音乐',
    testedPlayerVersion: NETEASE_TESTED_PLAYER_VERSION,
    commands: ['PlaySelected', 'InsertNext']
  },
  kugou: {
    code: 'kugou-player-update-suggested',
    playerName: '酷狗音乐',
    testedPlayerVersion: KUGOU_TESTED_PLAYER_VERSION,
    commands: ['PlaySelected', 'InsertNext']
  },
  qqmusic: {
    code: 'qqmusic-player-update-suggested',
    playerName: 'QQ 音乐',
    testedPlayerVersion: QQMUSIC_TESTED_PLAYER_VERSIONS,
    commands: ['PlaySelected', 'InterruptSelected', 'InsertNext']
  }
} as const;

type UpgradeHintPlayerKey = keyof typeof PLAYER_UPGRADE_PROFILES;

const UPGRADE_SENSITIVE_COMMANDS = new Set([
  'PlaySelected',
  'InterruptSelected',
  'InsertNext'
]);

const SUCCESSFUL_OUTCOMES = new Set([
  'accepted',
  'applied',
  'verified',
  'indeterminate'
]);

export interface PlayerUpgradeHintInput {
  playerKey: string;
  connected: boolean;
  playerVersion: unknown;
  testedPlayerVersion?: unknown;
  command: unknown;
  outcome: unknown;
  processId?: number | null;
  failureCode?: unknown;
  message?: unknown;
}

export interface PlayerUpgradeHint {
  kind: 'upgrade';
  code: 'netease-player-update-suggested'
    | 'kugou-player-update-suggested'
    | 'qqmusic-player-update-suggested';
  reason: 'older-than-tested-after-control-failure'
    | 'player-version-unsupported';
  playerKey: UpgradeHintPlayerKey;
  playerName: '网易云音乐' | '酷狗音乐' | 'QQ 音乐';
  currentVersion: string;
  testedPlayerVersion: string;
  blockedCommand: string;
  processId: number | null;
}

export interface PlayerProcessAccessHint {
  kind: 'process-access';
  code: 'qqmusic-control-access-denied';
  reason: 'process-access-denied';
  playerKey: 'qqmusic';
  playerName: 'QQ 音乐';
  currentVersion: string;
  blockedCommand: string;
  processId: number | null;
  operation: string;
}

function parseNumericVersion(value: unknown): number[] | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!/^\d+(?:\.\d+){1,5}$/.test(text)) return null;
  const parts = text.split('.').map(part => Number(part));
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function findOldestTestedPlayerVersion(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  const versions = text.match(/\d+(?:\.\d+){1,5}/g) || [];
  let oldest: string | null = null;
  for (const version of versions) {
    if (
      oldest === null
      || compareNumericPlayerVersions(version, oldest) === -1
    ) {
      oldest = version;
    }
  }
  return oldest;
}

export function compareNumericPlayerVersions(
  leftValue: unknown,
  rightValue: unknown
): number | null {
  const left = parseNumericVersion(leftValue);
  const right = parseNumericVersion(rightValue);
  if (!left || !right) return null;
  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index++) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

export function isUpgradeSensitivePlayerCommand(command: unknown): boolean {
  return UPGRADE_SENSITIVE_COMMANDS.has(String(command || ''));
}

function isFailedPlayerOutcome(outcome: unknown): boolean {
  return !SUCCESSFUL_OUTCOMES.has(String(outcome || '').toLowerCase());
}

const ACCESS_DENIED_OPERATION_PATTERN = new RegExp(
  '(OpenProcess|WriteProcessMemory|ReadProcessMemory|VirtualAllocEx|'
  + 'VirtualProtectEx|FlushInstructionCache|CreateRemoteThread)'
  + '[\\s\\S]{0,180}Win32\\s*=\\s*5',
  'i'
);

export function buildPlayerProcessAccessHint(
  input: PlayerUpgradeHintInput
): PlayerProcessAccessHint | null {
  if (input.playerKey !== 'qqmusic' || !input.connected) return null;
  const command = String(input.command || '');
  if (!isUpgradeSensitivePlayerCommand(command)) return null;
  if (!isFailedPlayerOutcome(input.outcome)) return null;

  const failureCode = String(input.failureCode || '').toLowerCase();
  if (failureCode && failureCode !== 'process-access-denied') return null;
  const message = typeof input.message === 'string' ? input.message : '';
  const legacyMatch = message.match(ACCESS_DENIED_OPERATION_PATTERN);
  if (failureCode !== 'process-access-denied' && !legacyMatch) return null;
  if (
    failureCode !== 'process-access-denied'
    && String(input.outcome || '').toLowerCase() !== 'rejected'
  ) return null;

  const currentVersion = typeof input.playerVersion === 'string'
    ? input.playerVersion.trim()
    : '';
  return {
    kind: 'process-access',
    code: 'qqmusic-control-access-denied',
    reason: 'process-access-denied',
    playerKey: 'qqmusic',
    playerName: 'QQ 音乐',
    currentVersion: currentVersion || '未知',
    blockedCommand: command,
    processId: Number.isInteger(input.processId)
      ? Number(input.processId)
      : null,
    operation: legacyMatch?.[1] || '播放器进程控制'
  };
}

export function buildPlayerUpgradeHint(
  input: PlayerUpgradeHintInput
): PlayerUpgradeHint | null {
  const playerKey = input.playerKey as UpgradeHintPlayerKey;
  const profile = PLAYER_UPGRADE_PROFILES[playerKey];
  if (!profile || !input.connected) return null;
  const command = String(input.command || '');
  if (!(profile.commands as readonly string[]).includes(command)) return null;

  if (!isFailedPlayerOutcome(input.outcome)) return null;

  const currentVersion = typeof input.playerVersion === 'string'
    ? input.playerVersion.trim()
    : '';
  const testedPlayerVersion = (
    typeof input.testedPlayerVersion === 'string'
      ? input.testedPlayerVersion.trim()
      : ''
  ) || profile.testedPlayerVersion;
  const failureCode = String(input.failureCode || '').toLowerCase();
  if (failureCode === 'process-access-denied') return null;
  const explicitlyUnsupported = failureCode === 'player-version-unsupported';
  if (
    !explicitlyUnsupported
    && String(input.outcome || '').toLowerCase() !== 'rejected'
  ) return null;
  const oldestTestedPlayerVersion = findOldestTestedPlayerVersion(
    testedPlayerVersion
  );
  const versionComparison = compareNumericPlayerVersions(
    currentVersion,
    oldestTestedPlayerVersion
  );
  if (!explicitlyUnsupported && versionComparison !== -1) return null;

  return {
    kind: 'upgrade',
    code: profile.code,
    reason: explicitlyUnsupported
      ? 'player-version-unsupported'
      : 'older-than-tested-after-control-failure',
    playerKey,
    playerName: profile.playerName,
    currentVersion: currentVersion || '未知',
    testedPlayerVersion,
    blockedCommand: command,
    processId: Number.isInteger(input.processId)
      ? Number(input.processId)
      : null
  };
}
