const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSellers: () => ipcRenderer.invoke('get-sellers'),
  addSeller: (seller) => ipcRenderer.invoke('add-seller', seller),
  removeSeller: (seller) => ipcRenderer.invoke('remove-seller', seller),
  clearSeenItems: () => ipcRenderer.invoke('clear-seen-items'),
  getScanInterval: () => ipcRenderer.invoke('get-scan-interval'),
  setScanInterval: (sec) => ipcRenderer.invoke('set-scan-interval', sec)
});

