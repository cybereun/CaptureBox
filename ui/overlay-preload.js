'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  onInit: (cb) => ipcRenderer.on('overlay:init', (_e, p) => cb(p)),
  done: (rect) => ipcRenderer.send('overlay:done', rect),
  cancel: () => ipcRenderer.send('overlay:cancel'),
});
