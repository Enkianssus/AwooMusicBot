export interface ConnectorPlayerLifecycleResult {
  neteasePlayerWasRunning?: boolean;
  neteasePlayerRestarted?: boolean;
}

export function shouldWaitForConnectorPlayer(
  connectorId: string,
  result: ConnectorPlayerLifecycleResult
): boolean {
  if (connectorId !== 'netease') return true;
  return result.neteasePlayerWasRunning !== false
    && result.neteasePlayerRestarted !== false;
}

export function buildNeteaseConnectorSuccessMessage(
  action: 'update' | 'reinstall',
  result: ConnectorPlayerLifecycleResult
): string {
  const actionLabel = action === 'update' ? '已更新' : '已重新安装';
  if (result.neteasePlayerRestarted === false) {
    return `✅ 网易云连接器${actionLabel}；自动启动失败，请手动打开网易云。`;
  }
  if (result.neteasePlayerWasRunning === false) {
    return `✅ 网易云连接器${actionLabel}；网易云未启动，打开后会自动连接。`;
  }
  return `✅ 网易云连接器${actionLabel}；播放器正在启动，后台会自动连接。`;
}
