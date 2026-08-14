'use strict';

/**
 * preload：向渲染进程暴露最小化 IPC 接口（contextIsolation + sandbox 安全模型）。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  scanSources: () => ipcRenderer.invoke('scan:sources'),
  runMigration: (options) => ipcRenderer.invoke('migrate:run', options),
  migrationManifest: () => ipcRenderer.invoke('migrate:manifest'),
  startServer: () => ipcRenderer.invoke('server:start'),
  restartServer: () => ipcRenderer.invoke('server:restart'),
  stopServer: () => ipcRenderer.invoke('server:stop'),
  serverState: () => ipcRenderer.invoke('server:state'),
  getConfig: () => ipcRenderer.invoke('app:config'),
  openPath: (p) => ipcRenderer.invoke('app:openPath', p),
  openApp: () => ipcRenderer.invoke('window:openApp'),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  onServerState: (cb) => {
    ipcRenderer.on('server:state', (_event, state) => cb(state));
  },
  onMigrateProgress: (cb) => {
    ipcRenderer.on('migrate:progress', (_event, progress) => cb(progress));
  }
});
