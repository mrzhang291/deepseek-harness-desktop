'use strict';

/**
 * 后端解析：决定用哪个 dsh bin.js 和哪个 Node 运行时。
 *  - fork: D:\deepseek\deepseek-harness\apps\cli\lib\bin.js（用户自己的 fork 构建产物）
 *  - npm : launcher 自带 node_modules 里的 @deepseek-ai/dsh
 *  - auto: fork 已构建则优先 fork，否则 npm 兜底
 * Node 运行时优先用独立 node.exe（Electron 内嵌 node 跑原生 FFI 插件会崩溃）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('./config');

function forkBinPath(forkRoot) {
  return path.join(forkRoot, 'apps', 'cli', 'lib', 'bin.js');
}

function npmBinPath() {
  try {
    return require.resolve('@deepseek-ai/dsh/lib/bin.js');
  } catch {
    return path.join(__dirname, '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  }
}

/** 打包后用自带 node.exe，开发模式用系统 node（可用 DSH_LAUNCHER_NODE 覆盖）。 */
function nodeRuntimePath(isPackaged) {
  if (isPackaged) {
    const name = process.platform === 'win32' ? 'node.exe' : 'node';
    const bundled = path.join(process.resourcesPath, 'node', name);
    if (fs.existsSync(bundled)) return bundled;
  }
  return process.env.DSH_LAUNCHER_NODE || 'node';
}

/**
 * 解析最终后端。返回 { kind, bin, node, label, exists, reason }。
 * 请求的 kind 不可用时自动降级并给出 reason。
 */
function resolveBackend(isPackaged = false) {
  const { values } = loadConfig();
  const forkBin = forkBinPath(values.forkRoot);
  const forkBuilt = fs.existsSync(forkBin);
  const npmBin = npmBinPath();
  const npmAvailable = fs.existsSync(npmBin);

  const wanted = values.backend || 'auto';
  let kind = wanted;
  let reason = '';

  if (wanted === 'fork' && !forkBuilt) {
    kind = npmAvailable ? 'npm' : 'fork';
    reason = 'fork 未构建（apps/cli/lib/bin.js 不存在），降级到 npm 包';
  } else if (wanted === 'npm' && !npmAvailable) {
    kind = forkBuilt ? 'fork' : 'npm';
    reason = 'npm 包不可用，改用 fork';
  } else if (wanted === 'auto') {
    kind = forkBuilt ? 'fork' : 'npm';
    if (!forkBuilt) reason = 'fork 未构建，使用 npm 包（@deepseek-ai/dsh）';
  }

  const bin = kind === 'fork' ? forkBin : npmBin;
  return {
    kind,
    bin,
    exists: fs.existsSync(bin),
    reason,
    node: nodeRuntimePath(isPackaged),
    forkBuilt,
    forkBin,
    npmBin
  };
}

module.exports = { resolveBackend, forkBinPath, npmBinPath };
