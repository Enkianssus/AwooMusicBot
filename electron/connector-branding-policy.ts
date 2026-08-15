export type BrandedConnectorId =
  | 'netease'
  | 'kugou'
  | 'qqmusic'
  | 'folia';

export type ConnectorRuntimeRid = 'win-x86' | 'win-x64';

export const AWOO_CONNECTOR_EXECUTABLE_NAMES: Record<
  BrandedConnectorId,
  string
> = {
  netease: 'Awoo.Connector.Netease.exe',
  kugou: 'Awoo.Connector.Kugou.exe',
  qqmusic: 'Awoo.Connector.QQMusic.exe',
  folia: 'Awoo.Connector.Folia.exe'
};

const LEGACY_CONNECTOR_EXECUTABLE_NAMES: Record<
  BrandedConnectorId,
  string
> = {
  netease: 'BiliNCM.Connector.Netease.exe',
  kugou: 'BiliNCM.Connector.Kugou.exe',
  qqmusic: 'BiliNCM.Connector.QQMusic.exe',
  folia: 'BiliNCM.Connector.Folia.exe'
};

export function connectorExecutableNames(
  connectorId: BrandedConnectorId
): readonly string[] {
  return [
    AWOO_CONNECTOR_EXECUTABLE_NAMES[connectorId],
    LEGACY_CONNECTOR_EXECUTABLE_NAMES[connectorId]
  ];
}

export function connectorAssetNames(
  connectorId: BrandedConnectorId,
  version: string,
  runtime: ConnectorRuntimeRid,
  frameworkDependent = false
): readonly string[] {
  const suffix = frameworkDependent ? '-framework-dependent.zip' : '.zip';
  return [
    `awoo-connector-${connectorId}-${version}-${runtime}${suffix}`,
    `bilincm-connector-${connectorId}-${version}-${runtime}${suffix}`
  ];
}

export function isRecognizedConnectorAssetName(
  asset: unknown,
  connectorId: BrandedConnectorId,
  version: string,
  runtime: ConnectorRuntimeRid,
  frameworkDependent = false
): boolean {
  return connectorAssetNames(
    connectorId,
    version,
    runtime,
    frameworkDependent
  ).includes(String(asset || ''));
}

export function qqMusicProfileAssetNames(
  version: string
): readonly string[] {
  return [
    `awoo-qqmusic-profiles-${version}.zip`,
    `bilincm-qqmusic-profiles-${version}.zip`
  ];
}

export function isRecognizedQQMusicProfileAssetName(
  asset: unknown,
  version: string
): boolean {
  return qqMusicProfileAssetNames(version).includes(String(asset || ''));
}
