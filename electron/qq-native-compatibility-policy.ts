import type {
  PlayerCapabilities,
  PlayerOperationResult,
  PlayerSnapshot
} from './player-bridge-client';

export const QQ_NATIVE_UNSUPPORTED = 'player-version-unsupported';
const NATIVE_QUEUE_COMMANDS = new Set([
  'PlaySelected', 'InterruptSelected', 'InsertNext', 'ArmNextGuard'
]);

/** Snapshot capabilities supersede ping; absent fields retain legacy behavior. */
export function mergeSnapshotCapabilities(
  snapshot: PlayerSnapshot,
  fallback: PlayerCapabilities | null
): PlayerSnapshot {
  return { ...snapshot, capabilities: snapshot.capabilities ?? fallback };
}

export function isQqNativeQueueUnavailable(
  playerKey: string,
  snapshot: PlayerSnapshot | null | undefined
): boolean {
  return playerKey === 'qqmusic' && snapshot?.connected === true && (
    snapshot.compatibilityFailureCode === QQ_NATIVE_UNSUPPORTED
    || snapshot.capabilities?.playSelected === false
    || snapshot.capabilities?.insertNext === false
  );
}

export function qqNativeCompatibilityMessage(version: string): string {
  return `当前 QQ 音乐 ${version || '未知版本'} 尚未适配点歌插入，`
    + '请检查 QQ 连接器更新；搜索和手动切歌仍可用。';
}

export function rejectUnsupportedQqCommand(
  playerKey: string,
  command: string,
  snapshot: PlayerSnapshot | null | undefined
): PlayerOperationResult | null {
  if (!NATIVE_QUEUE_COMMANDS.has(command)
      || !isQqNativeQueueUnavailable(playerKey, snapshot)) return null;
  return {
    outcome: 'rejected',
    message: qqNativeCompatibilityMessage(snapshot!.version),
    failureCode: QQ_NATIVE_UNSUPPORTED,
    snapshot
  };
}

export interface QqCompatibilityHint {
  kind: 'compatibility';
  code: 'qqmusic-player-version-unsupported';
  reason: 'player-version-unsupported';
  playerKey: 'qqmusic';
  playerName: 'QQ 音乐';
  currentVersion: string;
  blockedCommand: string;
  processId: number | null;
}

export function buildQqCompatibilityHint(
  playerKey: string,
  snapshot: PlayerSnapshot | null | undefined,
  command = 'InsertNext'
): QqCompatibilityHint | null {
  if (!isQqNativeQueueUnavailable(playerKey, snapshot)) return null;
  return {
    kind: 'compatibility',
    code: 'qqmusic-player-version-unsupported',
    reason: 'player-version-unsupported',
    playerKey: 'qqmusic',
    playerName: 'QQ 音乐',
    currentVersion: snapshot!.version || '未知',
    blockedCommand: command,
    processId: snapshot!.processId ?? null
  };
}
