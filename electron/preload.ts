import { ipcRenderer, contextBridge } from 'electron'

let internalApiOrigin = '';
try {
  internalApiOrigin = String(ipcRenderer.sendSync('get-internal-api-origin') || '');
} catch {
  // 旧版主进程或非 Electron 预览环境没有这个 IPC 时，renderer 会使用当前 origin。
}

contextBridge.exposeInMainWorld('electronAPI', {
  internalApiOrigin,
  openAdmin: (tab?: string) => ipcRenderer.send('open-admin', tab),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  claimWelcomeHint: (legacyHintWasShown: boolean) =>
    ipcRenderer.invoke('claim-welcome-hint', legacyHintWasShown),
  onAdminNavigate: (callback: (tab: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, tab: unknown) =>
      callback(String(tab || ''))
    ipcRenderer.on('admin-navigate', listener)
    return () => ipcRenderer.removeListener('admin-navigate', listener)
  },
  closeWindow: () => ipcRenderer.send('close-window'),
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  resizeOverlay: (width: number, height: number) =>
    ipcRenderer.send('overlay-resize', width, height)
})
