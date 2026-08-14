'use strict';

/**
 * 会话迁移引擎：把既有 DSH 实例（默认 ~/.dsh，即网页版数据目录）中的
 * 项目/会话与实例配置复制到桌面版 DSH_HOME（默认 D:\deepseek\home）。
 *
 * 安全要点：
 *  - 幂等：重复迁移默认跳过已存在目标，不会产生重复会话
 *  - 稳定复制：源实例可能仍在运行（会话日志持续追加），复制前/后比对
 *    size+mtime，不一致就重试，仍不稳定则标记 unstable 继续
 *  - 覆盖策略：overwrite 会先把已有目标改名备份（.premig-<ts>.bak）
 *  - 每次迁移写入清单 home/.launcher-migration.json 供 UI/审计使用
 */

const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { loadConfig, appPaths } = require('./config');

const SLEEP_MS = 400;
const STABLE_RETRIES = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 自动探测默认迁移源：~/.dsh（网页版默认数据目录）。 */
function defaultSourceHomes() {
  const { values } = loadConfig();
  const list = [];
  if (Array.isArray(values.sourceHomes)) {
    for (const p of values.sourceHomes) if (typeof p === 'string' && fs.existsSync(p)) list.push(p);
  }
  const def = path.join(os.homedir(), '.dsh');
  if (fs.existsSync(def) && !list.includes(def)) list.push(def);
  return list;
}

/** 递归统计目录大小。 */
function dirSize(dir) {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.isFile()) {
        try {
          bytes += fs.statSync(p).size;
          files += 1;
        } catch { /* 文件可能刚被删 */ }
      }
    }
  }
  return { bytes, files };
}

/** 目录内所有文件的最大 mtime（用于判断源是否比目标新）。 */
function dirMaxMtime(dir) {
  let max = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const p = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (entry.isFile()) {
        try {
          const mt = fs.statSync(p).mtimeMs;
          if (mt > max) max = mt;
        } catch { /* 忽略 */ }
      }
    }
  }
  return max;
}

/** 目标路径的 mtime（文件或目录内最大文件 mtime）。 */
function destMtime(p) {
  try {
    const st = fs.statSync(p);
    if (st.isFile()) return st.mtimeMs;
    if (st.isDirectory()) return dirMaxMtime(p);
  } catch { /* 不存在 */ }
  return 0;
}

/** 扫描一个源 DSH_HOME，返回可在 UI 展示的完整清单。 */
function scanSource(source) {
  const result = {
    path: source,
    projects: [],
    extras: {
      settings: statFile(path.join(source, 'settings.yaml')),
      credentials: statFile(path.join(source, '.credentials.yaml')),
      anonymousId: statFile(path.join(source, '.anonymous-user-id')),
      profiles: statDir(path.join(source, 'profiles')),
      storages: statDir(path.join(source, 'storages'))
    },
    totalBytes: 0
  };

  const sessionsDir = path.join(source, 'sessions');
  let entries;
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(sessionsDir, entry.name);
    const sessionDirs = [];
    let sessions;
    try {
      sessions = fs.readdirSync(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const s of sessions) {
      if (!s.isDirectory()) continue;
      // 跳过备份目录与隐藏目录（.launcher-backups 之类不在 sessions 内，双保险）
      if (s.name.startsWith('.') || s.name.includes('.premig-')) continue;
      const sd = path.join(projectDir, s.name);
      const size = dirSize(sd);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(sd).mtimeMs;
      } catch { /* 忽略 */ }
      sessionDirs.push({ name: s.name, ...size, mtimeMs });
    }
    const bytes = sessionDirs.reduce((sum, s) => sum + s.bytes, 0);
    const project = {
      name: entry.name,
      display: decodeProjectName(entry.name),
      sessionCount: sessionDirs.length,
      sessions: sessionDirs,
      bytes,
      files: sessionDirs.reduce((sum, s) => sum + s.files, 0)
    };
    result.projects.push(project);
    result.totalBytes += bytes;
  }
  for (const extra of Object.values(result.extras)) {
    if (extra && extra.bytes) result.totalBytes += extra.bytes;
  }
  result.projects.sort((a, b) => b.mtimeMs - a.mtimeMs || b.bytes - a.bytes);
  return result;
}

function statFile(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    return { path: p, name: path.basename(p), bytes: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

function statDir(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return null;
    const size = dirSize(p);
    return { path: p, name: path.basename(p), ...size, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * 项目目录名 → 显示名。dsh 的 projectKey 编码是「有损的人类可读约定」
 * （分隔符 / \ : 折成 -，不安全码元用 ~XXXX，前后包 --），官方并不做解码。
 * 这里只做最保守的还原：去掉前后 "--"，若首段形如盘符则把第一个 "-" 换成
 * ":\"，其余部分原样保留（中间的 "-" 可能是真实连字符）。
 */
function decodeProjectName(name) {
  if (!name.startsWith('--') || !name.endsWith('--')) return name;
  const inner = name.slice(2, -2);
  const colon = inner.indexOf('-');
  if (colon <= 0 || colon > 1) return inner;
  const drive = inner.slice(0, colon);
  if (!/^[A-Za-z]$/.test(drive)) return inner;
  return `${drive}:\\${inner.slice(colon + 1)}`;
}

/** 稳定复制单个文件：源仍在变化时重试，返回 { stable }。 */
async function copyFileStable(src, dest) {
  for (let attempt = 0; attempt <= STABLE_RETRIES; attempt += 1) {
    const before = await fsp.stat(src);
    await fsp.copyFile(src, dest);
    const after = await fsp.stat(src);
    if (after.size === before.size && after.mtimeMs === before.mtimeMs) {
      return { stable: true, bytes: after.size };
    }
    if (attempt < STABLE_RETRIES) await sleep(SLEEP_MS);
  }
  return { stable: false, bytes: (await fsp.stat(src)).size };
}

/** 递归复制目录树，逐文件走稳定复制；返回统计。 */
async function copyDirStable(srcDir, destDir, report) {
  const entries = await fsp.readdir(srcDir, { withFileTypes: true });
  await fsp.mkdir(destDir, { recursive: true });
  for (const entry of entries) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      await copyDirStable(src, dest, report);
    } else if (entry.isFile()) {
      const { stable, bytes } = await copyFileStable(src, dest);
      report.bytes += bytes;
      report.files += 1;
      if (!stable) {
        report.unstable.push(src);
      }
    }
    // 其他类型（符号链接等）跳过
  }
}

/**
 * 备份一个将被覆盖的目标。备份必须放在 sessions/storages 数据树之外
 * （home\.launcher-backups\ 下镜像原相对路径），否则 dsh 会把备份目录
 * 当成会话读取，头信息不匹配直接启动失败。
 */
function backupExisting(p) {
  const { values } = loadConfig();
  const home = values.home;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rel = path.relative(home, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    // 不在 home 内（理论上不会发生）：就地改名兜底
    const bak = `${p}.premig-${stamp}.bak`;
    fs.renameSync(p, bak);
    return bak;
  }
  const bak = path.join(home, '.launcher-backups', `${rel}.premig-${stamp}.bak`);
  fs.mkdirSync(path.dirname(bak), { recursive: true });
  fs.renameSync(p, bak);
  return bak;
}

/**
 * storages 迁移：workspace.json / session_projcache.json 与目标合并（源条目优先、
 * 目标独有条目保留），其余文件按普通冲突策略复制。合并即幂等，不受 skip 策略影响。
 */
async function migrateStorages(srcDir, destDir, conflictPolicy, report, emit) {
  await fsp.mkdir(destDir, { recursive: true });
  const MERGE_FILES = {
    'workspace.json': mergeWorkspaceJson,
    'session_projcache.json': mergeProjcacheJson
  };
  for (const [name, mergeFn] of Object.entries(MERGE_FILES)) {
    const srcFile = path.join(srcDir, name);
    const destFile = path.join(destDir, name);
    if (!fs.existsSync(srcFile)) continue;
    if (fs.existsSync(destFile)) {
      try {
        if (conflictPolicy === 'overwrite') {
          const bak = backupExisting(destFile);
          emit('extra', { action: 'backup', name, backup: bak });
        }
        const merged = mergeFn(destFile, srcFile);
        if (!merged) continue;
        await writeJsonAtomic(destFile, merged.dest);
        report.extraFilesCopied += 1;
        emit('extra', { action: 'merge', name, replaced: merged.replaced, added: merged.added });
      } catch (err) {
        report.errors.push({ item: `storages/${name}`, message: err.message });
      }
    } else {
      try {
        const { stable, bytes } = await copyFileStable(srcFile, destFile);
        report.extraFilesCopied += 1;
        report.bytes += bytes;
        report.files += 1;
        if (!stable) report.unstable.push(srcFile);
        emit('extra', { action: 'copy', name, bytes });
      } catch (err) {
        report.errors.push({ item: `storages/${name}`, message: err.message });
      }
    }
  }
  // 其余条目：普通策略复制
  let entries;
  try {
    entries = await fsp.readdir(srcDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name in MERGE_FILES) continue;
    const srcP = path.join(srcDir, entry.name);
    const destP = path.join(destDir, entry.name);
    if (fs.existsSync(destP)) {
      if (conflictPolicy === 'overwrite') {
        const bak = backupExisting(destP);
        emit('extra', { action: 'backup', name: entry.name, backup: bak });
      } else {
        report.extraFilesSkipped += 1;
        continue;
      }
    }
    try {
      if (entry.isDirectory()) await copyDirStable(srcP, destP, report);
      else if (entry.isFile()) {
        const { stable, bytes } = await copyFileStable(srcP, destP);
        report.bytes += bytes;
        report.files += 1;
        if (!stable) report.unstable.push(srcP);
      }
      report.extraFilesCopied += 1;
      emit('extra', { action: 'copy', name: entry.name });
    } catch (err) {
      report.errors.push({ item: `storages/${entry.name}`, message: err.message });
    }
  }
}

/**
 * 执行迁移。
 * @param {{ source: string, projects: string[], conflictPolicy: 'skip'|'overwrite',
 *           includeSettings: boolean, includeCredentials: boolean, includeAnonymousId: boolean,
 *           includeProfiles: boolean, includeStorages: boolean }} options
 * @param {(progress: object) => void} onProgress
 */
async function runMigration(options, onProgress = () => {}) {
  const { values } = loadConfig();
  const home = values.home;
  const conflictPolicy = options.conflictPolicy === 'overwrite' ? 'overwrite' : 'skip';
  const projectNames = new Set(Array.isArray(options.projects) ? options.projects : []);
  const report = {
    source: options.source,
    dest: home,
    startedAt: new Date().toISOString(),
    projectsCopied: 0,
    projectsSkipped: 0,
    sessionDirsCopied: 0,
    sessionDirsSkipped: 0,
    extraFilesCopied: 0,
    extraFilesSkipped: 0,
    bytes: 0,
    files: 0,
    unstable: [],
    errors: []
  };

  const emit = (step, detail) => onProgress({ step, ...detail });

  try {
    await fsp.mkdir(path.join(home, 'sessions'), { recursive: true });
    const scan = scanSource(options.source);

    // 1) 项目/会话
    for (const project of scan.projects) {
      if (projectNames.size > 0 && !projectNames.has(project.name)) continue;
      const destProject = path.join(home, 'sessions', project.name);
      emit('project', { project: project.name, display: project.display, sessions: project.sessionCount });

      let projectCopied = 0;
      for (const session of project.sessions) {
        const destSession = path.join(destProject, session.name);
        const srcSession = path.join(options.source, 'sessions', project.name, session.name);
        if (fs.existsSync(destSession)) {
          if (conflictPolicy === 'overwrite') {
            const bak = backupExisting(destSession);
            emit('session', { action: 'backup', project: project.name, session: session.name, backup: bak });
          } else if (dirMaxMtime(srcSession) <= destMtime(destSession)) {
            report.sessionDirsSkipped += 1;
            emit('session', { action: 'skip', project: project.name, session: session.name });
            continue;
          } else {
            // 目标存在但源更新：增量刷新（覆盖同名文件，保留目标独有文件）
            emit('session', { action: 'refresh', project: project.name, session: session.name });
          }
        }
        try {
          await copyDirStable(srcSession, destSession, report);
          report.sessionDirsCopied += 1;
          projectCopied += 1;
          emit('session', { action: 'copy', project: project.name, session: session.name, bytes: session.bytes });
        } catch (err) {
          report.errors.push({ item: `session ${project.name}/${session.name}`, message: err.message });
          emit('session', { action: 'error', project: project.name, session: session.name, message: err.message });
        }
      }
      if (projectCopied > 0) report.projectsCopied += 1;
      else report.projectsSkipped += 1;
      emit('projectDone', { project: project.name, copied: projectCopied });
    }

    // 2) 实例配置（单个文件，支持 keep 语义一致的策略）
    const extras = scan.extras;
    const wanted = [
      ['settings', options.includeSettings],
      ['credentials', options.includeCredentials],
      ['anonymousId', options.includeAnonymousId]
    ];
    for (const [key, include] of wanted) {
      if (!include) continue;
      const item = extras[key];
      if (!item) continue;
      const dest = path.join(home, path.basename(item.path));
      if (fs.existsSync(dest)) {
        if (conflictPolicy === 'overwrite') {
          const bak = backupExisting(dest);
          emit('extra', { action: 'backup', name: item.name, backup: bak });
        } else if (item.mtimeMs <= destMtime(dest)) {
          report.extraFilesSkipped += 1;
          emit('extra', { action: 'skip', name: item.name });
          continue;
        } else {
          emit('extra', { action: 'refresh', name: item.name });
        }
      }
      try {
        const { stable, bytes } = await copyFileStable(item.path, dest);
        report.extraFilesCopied += 1;
        report.bytes += bytes;
        report.files += 1;
        if (!stable) report.unstable.push(item.path);
        emit('extra', { action: 'copy', name: item.name, bytes });
      } catch (err) {
        report.errors.push({ item: `file ${item.name}`, message: err.message });
      }
    }

    // 3) 目录类配置（profiles 普通复制；storages 特殊处理 —— 两个 JSON 按主键合并）
    for (const [key, include] of [['profiles', options.includeProfiles], ['storages', options.includeStorages]]) {
      if (!include) continue;
      const item = extras[key];
      if (!item) continue;
      const dest = path.join(home, item.name);
      if (key === 'storages') {
        await migrateStorages(item.path, dest, conflictPolicy, report, emit);
        continue;
      }
      if (fs.existsSync(dest)) {
        if (conflictPolicy === 'overwrite') {
          const bak = backupExisting(dest);
          emit('extra', { action: 'backup', name: item.name, backup: bak });
        } else {
          report.extraFilesSkipped += 1;
          emit('extra', { action: 'skip', name: item.name });
          continue;
        }
      }
      try {
        await copyDirStable(item.path, dest, report);
        report.extraFilesCopied += 1;
        emit('extra', { action: 'copy', name: item.name, bytes: item.bytes });
      } catch (err) {
        report.errors.push({ item: `dir ${item.name}`, message: err.message });
      }
    }

    report.finishedAt = new Date().toISOString();
    await fsp.writeFile(
      appPaths().migrationManifest,
      JSON.stringify({ ...report, config: { home, source: options.source } }, null, 2),
      'utf8'
    );
  } catch (err) {
    report.errors.push({ item: 'migration', message: err.message });
  }
  return report;
}

/** 读取最近一次迁移清单（无则 null）。 */
function lastMigrationManifest() {
  try {
    return JSON.parse(fs.readFileSync(appPaths().migrationManifest, 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// storages 智能合并：workspace.json / session_projcache.json 决定侧栏里的
// 项目命名、会话标题与排序。直接整目录覆盖会丢掉桌面版新建的条目，
// 因此按主键合并：源条目覆盖同名/同路径条目，保留目标独有的条目。
// ---------------------------------------------------------------------------

function normalizePathKey(p) {
  return typeof p === 'string' ? p.toLowerCase() : String(p);
}

function readJsonOrNull(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** 原子写入 JSON（临时文件 + rename）。 */
async function writeJsonAtomic(p, value) {
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(tmp, p);
}

/**
 * 合并 workspace.json：按 workspace.path 对齐。
 *  - 同路径：sessionIds 取并集（源在前、目标独有的保留），标题用源的，
 *    id 保留目标侧（维持桌面版引用稳定），updatedAt 取较新值 —— 桌面版
 *    自己新建的会话不会被冲掉；
 *  - 目标独有的路径保留。
 * 顺序 = 源顺序在前，目标独有条目随后。返回统计。
 */
function mergeWorkspaceJson(destPath, srcPath) {
  const dest = readJsonOrNull(destPath) || { unit: { name: 'workspace', version: 2 }, global: {}, tables: { workspaces: {} } };
  const src = readJsonOrNull(srcPath);
  if (!src) return null;
  const destWs = dest.tables?.workspaces ?? {};
  const srcWs = src.tables?.workspaces ?? {};
  const destByPath = new Map();
  for (const [id, ws] of Object.entries(destWs)) {
    destByPath.set(normalizePathKey(ws?.path), { id, ws });
  }
  let replaced = 0;
  let added = 0;
  for (const [srcId, ws] of Object.entries(srcWs)) {
    const hit = destByPath.get(normalizePathKey(ws?.path));
    if (hit) {
      const destIds = Array.isArray(hit.ws.sessionIds) ? hit.ws.sessionIds : [];
      const srcIds = Array.isArray(ws.sessionIds) ? ws.sessionIds : [];
      const union = [...srcIds];
      for (const id of destIds) if (!union.includes(id)) union.push(id);
      const merged = { ...ws, sessionIds: union };
      const destUpdated = typeof hit.ws.updatedAt === 'string' ? Date.parse(hit.ws.updatedAt) : (hit.ws.updatedAt ?? 0);
      const srcUpdated = typeof ws.updatedAt === 'string' ? Date.parse(ws.updatedAt) : (ws.updatedAt ?? 0);
      if (Number.isFinite(destUpdated) && destUpdated > srcUpdated) merged.updatedAt = hit.ws.updatedAt;
      destWs[hit.id] = merged;
      if (hit.id !== srcId) delete destWs[srcId];
      replaced += 1;
    } else {
      destWs[srcId] = ws;
      added += 1;
    }
  }
  const pathToId = new Map(
    Object.entries(destWs).map(([id, ws]) => [normalizePathKey(ws?.path), id])
  );
  const order = [];
  for (const id of (src.global?.workspaceIds ?? [])) {
    const ws = srcWs[id];
    const mapped = ws ? (pathToId.get(normalizePathKey(ws.path)) ?? id) : id;
    if (destWs[mapped] && !order.includes(mapped)) order.push(mapped);
  }
  for (const id of Object.keys(destWs)) if (!order.includes(id)) order.push(id);
  dest.global = dest.global ?? {};
  dest.global.workspaceIds = order;
  dest.global.archivedSessionIds = [
    ...new Set([...(dest.global.archivedSessionIds ?? []), ...(src.global?.archivedSessionIds ?? [])])
  ];
  dest.tables = dest.tables ?? {};
  dest.tables.workspaces = destWs;
  return { dest, replaced, added };
}

/** 合并 session_projcache.json：按 sessionId 对齐，源行覆盖目标行，目标独有行保留。 */
function mergeProjcacheJson(destPath, srcPath) {
  const dest = readJsonOrNull(destPath) || { unit: { name: 'session_projcache', version: 3 }, global: null, tables: { sessions: {} } };
  const src = readJsonOrNull(srcPath);
  if (!src) return null;
  const destSessions = dest.tables?.sessions ?? {};
  const srcSessions = src.tables?.sessions ?? {};
  let replaced = 0;
  let added = 0;
  for (const [id, row] of Object.entries(srcSessions)) {
    if (destSessions[id]) replaced += 1;
    else added += 1;
    destSessions[id] = row;
  }
  dest.tables = dest.tables ?? {};
  dest.tables.sessions = destSessions;
  if (dest.global == null && src.global != null) dest.global = src.global;
  return { dest, replaced, added };
}

module.exports = { defaultSourceHomes, scanSource, runMigration, lastMigrationManifest, decodeProjectName, mergeWorkspaceJson, mergeProjcacheJson };
