import { contextBridge, ipcRenderer } from "electron";

import { createPreloadApi } from "./preloadApi.js";

contextBridge.exposeInMainWorld("zli", createPreloadApi({
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  on: (channel, listener) => {
    const wrapped = (event: Electron.IpcRendererEvent, value: unknown) => listener(event, value);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
}));
