// Renderer'a yalnız dar, açık bir köprü: dışa aktarma diyalogu ve sunucu bilgisi.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('masvector', {
  isElectron: true,
  saveExport: (format, url) => ipcRenderer.invoke('save-export', format, url),
  serverInfo: () => ipcRenderer.invoke('server-info'),
});
