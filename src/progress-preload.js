const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('progressApi', {
  onUpdate: callback => ipcRenderer.on('progress:update', (_, items) => callback(items)),
  act: (ids, action) => ipcRenderer.invoke('dl:act', ids, action),
  configure: options => ipcRenderer.invoke('progress:configure', options)
});
