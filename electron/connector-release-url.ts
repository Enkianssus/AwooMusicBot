export const CONNECTOR_GITHUB_REPOSITORY =
  'Enkianssus/awoo-connectors';

export function buildConnectorGitHubReleaseUrl(
  connectorId: string,
  version: string,
  asset: string
): string {
  const tag = `${connectorId}-v${version}`;
  return `https://github.com/${CONNECTOR_GITHUB_REPOSITORY}/releases/download/`
    + `${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`;
}
