// The only door between the screens and the rest of the computer: three functions, nothing else.
// CommonJS on purpose: a sandboxed preload script cannot be an ES module.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('audit', {
  call: (method: string, ...args: unknown[]) => ipcRenderer.invoke('engine', method, args),
  pickFolder: () => ipcRenderer.invoke('pickFolder'),
  startupPaths: () => ipcRenderer.invoke('startupPaths'),
});
