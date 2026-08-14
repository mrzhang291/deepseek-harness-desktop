'use strict';

/**
 * 修复桌面版 workspace.json（一次性/手动工具）：
 * 把源(网页版)工作区与桌面版工作区按 path 并集合并，并把
 * home\sessions\<projectKey> 下实际存在的会话目录全部并入，
 * 恢复被运行中实例覆盖/冲掉的侧栏条目。运行前请先停止后端。
 *   node scripts/repair-workspace.js
 */

const fs = require('node:fs');
const path = require('node:path');

const HOME = process.env.DSH_REPAIR_HOME || 'D:\\deepseek\\home';
const SRC = process.env.DSH_REPAIR_SRC || 'C:\\Users\\zcj00\\.dsh';

/** 与 dsh 的 projectKey 相同的编码（有损人类可读约定）。 */
function projectKey(cwd) {
  if (!cwd) return '_no-cwd';
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root';
  return `--${slug.slice(0, 251)}--`;
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function sessionDirsOnDisk(key) {
  const dir = path.join(HOME, 'sessions', key);
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.includes('.premig') && !e.name.startsWith('.'))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function main() {
  const src = readJson(path.join(SRC, 'storages', 'workspace.json'));
  const dest = readJson(path.join(HOME, 'storages', 'workspace.json'));
  if (!src && !dest) {
    console.log('源与目标都没有 workspace.json，无需修复');
    return;
  }
  const srcWs = src?.tables?.workspaces ?? {};
  const destWs = dest?.tables?.workspaces ?? {};

  // 1) 按 path 并集合并源条目
  const byPath = new Map();
  for (const [id, ws] of Object.entries(destWs)) byPath.set((ws.path || '').toLowerCase(), { id, ws });
  for (const [srcId, ws] of Object.entries(srcWs)) {
    const hit = byPath.get((ws.path || '').toLowerCase());
    if (hit) {
      const union = [...(ws.sessionIds || [])];
      for (const id of (hit.ws.sessionIds || [])) if (!union.includes(id)) union.push(id);
      destWs[hit.id] = { ...ws, sessionIds: union };
      if (hit.id !== srcId) delete destWs[srcId];
    } else {
      destWs[srcId] = ws;
    }
  }

  // 2) 磁盘扫描补全：每个工作区 projectKey 下实际存在的会话目录
  let diskAdded = 0;
  for (const [id, ws] of Object.entries(destWs)) {
    if (!ws.path) continue;
    const union = [...(ws.sessionIds || [])];
    for (const d of sessionDirsOnDisk(projectKey(ws.path))) {
      if (!union.includes(d)) {
        union.push(d);
        diskAdded += 1;
      }
    }
    destWs[id] = { ...ws, sessionIds: union };
  }

  // 3) 磁盘上尚未注册的项目目录 → 新建工作区
  const knownKeys = new Set(Object.values(destWs).map((ws) => projectKey(ws.path).toLowerCase()));
  try {
    for (const proj of fs.readdirSync(path.join(HOME, 'sessions'), { withFileTypes: true })) {
      if (!proj.isDirectory() || knownKeys.has(proj.name.toLowerCase())) continue;
      destWs[proj.name] = {
        path: proj.name,
        title: proj.name,
        sessionIds: sessionDirsOnDisk(proj.name),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      diskAdded += 1;
    }
  } catch { /* sessions 目录不存在 */ }

  // 4) 顺序：源顺序在前，其余随后
  const order = [];
  for (const id of (src?.global?.workspaceIds ?? [])) {
    const ws = srcWs[id];
    const mapped = ws
      ? (Object.entries(destWs).find(([, w]) => (w.path || '').toLowerCase() === (ws.path || '').toLowerCase())?.[0] ?? id)
      : id;
    if (destWs[mapped] && !order.includes(mapped)) order.push(mapped);
  }
  for (const id of Object.keys(destWs)) if (!order.includes(id)) order.push(id);

  const out = {
    unit: dest?.unit ?? { name: 'workspace', version: 2 },
    global: {
      ...(dest?.global ?? {}),
      workspaceIds: order,
      archivedSessionIds: [...new Set([
        ...(dest?.global?.archivedSessionIds ?? []),
        ...(src?.global?.archivedSessionIds ?? [])
      ])]
    },
    tables: { ...(dest?.tables ?? {}), workspaces: destWs }
  };

  const target = path.join(HOME, 'storages', 'workspace.json');
  const bak = `${target}.premig-${Date.now()}.bak`;
  if (fs.existsSync(target)) fs.copyFileSync(target, bak);
  fs.writeFileSync(target, JSON.stringify(out, null, 2), 'utf8');

  console.log(`修复完成：${target}`);
  for (const [, ws] of Object.entries(destWs)) {
    console.log(`  ${ws.title} [${ws.path}] -> ${ws.sessionIds.length} 个会话`);
  }
  console.log(`备份：${bak}（磁盘补全 ${diskAdded} 项）`);
}

main();
