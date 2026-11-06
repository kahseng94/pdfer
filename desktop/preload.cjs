const { contextBridge, ipcRenderer } = require('electron')

function subscribe(channel, callback) {
  const listener = (_event, value) => callback(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('pdferDesktop', {
  getUpdateState: () => ipcRenderer.invoke('updates:state'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  onUpdateState: (callback) => subscribe('updates:changed', callback),
  getOcrSetupState: () => ipcRenderer.invoke('ocr:state'),
  installOcr: () => ipcRenderer.invoke('ocr:install'),
  onOcrSetupState: (callback) => subscribe('ocr:changed', callback),
})
