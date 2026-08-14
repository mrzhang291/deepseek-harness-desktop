'use strict';

/* DeepSeek Harness 桌面版首页：服务控制 + 会话迁移工作台 */

const $ = (id) => document.getElementById(id);
const fmtBytes = (n) => {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
};
const log = (text, cls = '') => {
  const el = document.createElement('div');
  el.className = `line ${cls}`;
  el.textContent = text;
  $('migrate-log').appendChild(el);
  $('migrate-log').scrollTop = $('migrate-log').scrollHeight;
};

let state = { sources: [], selectedSource: null, server: null, config: null, firstRun: false };

// ---------------------------------------------------------------------------
// 服务状态
// ---------------------------------------------------------------------------

function renderServer(s) {
  if (!s) return;
  state.server = s;
  const pill = $('state-pill');
  const text = { stopped: '离线', starting: '启动中…', running: '运行中', crashed: '异常' }[s.state] || s.state;
  pill.textContent = text;
  pill.className = `pill ${s.state === 'running' ? 'running' : s.state === 'crashed' ? 'crashed' : ''}`;

  $('service-url').textContent = s.port ? `http://127.0.0.1:${s.port}/` : '尚未启动';
  $('btn-start').disabled = s.state === 'starting' || s.state === 'running';
  $('btn-restart').disabled = s.state !== 'running';
  $('btn-open-app').disabled = s.state !== 'running';

  const notice = $('service-notice');
  if (s.state === 'crashed' && s.error) {
    notice.hidden = false;
    notice.className = 'notice err';
    notice.textContent = `后端异常：${s.error}`;
  } else if (s.backend && s.backend.reason) {
    notice.hidden = false;
    notice.className = 'notice warn';
    notice.textContent = s.backend.reason;
  } else {
    notice.hidden = true;
  }
}

async function refreshServer() {
  renderServer(await window.launcher.serverState());
}

// ---------------------------------------------------------------------------
// 迁移工作台
// ---------------------------------------------------------------------------

function renderSources() {
  const list = $('source-list');
  list.innerHTML = '';
  if (!state.sources.length) {
    list.innerHTML = '<span class="muted">未发现可迁移的源实例（~/.dsh 不存在）</span>';
    $('project-list').innerHTML = '<span class="muted">—</span>';
    return;
  }
  if (state.selectedSource === null) state.selectedSource = state.sources[0];

  for (const src of state.sources) {
    const item = document.createElement('div');
    item.className = `source-item${src.path === state.selectedSource.path ? ' selected' : ''}`;
    const total = src.projects.reduce((s, p) => s + p.sessionCount, 0);
    item.innerHTML = `
      <div class="src-main">
        <div class="src-path">${escapeHtml(src.path)}</div>
        <div class="src-meta">${src.projects.length} 个项目 · ${total} 个会话 · ${fmtBytes(src.totalBytes)}</div>
      </div>`;
    item.addEventListener('click', () => {
      state.selectedSource = src;
      renderSources();
    });
    list.appendChild(item);
  }
  renderProjects(state.selectedSource);
}

function renderProjects(src) {
  const list = $('project-list');
  list.innerHTML = '';
  if (!src || !src.projects.length) {
    list.innerHTML = '<span class="muted">该实例没有会话项目</span>';
    return;
  }
  for (const project of src.projects) {
    const item = document.createElement('div');
    item.className = 'project-item';
    item.innerHTML = `
      <input type="checkbox" class="proj-chk" data-name="${escapeAttr(project.name)}" checked />
      <div class="proj-main">
        <div class="proj-name" title="${escapeAttr(project.display)}">${escapeHtml(project.display)}</div>
        <div class="proj-meta">${project.sessionCount} 个会话 · ${fmtBytes(project.bytes)}</div>
      </div>`;
    list.appendChild(item);
  }
  const all = $('chk-all-projects');
  all.checked = true;
  all.addEventListener('change', () => {
    for (const chk of list.querySelectorAll('.proj-chk')) chk.checked = all.checked;
  });
}

function selectedProjects() {
  return [...document.querySelectorAll('.proj-chk:checked')].map((c) => c.dataset.name);
}

/** 首次配置：迁移（可选）→ 启动后端 → 进入 DeepSeek Harness。 */
async function onboardStart() {
  const btn = $('btn-migrate');
  btn.disabled = true;
  try {
    if (state.firstRun && state.selectedSource && $('chk-migrate-on').checked) {
      await runMigration();
    }
    if (!state.server || state.server.state !== 'running') {
      const r = await window.launcher.startServer();
      renderServer({ state: 'running', port: r.port });
    }
    window.launcher.openApp();
  } catch (err) {
    renderServer({ state: 'crashed', error: String((err && err.message) || err) });
  } finally {
    btn.disabled = false;
  }
}

function updateSummary(text) {
  $('migrate-summary').textContent = text || '';
}

async function runMigration() {
  if (!state.selectedSource) return;
  const btn = $('btn-migrate');
  btn.disabled = true;
  $('progress-wrap').hidden = false;
  $('progress-bar').style.width = '2%';
  updateSummary('');
  log('开始迁移…', '');
  log(`源实例：${state.selectedSource.path}`);
  log(`目标目录：${state.config.paths.home}`);

  const options = {
    source: state.selectedSource.path,
    projects: $('chk-all-projects').checked ? [] : selectedProjects(),
    conflictPolicy: document.querySelector('input[name="policy"]:checked').value,
    includeSettings: $('chk-settings').checked,
    includeCredentials: $('chk-credentials').checked,
    includeAnonymousId: $('chk-anon').checked,
    includeProfiles: $('chk-profiles').checked,
    includeStorages: $('chk-storages').checked
  };

  const report = await window.launcher.runMigration(options);

  $('progress-bar').style.width = '100%';
  log('迁移完成。', 'ok');
  log(
    `项目 ${report.projectsCopied} 个（跳过 ${report.projectsSkipped}）· 会话目录 ${report.sessionDirsCopied} 个（跳过 ${report.sessionDirsSkipped}）` +
    `· 配置文件 ${report.extraFilesCopied} 个 · 共 ${fmtBytes(report.bytes)} / ${report.files} 个文件`
  );
  if (report.unstable.length) {
    log(`警告：${report.unstable.length} 个文件复制期间仍在写入（源实例正在运行），已尽力完整复制：`, 'warn');
    for (const u of report.unstable) log(`  ${u}`, 'warn');
  }
  for (const err of report.errors) log(`错误：${err.item} —— ${err.message}`, 'err');
  if (!report.errors.length && !report.unstable.length) {
    log('提示：可以在 DeepSeek Harness 界面左侧看到迁移过来的项目与会话。');
  }
  updateSummary(`完成：${report.sessionDirsCopied} 个会话目录 / ${fmtBytes(report.bytes)}`);
  btn.disabled = false;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s);
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------

function bind() {
  $('btn-start').addEventListener('click', async () => {
    renderServer({ state: 'starting' });
    try {
      const r = await window.launcher.startServer();
      renderServer({ state: 'running', port: r.port });
    } catch (err) {
      renderServer({ state: 'crashed', error: String(err && err.message || err) });
    }
  });
  $('btn-restart').addEventListener('click', async () => {
    renderServer({ state: 'starting' });
    try {
      const r = await window.launcher.restartServer();
      renderServer({ state: 'running', port: r.port });
    } catch (err) {
      renderServer({ state: 'crashed', error: String(err && err.message || err) });
    }
  });
  $('btn-open-app').addEventListener('click', () => window.launcher.openApp());
  $('btn-migrate').addEventListener('click', () => {
    if (state.firstRun) onboardStart();
    else runMigration();
  });
  $('btn-data-dir').addEventListener('click', () => state.config && window.launcher.openPath(state.config.paths.home));
  $('btn-logs').addEventListener('click', () => state.config && window.launcher.openPath(state.config.paths.logs));
  $('btn-minimize').addEventListener('click', () => window.launcher.minimize());

  window.launcher.onServerState((s) => renderServer(s));
}

async function init() {
  state.config = await window.launcher.getConfig();
  const { values, paths, backend, manifest } = state.config;

  $('home-path').textContent = paths.home;
  $('backend-kind').textContent = backend.kind === 'fork'
    ? 'fork（mrzhang291/deepseek-harness）'
    : 'npm（@deepseek-ai/dsh）';
  $('backend-bin').textContent = backend.bin;
  $('footer-version').textContent = `DeepSeek Harness v0.1.0 · 后端模式 ${values.backend}`;
  if (backend.reason) $('footer-note').textContent = backend.reason;

  bind();

  state.sources = await window.launcher.scanSources();
  state.firstRun = !manifest && state.sources.length > 0;

  // 首次配置模式：调整文案与按钮
  if (state.firstRun) {
    document.title = '首次配置 · DeepSeek Harness';
    $('sub-title').textContent = '首次配置：迁移网页版数据，之后启动直接进入界面';
    $('migrate-title').textContent = '迁移网页版数据（首次配置）';
    $('btn-migrate').textContent = '开始使用';
  } else {
    $('onboarding-block').style.display = 'none';
  }

  if (manifest) {
    $('migrate-state-pill').hidden = false;
    const dt = new Date(manifest.finishedAt || manifest.startedAt).toLocaleString('zh-CN');
    updateSummary(`上次迁移：${dt} · ${manifest.sessionDirsCopied} 个会话`);
  }

  renderSources();

  await refreshServer();
}

init();
