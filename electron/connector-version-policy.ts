export type ConnectorUpdateKind =
  | 'none'
  | 'install'
  | 'patch'
  | 'player'
  | 'major';

interface ConnectorVersion {
  parts: number[];
}

function parseConnectorVersion(value: string | null): ConnectorVersion | null {
  if (!value) return null;
  const normalized = value.trim();
  if (!/^\d+(?:\.\d+){2,4}$/.test(normalized)) return null;
  const parts = normalized.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? { parts } : null;
}

function compareParts(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

export function classifyConnectorUpdate(
  currentVersion: string | null,
  latestVersion: string | null,
  connectorId?: string
): ConnectorUpdateKind {
  const latest = parseConnectorVersion(latestVersion);
  if (!latest) return 'none';
  const current = parseConnectorVersion(currentVersion);
  if (!current) return currentVersion ? 'none' : 'install';

  const qqPlayerScoped = connectorId === 'qqmusic'
    && latest.parts.length === 3
    && latest.parts[0] >= 10;
  const playerScoped = latest.parts.length >= 4 || qqPlayerScoped;
  if (playerScoped) {
    const currentIsLegacy = current.parts[0] === 1
      && (
        current.parts.length === 3
        || current.parts.length !== latest.parts.length
      );
    if (currentIsLegacy) return 'patch';
    if (current.parts.length !== latest.parts.length) return 'none';
    const branchOrder = compareParts(
      latest.parts.slice(0, -1),
      current.parts.slice(0, -1)
    );
    if (branchOrder < 0) return 'none';
    if (branchOrder > 0) return 'player';
    return latest.parts[latest.parts.length - 1]
      > current.parts[current.parts.length - 1]
      ? 'patch'
      : 'none';
  }

  if (current.parts.length !== 3) return 'none';
  const [latestMajor, latestPlayer, latestPatch] = latest.parts;
  const [currentMajor, currentPlayer, currentPatch] = current.parts;
  if (latestMajor < currentMajor) return 'none';
  if (latestMajor > currentMajor) return 'major';
  if (latestPlayer < currentPlayer) return 'none';
  if (latestPlayer > currentPlayer) return 'player';
  return latestPatch > currentPatch ? 'patch' : 'none';
}

export function canAutoUpdateConnector(
  currentVersion: string | null,
  latestVersion: string | null,
  connectorId?: string
): boolean {
  const kind = classifyConnectorUpdate(
    currentVersion,
    latestVersion,
    connectorId
  );
  return kind === 'install' || kind === 'patch';
}

export function requiresManualConnectorUpdate(
  currentVersion: string | null,
  latestVersion: string | null,
  connectorId?: string
): boolean {
  const kind = classifyConnectorUpdate(
    currentVersion,
    latestVersion,
    connectorId
  );
  return kind === 'player' || kind === 'major';
}
