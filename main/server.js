'use strict';

/**
 * dsh web 子进程管理：启动 / 健康检查 / 崩溃重启（退避）/ 停止。
 * 状态通过 onState 回调上报：stopped | starting | running | crashed | stopping。
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { loadConfig, appPaths } = require('./config');
const { resolveBackend } = require('./backend');

const HOST = '127.0.0.1';

/** 探测空闲端口（探测后释放，交给 dsh 绑定，冲突靠重试兜底）。 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, HOST, () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

/** 轮询 HTTP 直到服务器响应或超时。 */
function waitForServer(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (Date.now() > deadline) {
        reject(new Error(`后端启动超时（${Math.round(timeoutMs / 1000)} 秒未响应）`));
        return;
      }
      const req = http.get({ host: HOST, port, path: '/', timeout: 2000 }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => setTimeout(attempt, 400));
      req.setTimeout(2000, () => {
        req.destroy();
        setTimeout(attempt, 400);
      });
    };
    attempt();
  });
}

/** 写入应用日志文件。 */
function logLine(line) {
  const { launcherLog } = appPaths();
  try {
    fs.mkdirSync(path.dirname(launcherLog), { recursive: true });
    fs.appendFileSync(launcherLog, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch { /* 日志写失败不影响运行 */ }
}

class DshServer {
  /**
   * @param {{ onState?: (state: object) => void, isPackaged?: boolean }} options
   */
  constructor(options = {}) {
    this.onState = options.onState || (() => {});
    this.isPackaged = Boolean(options.isPackaged);
    this.proc = null;
    this.port = null;
    this.state = 'stopped';
    this.stopping = false;
    this.quickRestarts = 0;
    this.restartTimer = null;
    this.backend = null;
    this.lastError = null;
    this.bootSeq = 0;
  }

  _setState(state, extra = {}) {
    this.state = state;
    this.onState({ state, port: this.port, backend: this.backend && this.backend.kind, ...extra });
  }

  _stopTree() {
    if (this.proc && this.proc.pid) {
      const pid = this.proc.pid;
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } else {
          spawnSync('kill', ['-TERM', String(pid)], { stdio: 'ignore' });
        }
      } catch { /* 进程可能已退出 */ }
    }
    this.proc = null;
  }

  /** 启动后端。已在运行则直接返回端口。 */
  async start() {
    if (this.state === 'running' && this.port) return this.port;
    if (this.state === 'starting') {
      // 等待当前启动完成（最多 bootTimeoutMs）
      return new Promise((resolve, reject) => {
        const { values } = loadConfig();
        const deadline = Date.now() + values.bootTimeoutMs;
        const poll = () => {
          if (this.state === 'running' && this.port) return resolve(this.port);
          if (this.state === 'crashed' || this.state === 'stopped') return reject(new Error(this.lastError || '后端启动失败'));
          if (Date.now() > deadline) return reject(new Error('等待后端启动超时'));
          setTimeout(poll, 300);
        };
        poll();
      });
    }

    this.stopping = false;
    const { values } = loadConfig();
    this.backend = resolveBackend(this.isPackaged);
    if (!this.backend.exists) {
      this._setState('crashed', { error: '找不到 dsh bin.js：fork 未构建且 npm 包不可用' });
      throw new Error('找不到 dsh bin.js：fork 未构建且 npm 包不可用');
    }

    let port = values.port && Number(values.port) > 0 ? Number(values.port) : await findFreePort();
    const fixedPort = values.port && Number(values.port) > 0;
    this._setState('starting', { port });
    logLine(`启动后端：${this.backend.node} --expose-internals ${this.backend.bin} web --host ${values.host} --port ${port} (kind=${this.backend.kind})`);

    const { serverLog } = appPaths();
    let logStream = null;
    try {
      fs.mkdirSync(path.dirname(serverLog), { recursive: true });
      logStream = fs.createWriteStream(serverLog, { flags: 'a' });
    } catch { /* 忽略 */ }

    // 独立 DSH_HOME：桌面版与网页版数据完全隔离，迁移由工作台显式执行
    const env = { ...process.env, DSH_HOME: values.home };

    const bootSeq = ++this.bootSeq;
    this.proc = spawn(
      this.backend.node,
      ['--expose-internals', this.backend.bin, 'web', '--host', values.host, '--port', String(port)],
      { env, cwd: values.workDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );

    if (logStream) {
      this.proc.stdout.on('data', (chunk) => logStream.write(chunk));
      this.proc.stderr.on('data', (chunk) => logStream.write(chunk));
    }

    const proc = this.proc;
    proc.on('error', (err) => {
      logLine(`后端进程错误：${err.message}`);
      if (this.proc === proc) {
        this.proc = null;
        this._setState('crashed', { error: err.message });
      }
    });
    proc.on('exit', (code, signal) => {
      logLine(`后端进程退出 code=${code} signal=${signal}`);
      if (this.proc === proc) this.proc = null;
      if (this.bootSeq !== bootSeq) return;   // 已被新一轮启动取代
      if (this.stopping) {
        this._setState('stopped');
        return;
      }
      if (this.state === 'starting') {
        this._setState('crashed', { error: `进程在就绪前退出（code=${code}）` });
        return;
      }
      this._scheduleRestart(code, signal);
    });

    try {
      await waitForServer(port, values.bootTimeoutMs);
    } catch (err) {
      logLine(`启动失败：${err.message}`);
      this._stopTree();
      // 固定端口被占用等场景：自动退回空闲端口再试一次
      if (fixedPort && this.bootSeq === bootSeq) {
        logLine('固定端口不可用，改用空闲端口重试');
        const fallbackPort = await findFreePort();
        const fallbackSeq = this.bootSeq;
        this._setState('starting', { port: fallbackPort });
        this.proc = spawn(
          this.backend.node,
          ['--expose-internals', this.backend.bin, 'web', '--host', values.host, '--port', String(fallbackPort)],
          { env, cwd: values.workDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
        );
        const fallbackProc = this.proc;
        if (logStream) {
          fallbackProc.stdout.on('data', (chunk) => logStream.write(chunk));
          fallbackProc.stderr.on('data', (chunk) => logStream.write(chunk));
        }
        fallbackProc.on('exit', (code, signal) => {
          logLine(`后端进程退出（fallback） code=${code} signal=${signal}`);
          if (this.proc === fallbackProc) this.proc = null;
          if (this.bootSeq !== fallbackSeq) return;
          if (this.stopping) { this._setState('stopped'); return; }
          if (this.state === 'starting') { this._setState('crashed', { error: `进程在就绪前退出（code=${code}）` }); return; }
          this._scheduleRestart(code, signal);
        });
        await waitForServer(fallbackPort, values.bootTimeoutMs);
        port = fallbackPort;
      } else {
        throw err;
      }
    }

    this.port = port;
    this.quickRestarts = 0;
    this._setState('running', { port });
    return port;
  }

  /** 崩溃后按退避策略自动重启。 */
  _scheduleRestart(code, signal) {
    const { values } = loadConfig();
    const quick = this.quickRestarts < values.maxQuickRestarts;
    this.quickRestarts += 1;
    const delay = quick ? 1200 : values.restartCooldownMs;
    this._setState('crashed', { error: `后端意外退出（code=${code ?? 'null'}），${quick ? '立即' : Math.round(delay / 1000) + ' 秒后'}自动重启`, restarting: true });
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      this.start().catch((err) => {
        logLine(`自动重启失败：${err.message}`);
        this._setState('crashed', { error: `自动重启失败：${err.message}`, restarting: false });
      });
    }, delay);
  }

  /** 停止后端并清理进程树。 */
  stop() {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.bootSeq += 1;
    this._stopTree();
    this._setState('stopped');
    this.port = null;
  }

  /** 重启（供托盘/工作台按钮使用）。 */
  async restart() {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this._stopTree();
    this.port = null;
    this.quickRestarts = 0;
    this._setState('stopped');
    return this.start();
  }
}

module.exports = { DshServer, findFreePort, waitForServer };
