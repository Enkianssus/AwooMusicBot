// preload.ts
// 当前配置使用 nodeIntegration: true + contextIsolation: false，
// 所以渲染进程可以直接 require('electron').ipcRenderer，不需要 preload 桥接。
// 此文件保留备用，如果未来切换到 contextIsolation: true 可以启用。

import { ipcRenderer, contextBridge } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  openAdmin: () => ipcRenderer.send('open-admin'),
  closeWindow: () => ipcRenderer.send('close-window'),

  on(...args: Parameters<typeof ipcRenderer.on>) {
    const [channel, listener] = args
    return ipcRenderer.on(channel, (event, ...args) => listener(event, ...args))
  },
  off(...args: Parameters<typeof ipcRenderer.off>) {
    const [channel, ...omit] = args
    return ipcRenderer.off(channel, ...omit)
  },
  send(...args: Parameters<typeof ipcRenderer.send>) {
    const [channel, ...omit] = args
    return ipcRenderer.send(channel, ...omit)
  },
  invoke(...args: Parameters<typeof ipcRenderer.invoke>) {
    const [channel, ...omit] = args
    return ipcRenderer.invoke(channel, ...omit)
  },
})