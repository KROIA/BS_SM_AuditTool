// The only door between the screens and the rest of the computer: five functions, nothing else.
// CommonJS on purpose: a sandboxed preload script cannot be an ES module.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('audit', {
  call: (method: string, ...args: unknown[]) => ipcRenderer.invoke('engine', method, args),
  pickFolder: () => ipcRenderer.invoke('pickFolder'),
  startupPaths: () => ipcRenderer.invoke('startupPaths'),
  onProgress: (listener: (progress: unknown) => void) => void ipcRenderer.on('progress', (_e: unknown, progress: unknown) => listener(progress)),
  // The sandboxed page cannot see where a dropped folder lives; only this call can tell.
  pathOf: (file: File) => webUtils.getPathForFile(file),
});
