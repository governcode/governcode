// The preload: the renderer's whole view of the world is `window.governcode`, the narrow API
// below. It runs sandboxed, so it is bundled to one CommonJS file with no imports but
// Electron's.
import { contextBridge, ipcRenderer } from "electron";
import { Channel, type AskEvent, type DashboardApi, type Status } from "../shared/contract.ts";

const api: DashboardApi = {
  call: (method, params) => ipcRenderer.invoke(Channel.call, method, params ?? {}),
  ask: (askId, project, prompt) => ipcRenderer.invoke(Channel.ask, askId, project, prompt),
  status: () => ipcRenderer.invoke(Channel.status),
  retry: () => ipcRenderer.invoke(Channel.retry),
  onEvent: (listener) => {
    const f = (_e: unknown, askId: string, event: AskEvent) => listener(askId, event);
    ipcRenderer.on(Channel.event, f);
    return () => { ipcRenderer.removeListener(Channel.event, f); };
  },
  onStatus: (listener) => {
    const f = (_e: unknown, s: Status) => listener(s);
    ipcRenderer.on(Channel.statusChanged, f);
    return () => { ipcRenderer.removeListener(Channel.statusChanged, f); };
  },
};

contextBridge.exposeInMainWorld("governcode", api);
