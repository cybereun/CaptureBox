'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pin', {
  onInit: (cb) => ipcRenderer.on('pin:init', (_e, url) => cb(url)),
  begin: () => ipcRenderer.send('pin:begin'),
  drag: () => ipcRenderer.send('pin:drag'),
  zoom: (dir) => ipcRenderer.send('pin:zoom', dir),
  opacity: (dir) => ipcRenderer.send('pin:opacity', dir),
  close: () => ipcRenderer.send('pin:close'),
});
