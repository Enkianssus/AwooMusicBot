import { ipcRenderer, contextBridge } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
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
