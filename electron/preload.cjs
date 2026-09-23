const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("postureDesktop", {
  baselines: {
    list: () => ipcRenderer.invoke("baselines:list"),
    create: (name, baseline) => ipcRenderer.invoke("baselines:create", name, baseline),
    select: (id) => ipcRenderer.invoke("baselines:select", id),
    rename: (id, name) => ipcRenderer.invoke("baselines:rename", id, name),
    remove: (id) => ipcRenderer.invoke("baselines:delete", id),
  },
});
