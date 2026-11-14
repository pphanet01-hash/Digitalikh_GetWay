const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('keygenAPI', {
  getInit: () => ipcRenderer.invoke('keygen-get-init'),
  generateKeys: (opts) => ipcRenderer.invoke('keygen-generate', opts),
  verifyKey: (key) => ipcRenderer.invoke('keygen-verify', key),
  activateLocal: (key) => ipcRenderer.invoke('keygen-activate-local', key),
  deactivateLocal: () => ipcRenderer.invoke('keygen-deactivate-local'),
  deleteHistory: (id) => ipcRenderer.invoke('keygen-delete-history', id),
  copyText: (text) => ipcRenderer.invoke('keygen-copy', text),
  minimizeWindow: () => ipcRenderer.invoke('keygen-minimize'),
  maximizeWindow: () => ipcRenderer.invoke('keygen-maximize'),
  closeWindow: () => ipcRenderer.invoke('keygen-close')
});
