'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('snap', {
  listAssets: () => ipcRenderer.invoke('assets:list'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (p) => ipcRenderer.invoke('settings:set', p),
  capture: (mode, delay) => ipcRenderer.invoke('capture:start', mode, delay),
  listWindows: () => ipcRenderer.invoke('windows:list'),
  captureWindow: (id) => ipcRenderer.invoke('capture:window', id),
  rename: (id, name) => ipcRenderer.invoke('asset:rename', id, name),
  remove: (id) => ipcRenderer.invoke('asset:delete', id),
  copy: (id) => ipcRenderer.invoke('asset:copy', id),
  save: (id) => ipcRenderer.invoke('asset:save', id),
  getImageData: (id) => ipcRenderer.invoke('asset:dataUrl', id),
  addEdited: (baseId, dataUrl) => ipcRenderer.invoke('asset:addEdited', baseId, dataUrl),
  getUpdate: () => ipcRenderer.invoke('update:get'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdate: (cb) => ipcRenderer.on('update:status', (_e, u) => cb(u)),
  getStore: () => ipcRenderer.invoke('store:get'),
  chooseStore: () => ipcRenderer.invoke('store:choose'),
  resetStore: () => ipcRenderer.invoke('store:reset'),
  openStore: () => ipcRenderer.invoke('store:open'),
  reveal: (id) => ipcRenderer.invoke('asset:reveal', id),
  drag: (id) => ipcRenderer.send('asset:drag', id),
  onChanged: (cb) => ipcRenderer.on('assets:changed', (_e, p) => cb(p)),
});
