'use strict';

/**
 * DeepSeek Harness 桌面版 —— Electron 主进程。
 *
 * 与一般 dsh 桌面壳的差异：本应用有一个首页（迁移工作台），
 * 用户从这里把网页版实例（~/.dsh）的会话迁移到桌面版，再一键启动后端
 * 并进入 DeepSeek Harness 界面。后端崩了自动重启；关窗最小化到托盘。
 */

const { app, BrowserWindow, Menu, Tray, shell, nativeImage, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { ipcMain } = require('electron');
const { loadConfig, appPaths } = require('./config');
const { resolveBackend } = require('./backend');
const { DshServer } = require('./server');
const migrate = require('./migrate');

let mainWindow = null;
let tray = null;
let server = null;
let quitting = false;
let appUrl = null; // http://127.0.0.1:PORT/

const HOST = '127.0.0.1';

// userData 固定在 D:\deepseek\app-data（须在单实例锁之前设置）
try {
  app.setPath('userData', appPaths().userData);
} catch { /* 根目录暂不可用时退回默认 userData */ }

// ---------------------------------------------------------------------------
// 日志
// ---------------------------------------------------------------------------

function logLine(line) {
  const { launcherLog } = appPaths();
  try {
    fs.mkdirSync(path.dirname(launcherLog), { recursive: true });
    fs.appendFileSync(launcherLog, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch { /* 忽略 */ }
}

// ---------------------------------------------------------------------------
// 窗口
// ---------------------------------------------------------------------------

function createWindow() {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 940,
    minHeight: 640,
    title: 'DeepSeek Harness',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    backgroundColor: '#0b0f17',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => win.show());

  // 关闭窗口 → 托盘（配置可关）
  win.on('close', (event) => {
    const { values } = loadConfig();
    if (!quitting && values.closeToTray) {
      event.preventDefault();
      win.hide();
    }
  });

  // 外部链接交给系统浏览器；后端地址留在窗口内
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrustedUrl(url)) return { action: 'allow' };
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isTrustedUrl(url) || url.startsWith('file://')) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  win.on('closed', () => {
    mainWindow = null;
  });
  return win;
}

function isTrustedUrl(url) {
  return appUrl !== null && url.startsWith(appUrl);
}

function showMainWindow(page = 'welcome') {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow();
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (page === 'welcome') {
    mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'welcome.html'));
  }
}

function openAppUi() {
  if (!appUrl) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow();
  }
  mainWindow.loadURL(appUrl);
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
}

// ---------------------------------------------------------------------------
// 托盘
// ---------------------------------------------------------------------------

function createTray() {
  try {
    const iconPath = path.join(__dirname, '..', 'assets', 'tray.png');
    let image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) {
      const big = path.join(__dirname, '..', 'assets', 'icon.png');
      image = nativeImage.createFromPath(big).resize({ width: 16, height: 16 });
    }
    tray = new Tray(image);
    tray.setToolTip('DeepSeek Harness —— 桌面版正在后台运行');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 DeepSeek Harness', click: () => openAppUi() },
      { label: '同步网页版数据', click: () => showMainWindow('welcome') },
      { type: 'separator' },
      { label: '重启后端服务', click: () => restartServer().catch(() => {}) },
      { label: '打开数据目录', click: () => shell.openPath(appPaths().home) },
      { label: '打开日志目录', click: () => shell.openPath(appPaths().logs) },
      { type: 'separator' },
      { label: '退出', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('double-click', () => showMainWindow('welcome'));
  } catch (err) {
    logLine(`托盘创建失败：${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// IPC：迁移 + 服务控制 + 路径
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('scan:sources', async () => {
    const sources = migrate.defaultSourceHomes();
    return sources.map((p) => migrate.scanSource(p));
  });

  ipcMain.handle('migrate:run', async (_event, options) => {
    // 迁移会改写 storages（工作区/标题缓存），先停后端再迁、迁完重启，
    // 避免运行中的后端用内存状态覆盖合并结果。
    const wasRunning = server && (server.state === 'running' || server.state === 'starting');
    if (wasRunning) server.stop();
    let report;
    try {
      report = await migrate.runMigration(options || {}, (progress) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('migrate:progress', progress);
        }
      });
    } finally {
      if (wasRunning) {
        try {
          const port = await server.start();
          appUrl = `http://${HOST}:${port}/`;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('server:state', { state: 'running', port });
          }
        } catch (err) {
          logLine(`迁移后重启后端失败：${err.message}`);
        }
      }
    }
    return report;
  });

  ipcMain.handle('migrate:manifest', () => migrate.lastMigrationManifest());

  ipcMain.handle('server:start', async () => {
    const port = await server.start();
    appUrl = `http://${HOST}:${port}/`;
    return { port, url: appUrl, state: server.state, backend: server.backend };
  });

  ipcMain.handle('server:restart', () => restartServer());

  ipcMain.handle('server:stop', () => {
    server.stop();
    appUrl = null;
    return { state: server.state };
  });

  ipcMain.handle('server:state', () => ({
    state: server.state,
    port: server.port,
    backend: server.backend && { kind: server.backend.kind, bin: server.backend.bin, reason: server.backend.reason },
    error: server.lastError
  }));

  ipcMain.handle('window:openApp', async () => {
    if (!server || server.state !== 'running') {
      const port = await server.start();
      appUrl = `http://${HOST}:${port}/`;
    }
    openAppUi();
    return true;
  });

  ipcMain.handle('window:minimize', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
    return true;
  });

  ipcMain.handle('app:config', () => {
    const { values } = loadConfig();
    const backend = resolveBackend(app.isPackaged);
    return {
      values,
      paths: appPaths(),
      backend: { kind: backend.kind, bin: backend.bin, reason: backend.reason, node: backend.node, forkBuilt: backend.forkBuilt },
      manifest: migrate.lastMigrationManifest()
    };
  });

  ipcMain.handle('app:openPath', async (_event, p) => {
    const err = await shell.openPath(p);
    return { ok: err === '', error: err };
  });
}

async function restartServer() {
  const port = await server.restart();
  appUrl = `http://${HOST}:${port}/`;
  return { port, url: appUrl, state: server.state };
}

// ---------------------------------------------------------------------------
// 调试钩子（仅环境变量开启，正常使用无开销）
//   DSH_LAUNCHER_SCREENSHOT=<png 路径>     首页截图
//   DSH_LAUNCHER_SCREENSHOT_APP=<png 路径> 打开 DeepSeek Harness 界面后截图
//   DSH_LAUNCHER_AUTO_OPEN=1               后端就绪后自动加载界面
// ---------------------------------------------------------------------------

function debugCaptureWebContents(contents, target, delayMs = 2500) {
  setTimeout(async () => {
    try {
      const img = await contents.capturePage();
      fs.writeFileSync(target, img.toPNG());
      logLine(`截图已保存：${target}`);
    } catch (err) {
      logLine(`截图失败：${err.message}`);
    }
  }, delayMs);
}

function setupDebugHooks() {
  if (!process.env.DSH_LAUNCHER_SCREENSHOT && !process.env.DSH_LAUNCHER_SCREENSHOT_APP) return;
  mainWindow.webContents.on('did-finish-load', () => {
    const url = mainWindow.webContents.getURL();
    if (url.startsWith('file://') && process.env.DSH_LAUNCHER_SCREENSHOT) {
      debugCaptureWebContents(mainWindow.webContents, process.env.DSH_LAUNCHER_SCREENSHOT);
    }
    if (url.startsWith('http://') && process.env.DSH_LAUNCHER_SCREENSHOT_APP) {
      debugCaptureWebContents(mainWindow.webContents, process.env.DSH_LAUNCHER_SCREENSHOT_APP, 9000);
    }
  });
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow('welcome'));

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.deepseek.harness.desktop');
    const { values } = loadConfig();
    logLine('==== DeepSeek Harness 桌面版 启动 ====');

    server = new DshServer({
      isPackaged: app.isPackaged,
      onState: (state) => {
        logLine(`后端状态：${state.state}${state.port ? ` port=${state.port}` : ''}${state.error ? ` (${state.error})` : ''}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('server:state', state);
        }
      }
    });

    registerIpc();
    mainWindow = createWindow();
    createTray();
    setupDebugHooks();

    // 首次配置：没有迁移记录且检测到网页版源 → 进迁移向导；
    // 之后启动：跳过向导，直接进入 DeepSeek Harness 界面。
    const manifest = migrate.lastMigrationManifest();
    const sourceCount = migrate.defaultSourceHomes().length;
    const firstRun = !manifest && sourceCount > 0;

    if (firstRun || !values.autoStart) {
      await mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'welcome.html'));
    } else {
      await mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'loading.html'));
    }

    if (values.openDevTools) mainWindow.webContents.openDevTools({ mode: 'detach' });

    if (values.autoStart) {
      server.start()
        .then((port) => {
          appUrl = `http://${HOST}:${port}/`;
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('server:state', { state: 'running', port });
          }
          // 首次配置留在向导页（测试可用 DSH_LAUNCHER_AUTO_OPEN=1 强制进入界面）
          if (!firstRun || process.env.DSH_LAUNCHER_AUTO_OPEN === '1') {
            openAppUi();
          }
        })
        .catch((err) => {
          logLine(`自动启动后端失败：${err.message}`);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('server:state', { state: 'crashed', error: err.message });
            if (!firstRun) {
              // 已迁移用户：后端起不来时回落到首页展示错误与重试按钮
              mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'welcome.html'));
            }
          }
        });
    }
  });

  app.on('before-quit', () => {
    quitting = true;
    if (server) server.stop();
  });

  app.on('window-all-closed', () => {
    // 关闭窗口只隐藏到托盘，应用保持后台运行
  });

  app.on('activate', () => showMainWindow('welcome'));
}
