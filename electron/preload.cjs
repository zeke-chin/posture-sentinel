const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("postureDesktop", {
  baselines: {
    list: () => ipcRenderer.invoke("baselines:list"),
    create: (name, baseline) => ipcRenderer.invoke("baselines:create", name, baseline),
    select: (id) => ipcRenderer.invoke("baselines:select", id),
    rename: (id, name) => ipcRenderer.invoke("baselines:rename", id, name),
    remove: (id) => ipcRenderer.invoke("baselines:delete", id),
  },
  monitoring: {
    keepsRunningWhenHidden: true,
    setActive: (active) => ipcRenderer.send("monitoring:set-active", active),
    navigate: (path) => ipcRenderer.invoke("monitoring:navigate", path),
    syncRoute: (path) => ipcRenderer.send("monitoring:sync-route", path),
  },
});
