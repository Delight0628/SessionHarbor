// Preload as CJS so Electron can load it without ESM preload issues
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("harbor", {
  discover: () => ipcRenderer.invoke("harbor:discover"),
  list: (client, filter) => ipcRenderer.invoke("harbor:list", client, filter),
  read: (client, id) => ipcRenderer.invoke("harbor:read", client, id),
  exportHtml: (client, id) => ipcRenderer.invoke("harbor:exportHtml", client, id),
  exportMd: (client, id) => ipcRenderer.invoke("harbor:exportMd", client, id),
  scan: (client) => ipcRenderer.invoke("harbor:scan", client),
  search: (q, limit) => ipcRenderer.invoke("harbor:search", q, limit),
  migrate: (opts) => ipcRenderer.invoke("harbor:migrate", opts),
  watchStart: () => ipcRenderer.invoke("harbor:watchStart"),
  watchStop: () => ipcRenderer.invoke("harbor:watchStop"),
  sync: (opts) => ipcRenderer.invoke("harbor:sync", opts),
  onAutoScanDone: (cb) => {
    ipcRenderer.on("harbor:autoScanDone", (_e, payload) => {
      try {
        cb(payload);
      } catch {
        /* ignore */
      }
    });
  },
});
