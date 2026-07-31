import { ipcRenderer, contextBridge } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  openAdmin: () => ipcRenderer.send('open-admin'),
  closeWindow: () => ipcRenderer.send('close-window'),
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  resizeOverlay: (width: number, height: number) =>
    ipcRenderer.send('overlay-resize', width, height)
})
