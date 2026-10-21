/**
 * Pure decisions for background connector maintenance: which hot updates may
 * run now, in which order, and when to check again. This module has no
 * Electron, file system or network dependency so the plan can be tested
 * directly.
 */

/** The part of a connector status that maintenance decisions depend on. */
export interface MaintenanceConnectorStatus<Id extends string = string> {
  id: Id;
  installed: boolean;
  latestVersion: string | null;
  compatible: boolean;
  updateAvailable: boolean;
  autoUpdateAvailable: boolean;
  updating: boolean;
  quarantined?: boolean;
  error: string | null;
}

/**
 * Why a connector is left alone in this run:
 * - `error`: the catalog check failed; checked again soon.
 * - `incompatible`: the latest version needs a newer core.
 * - `updating`: an install of this connector is already running.
 * - `up-to-date`: the installed version is the latest.
 * - `manual-only`: only a manual update, such as a new player branch, exists.
 * - `quarantined`: the latest version was rolled back on this computer.
 * - `not-selected-missing`: other players' connectors install on selection.
 * - `netease-running`: replacing the connector would close a running NetEase.
 * - `selected-busy`: a reconnect would interrupt requested playback.
 * - `backoff`: this version failed recently and waits for its next attempt.
 * - `guard-busy`: another update holds the installation lock.
 */
export type MaintenanceSkipReason =
  | 'error'
  | 'incompatible'
  | 'updating'
  | 'up-to-date'
  | 'manual-only'
  | 'quarantined'
  | 'not-selected-missing'
  | 'netease-running'
  | 'selected-busy'
  | 'backoff'
  | 'guard-busy';

/** A missing selected connector installs; an installed one auto-updates. */
export type MaintenanceUpdateReason = 'install' | 'auto-update';

export type MaintenanceAction<Id extends string = string> =
  | { id: Id; kind: 'update'; reason: MaintenanceUpdateReason }
  | { id: Id; kind: 'skip'; reason: MaintenanceSkipReason };

export interface MaintenanceFailure {
  failures: number;
  nextAttemptAt: number;
}

/** Failed attempts keyed by `maintenanceFailureKey(id, version)`. */
export type MaintenanceFailureMemo = Map<string, MaintenanceFailure>;

export interface MaintenancePlanInput<Id extends string> {
  statuses: readonly MaintenanceConnectorStatus<Id>[];
  selectedId: Id | null;
  /** The component holding the shared update lock, if any. */
  guardComponentId: string | null;
  neteaseRunning: boolean;
  /** A reconnect of the selected connector would interrupt requested playback. */
  selectedBusy: boolean;
  failureMemo: ReadonlyMap<string, MaintenanceFailure>;
  now: number;
}

export interface MaintenancePlan<Id extends string> {
  /** One action per status, the selected connector first. */
  actions: MaintenanceAction<Id>[];
  /** Check again after this delay instead of waiting for the next interval. */
  retrySoonMs: number | null;
}

/** Wait after the first, second, and every later failure of one version. */
export const CONNECTOR_MAINTENANCE_BACKOFF_MS: readonly number[] = [
  30 * 60 * 1000,
  2 * 60 * 60 * 1000,
  6 * 60 * 60 * 1000
];
export const MAINTENANCE_ERROR_RETRY_MS = 3 * 60 * 1000;
export const MAINTENANCE_BUSY_RETRY_MS = 3 * 60 * 1000;
export const MAINTENANCE_NETEASE_RETRY_MS = 5 * 60 * 1000;

export function maintenanceFailureKey(
  connectorId: string,
  version: string | null
): string {
  return `${connectorId}@${version || 'unknown'}`;
}

/** The sooner of two optional retry delays. */
export function earliestRetry(
  left: number | null,
  right: number | null
): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}

type MaintenanceDecision =
  | { kind: 'update'; reason: MaintenanceUpdateReason }
  | { kind: 'skip'; reason: MaintenanceSkipReason; retryMs: number | null };

function skip(
  reason: MaintenanceSkipReason,
  retryMs: number | null = null
): MaintenanceDecision {
  return { kind: 'skip', reason, retryMs };
}

function decide<Id extends string>(
  status: MaintenanceConnectorStatus<Id>,
  input: MaintenancePlanInput<Id>
): MaintenanceDecision {
  const selected = status.id === input.selectedId;
  // A connector the user does not use is neither installed nor checked.
  if (!status.installed && !selected) return skip('not-selected-missing');
  if (status.error) return skip('error', MAINTENANCE_ERROR_RETRY_MS);
  if (!status.compatible) return skip('incompatible');
  if (status.updating) return skip('updating');
  if (status.installed) {
    if (status.quarantined) return skip('quarantined');
    if (!status.updateAvailable) return skip('up-to-date');
    if (!status.autoUpdateAvailable) return skip('manual-only');
    // A first install never closes NetEase; replacing an active connector
    // may, so its patch waits until NetEase has been closed.
    if (status.id === 'netease' && input.neteaseRunning) {
      return skip('netease-running', MAINTENANCE_NETEASE_RETRY_MS);
    }
    // Only an installed connector has a connection a reconnect interrupts.
    if (selected && input.selectedBusy) {
      return skip('selected-busy', MAINTENANCE_BUSY_RETRY_MS);
    }
  }
  const failure = input.failureMemo.get(
    maintenanceFailureKey(status.id, status.latestVersion)
  );
  if (failure && failure.nextAttemptAt > input.now) return skip('backoff');
  if (input.guardComponentId) return skip('guard-busy');
  return {
    kind: 'update',
    reason: status.installed ? 'auto-update' : 'install'
  };
}

/**
 * Plans one maintenance run. The selected connector comes first so its own
 * update never waits behind other players, and `retrySoonMs` asks for an
 * early recheck when a skip is expected to clear within minutes.
 */
export function planConnectorMaintenance<Id extends string>(
  input: MaintenancePlanInput<Id>
): MaintenancePlan<Id> {
  const ordered = [
    ...input.statuses.filter(status => status.id === input.selectedId),
    ...input.statuses.filter(status => status.id !== input.selectedId)
  ];
  const actions: MaintenanceAction<Id>[] = [];
  let retrySoonMs: number | null = null;
  for (const status of ordered) {
    const decision = decide(status, input);
    if (decision.kind === 'update') {
      actions.push({ id: status.id, kind: 'update', reason: decision.reason });
    } else {
      actions.push({ id: status.id, kind: 'skip', reason: decision.reason });
      retrySoonMs = earliestRetry(retrySoonMs, decision.retryMs);
    }
  }
  return { actions, retrySoonMs };
}

/** Records a failed attempt; the version waits 30 min, then 2 h, then 6 h. */
export function recordMaintenanceFailure(
  memo: MaintenanceFailureMemo,
  key: string,
  now: number
): MaintenanceFailure {
  const failures = (memo.get(key)?.failures ?? 0) + 1;
  const steps = CONNECTOR_MAINTENANCE_BACKOFF_MS.length;
  const failure = {
    failures,
    nextAttemptAt: now + CONNECTOR_MAINTENANCE_BACKOFF_MS[Math.min(failures, steps) - 1]
  };
  memo.set(key, failure);
  return failure;
}

export function recordMaintenanceSuccess(
  memo: MaintenanceFailureMemo,
  key: string
): void {
  memo.delete(key);
}

/** '30 分钟' or '2 小时', for log lines about the next attempt. */
export function describeMaintenanceDelay(delayMs: number): string {
  const minutes = Math.max(1, Math.round(delayMs / 60_000));
  return minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`;
}

/** The status fields that a skip log line mentions. */
export interface MaintenanceLogStatus extends MaintenanceConnectorStatus {
  name: string;
  minimumCoreVersion: string | null;
  manualUpdateAvailable: boolean;
  supportedPlayerVersion: string | null;
}

/**
 * The log line for a skipped connector, without the `[连接器热更新]` tag, or
 * null when the skip needs none: up-to-date, already updating, unused and
 * backed-off connectors stay quiet.
 */
export function describeMaintenanceSkip(
  status: MaintenanceLogStatus,
  reason: MaintenanceSkipReason
): { message: string; color: string } | null {
  switch (reason) {
    case 'error':
      return { message: `${status.name}检查失败：${status.error}`, color: 'Yellow' };
    case 'incompatible':
      return {
        message: `${status.name}最新版本要求本体 ${status.minimumCoreVersion}`,
        color: 'Yellow'
      };
    case 'manual-only':
      return status.manualUpdateAvailable
        ? {
          message: `${status.name} 有新的播放器版本分支 `
            + `${status.latestVersion}，支持播放器版本 `
            + `${status.supportedPlayerVersion || '未注明'}；`
            + '不会自动更新，可在播放器设置中手动确认。',
          color: 'Yellow'
        }
        : {
          message: `${status.name} 有不可自动应用的更新 `
            + `${status.latestVersion}，已保留当前版本。`,
          color: 'DarkGray'
        };
    case 'quarantined':
      return {
        message: `${status.name}连接器 ${status.latestVersion} 已在本机回退，`
          + '暂停自动更新；如需安装，请在播放器设置中手动更新。',
        color: 'DarkGray'
      };
    case 'netease-running':
      return {
        message: `${status.name}连接器有更新 ${status.latestVersion}；`
          + '网易云正在运行，连接器更新将在网易云关闭后或下次启动时应用',
        color: 'DarkGray'
      };
    case 'selected-busy':
      return {
        message: `${status.name}连接器有更新 ${status.latestVersion}；`
          + '正在播放点歌，将在点歌空闲后应用',
        color: 'DarkGray'
      };
    case 'guard-busy':
      return {
        message: `另一项更新正在进行，${status.name}连接器将在下次检查时更新`,
        color: 'DarkGray'
      };
    default:
      return null;
  }
}
