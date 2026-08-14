'use strict';

/**
 * DeepSeek Harness 桌面版配置：默认值 + launcher-config.json 覆盖。
 * 数据根目录可移植：本机用 D:\deepseek，其他机器自动回退本地应用数据目录。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_ROOT = 'D:\\deepseek';

/**
 * 应用根目录解析（优先级从高到低）：
 *   1. 环境变量 DSH_LAUNCHER_ROOT（测试/多实例）
 *   2. D:\deepseek 已存在（本机开发部署）
 *   3. 其他机器回退到 %LOCALAPPDATA%\DeepSeekHarness（开箱即用，不依赖 D 盘）
 */
function resolveRoot() {
  if (process.env.DSH_LAUNCHER_ROOT) return process.env.DSH_LAUNCHER_ROOT;
  if (fs.existsSync(DEFAULT_ROOT)) return DEFAULT_ROOT;
  const localBase = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localBase, 'DeepSeekHarness');
}

/** 默认配置（deep-merged 到用户配置之上）。 */
function defaultConfig(root) {
  return {
    version: 1,
    host: '127.0.0.1',
    port: 0,                    // 0 = 自动挑选空闲端口
    home: path.join(root, 'home'),          // 桌面版 DSH_HOME（迁移目标）
    workDir: root,                          // dsh web 子进程 cwd（新会话的工作目录）
    forkRoot: path.join(root, 'deepseek-harness'), // fork 后端位置
    backend: 'auto',            // auto | fork | npm
    autoStart: true,            // 启动应用即启动后端
    closeToTray: true,          // 关闭窗口最小化到托盘
    bootTimeoutMs: 180000,
    maxQuickRestarts: 3,
    restartCooldownMs: 10000,
    sourceHomes: [],            // 迁移源（空 = 自动探测 ~/.dsh）
    openDevTools: false
  };
}

/** 简单深合并：仅一层配置，无需递归。 */
function mergeConfig(base, override) {
  const out = { ...base };
  if (override && typeof override === 'object') {
    for (const [key, value] of Object.entries(override)) {
      out[key] = value;
    }
  }
  return out;
}

let cached = null;

/** 读取（并缓存）完整配置；缺文件时把默认配置落盘。 */
function loadConfig() {
  if (cached) return cached;
  const root = resolveRoot();
  const configPath = path.join(root, 'launcher-config.json');
  const defaults = defaultConfig(root);
  let user = {};
  if (fs.existsSync(configPath)) {
    try {
      user = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
      // 配置文件损坏：备份后重建，不让启动失败
      try {
        fs.copyFileSync(configPath, `${configPath}.broken-${Date.now()}`);
      } catch { /* 忽略备份失败 */ }
      user = {};
    }
  }
  const merged = mergeConfig(defaults, user);
  try {
    fs.mkdirSync(root, { recursive: true });
    if (!fs.existsSync(configPath)) {
      fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf8');
    }
  } catch { /* 配置写不进去不影响运行 */ }
  cached = { root, configPath, values: merged };
  return cached;
}

/** 运行时路径集合。 */
function appPaths() {
  const { root, configPath, values } = loadConfig();
  return {
    root,
    configPath,
    home: values.home,
    workDir: values.workDir,
    forkRoot: values.forkRoot,
    logs: path.join(root, 'logs'),
    userData: path.join(root, 'app-data'),
    serverLog: path.join(root, 'logs', 'dsh-server.log'),
    launcherLog: path.join(root, 'logs', 'launcher.log'),
    migrationManifest: path.join(values.home, '.launcher-migration.json')
  };
}

module.exports = { loadConfig, appPaths, resolveRoot };
