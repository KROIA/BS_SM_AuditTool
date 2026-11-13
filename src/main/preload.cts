// The only door between the screens and the rest of the computer: six functions, nothing else.
// CommonJS on purpose: a sandboxed preload script cannot be an ES module.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('audit', {
  call: (method: string, ...args: unknown[]) => ipcRenderer.invoke('engine', method, args),
  pickFolder: () => ipcRenderer.invoke('pickFolder'),
  // Builds the report, asks where to save it and writes it; the page never sees the file.
  exportReport: (incidentId: string, options: unknown, settings: unknown) => ipcRenderer.invoke('exportReport', incidentId, options, settings),
  startupPaths: () => ipcRenderer.invoke('startupPaths'),
  onProgress: (listener: (progress: unknown) => void) => void ipcRenderer.on('progress', (_e: unknown, progress: unknown) => listener(progress)),
  // The sandboxed page cannot see where a dropped folder lives; only this call can tell.
  pathOf: (file: File) => webUtils.getPathForFile(file),
});
