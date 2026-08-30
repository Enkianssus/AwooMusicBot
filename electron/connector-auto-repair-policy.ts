import {
  classifyConnectorUpdate,
  type ConnectorUpdateKind
} from './connector-version-policy';

export type AutoRepairConnectorId =
  | 'netease'
  | 'kugou'
  | 'qqmusic'
  | 'folia';

export type ConnectorAutoRepairAction =
  | 'not-applicable'
  | 'player-not-running'
  | 'upgrade'
  | 'missing-connector'
  | 'failed';

export const CONNECTOR_AUTO_REPAIR_MESSAGES = {
  upgrading: '连接遇到问题，正在自动升级连接器尝试修复',
  failed: '连接遇到问题',
  missingConnector: '连接遇到问题，可能是缺少新版本连接器',
  playerNotRunning: '请先打开播放器'
} as const;

export interface ConnectorAutoRepairInput {
  connectorId: AutoRepairConnectorId;
  playerRunning: boolean;
  playerVersion?: string | null;
  connectorInstalled: boolean;
  connectorCurrentVersion?: string | null;
  connectorLatestVersion?: string | null;
  connectorSupportedPlayerVersion?: string | null;
  connectorPlayerVersionPolicy?: string | null;
  connectorTestedPlayerVersion?: string | null;
  connectorCompatible: boolean;
  connectorUpdateAvailable: boolean;
  connectorAutoUpdateAvailable: boolean;
  connectorManualUpdateAvailable: boolean;
  connectorUpdateKind?: ConnectorUpdateKind;
  connectorUpdating: boolean;
  catalogError?: string | null;
  attempted: boolean;
}

export interface ConnectorAutoRepairDecision {
  action: ConnectorAutoRepairAction;
  reason:
    | 'not-applicable'
    | 'player-not-running'
    | 'already-attempted'
    | 'catalog-error'
    | 'player-version-unknown'
    | 'player-version-not-supported'
    | 'no-compatible-update'
    | 'compatible-update';
  message: string;
  allowPlayerVersionChange: boolean;
}

function parseNumericVersion(value: unknown): number[] | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!/^\d+(?:\.\d+){1,5}$/.test(text)) return null;
  const parts = text.split('.').map(part => Number(part));
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function extractVersionTokens(value: unknown): string[] {
  const text = typeof value === 'string' ? value : '';
  // Keep a trailing wildcard (`22.*`, `3.1.*`) so branch matching can use
  // the catalog's actual compatibility boundary instead of only its tested
  // build number.
  return text.match(/\d+(?:\.\d+)*(?:\.\*)?/g) || [];
}

function getPlayerBranchLength(
  connectorId: AutoRepairConnectorId
): number | null {
  switch (connectorId) {
    case 'netease': return 4;
    case 'kugou': return 3;
    case 'qqmusic': return 2;
    default: return null;
  }
}

function compareParts(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function getPlayerBranch(
  connectorId: AutoRepairConnectorId,
  version: unknown
): number[] | null {
  const length = getPlayerBranchLength(connectorId);
  const parts = parseNumericVersion(version);
  if (!length || !parts || parts.length < length) return null;
  return parts.slice(0, length);
}

function concreteCatalogVersions(
  value: unknown
): number[][] {
  return extractVersionTokens(value)
    .map(token => parseNumericVersion(token))
    .filter((parts): parts is number[] => parts !== null);
}

/**
 * Catalogs use a wildcard player branch (for example `3.1.*`) and some of
 * the older entries use a slash-separated list of tested versions. Concrete
 * tested versions are compared by the connector-specific player branch, so a
 * four-part Windows file version can match a two-part QQ branch entry.
 */
export function playerVersionMatchesCatalog(
  connectorId: AutoRepairConnectorId,
  playerVersion: unknown,
  playerVersionPolicy: unknown,
  testedPlayerVersion: unknown,
  supportedPlayerVersion: unknown
): boolean {
  const branchLength = getPlayerBranchLength(connectorId);
  const actualBranch = getPlayerBranch(connectorId, playerVersion);
  if (!branchLength || !actualBranch) return false;

  // Exact tested builds are the security boundary. A broad `major.*` policy
  // is useful for display and ordinary compatibility hints, but cannot grant
  // an automatic cross-player-branch upgrade when no concrete build is
  // listed. This prevents a future 22.99 or 3.1.99 build from inheriting a
  // connector merely because it shares a major prefix.
  const concrete = [
    ...concreteCatalogVersions(testedPlayerVersion),
    ...concreteCatalogVersions(supportedPlayerVersion)
  ];
  if (concrete.length > 0) {
    return concrete.some(parts => (
      parts.length >= branchLength
      && compareParts(parts.slice(0, branchLength), actualBranch) === 0
    ));
  }

  // A policy without concrete tested builds is accepted only when it names an
  // exact branch (no wildcard). Even then the caller must separately prove
  // that the installed connector branch is older before upgrading.
  return extractVersionTokens(playerVersionPolicy).some(pattern => {
    if (pattern.includes('*')) return false;
    const parts = parseNumericVersion(pattern);
    return Boolean(
      parts
      && parts.length >= branchLength
      && compareParts(parts.slice(0, branchLength), actualBranch) === 0
    );
  });
}

export function playerBranchIsNewerThanConnector(
  connectorId: AutoRepairConnectorId,
  playerVersion: unknown,
  connectorVersion: unknown
): boolean {
  const playerBranch = getPlayerBranch(connectorId, playerVersion);
  const connectorBranch = getPlayerBranch(connectorId, connectorVersion);
  return Boolean(
    playerBranch
    && connectorBranch
    && compareParts(playerBranch, connectorBranch) > 0
  );
}

function decision(
  action: ConnectorAutoRepairAction,
  reason: ConnectorAutoRepairDecision['reason'],
  message: string,
  allowPlayerVersionChange = false
): ConnectorAutoRepairDecision {
  return { action, reason, message, allowPlayerVersionChange };
}

/**
 * Decide whether a failed connector connection may perform one repair update.
 *
 * This policy deliberately requires an independently detected player process
 * and a catalog entry that matches that process's file version. In particular,
 * `manualUpdateAvailable` is not sufficient on its own: blindly applying the
 * newest player-scoped connector could break users who still run an older
 * player branch.
 */
export function planConnectorAutoRepair(
  input: ConnectorAutoRepairInput
): ConnectorAutoRepairDecision {
  if (input.connectorId === 'folia') {
    return decision(
      'not-applicable',
      'not-applicable',
      CONNECTOR_AUTO_REPAIR_MESSAGES.failed
    );
  }

  if (!input.playerRunning) {
    return decision(
      'player-not-running',
      'player-not-running',
      CONNECTOR_AUTO_REPAIR_MESSAGES.playerNotRunning
    );
  }

  if (input.attempted) {
    return decision(
      'failed',
      'already-attempted',
      CONNECTOR_AUTO_REPAIR_MESSAGES.failed
    );
  }

  if (input.catalogError) {
    return decision(
      'failed',
      'catalog-error',
      CONNECTOR_AUTO_REPAIR_MESSAGES.failed
    );
  }

  if (!parseNumericVersion(input.playerVersion)) {
    return decision(
      'failed',
      'player-version-unknown',
      CONNECTOR_AUTO_REPAIR_MESSAGES.failed
    );
  }

  if (!playerVersionMatchesCatalog(
    input.connectorId,
    input.playerVersion,
    input.connectorPlayerVersionPolicy,
    input.connectorTestedPlayerVersion,
    input.connectorSupportedPlayerVersion
  )) {
    return decision(
      'missing-connector',
      'player-version-not-supported',
      CONNECTOR_AUTO_REPAIR_MESSAGES.missingConnector
    );
  }

  if (!input.connectorInstalled || !input.connectorCurrentVersion) {
    return decision(
      'failed',
      'no-compatible-update',
      CONNECTOR_AUTO_REPAIR_MESSAGES.failed
    );
  }

  // Do not turn a same-branch connector patch into a repair loop. Ordinary
  // same-player updates remain owned by the existing maintenance policy. An
  // automatic repair is reserved for a detected player branch newer than the
  // branch encoded by the installed connector.
  const newerPlayerBranch = playerBranchIsNewerThanConnector(
    input.connectorId,
    input.playerVersion,
    input.connectorCurrentVersion
  );
  if (!newerPlayerBranch) {
    return decision(
      'failed',
      'no-compatible-update',
      CONNECTOR_AUTO_REPAIR_MESSAGES.failed
    );
  }

  const updateKind = input.connectorUpdateKind
    || classifyConnectorUpdate(
      input.connectorCurrentVersion || null,
      input.connectorLatestVersion || null,
      input.connectorId
    );
  const hasHigherConnector = input.connectorUpdateAvailable
    && Boolean(input.connectorLatestVersion)
    && updateKind !== 'none';
  if (
    !input.connectorCompatible
    || input.connectorUpdating
    || !hasHigherConnector
    || (!input.connectorAutoUpdateAvailable
      && !input.connectorManualUpdateAvailable)
  ) {
    return decision(
      'failed',
      'no-compatible-update',
      CONNECTOR_AUTO_REPAIR_MESSAGES.failed
    );
  }

  return decision(
    'upgrade',
    'compatible-update',
    CONNECTOR_AUTO_REPAIR_MESSAGES.upgrading,
    newerPlayerBranch
  );
}
