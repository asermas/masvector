// Renderer'a yalnız dar, açık bir köprü: dışa aktarma diyalogu ve sunucu bilgisi.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('masvector', {
  isElectron: true,
  saveExport: (format, url, name) => ipcRenderer.invoke('save-export', format, url, name),
  serverInfo: () => ipcRenderer.invoke('server-info'),
});
