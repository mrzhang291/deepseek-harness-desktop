'use strict';

/**
 * CDP 验证脚本：连接 Electron 的远程调试端口，检查欢迎页 / Harness 界面 DOM。
 *   node scripts/cdp-check.js <mode> [debugPort]
 *   mode: welcome | app
 */

const port = Number(process.argv[3] || 9222);
const mode = process.argv[2] || 'app';

async function getTargets() {
  const res = await fetch(`http://127.0.0.1:${port}/json`);
  return res.json();
}

async function evalIn(target, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const timer = setTimeout(() => { ws.close(); reject(new Error('CDP 超时')); }, 20000);
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
    });
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id === 1) {
        clearTimeout(timer);
        ws.close();
        if (msg.result && msg.result.exceptionDetails) reject(new Error(JSON.stringify(msg.result.exceptionDetails)));
        else resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
      }
    });
    ws.addEventListener('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`WS 错误：${err.message}`));
    });
  });
}

async function main() {
  const targets = await getTargets();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('没有找到 page 目标');

  if (mode === 'openApp') {
    const r = await evalIn(page, `(async () => { await window.launcher.openApp(); return 'ok'; })()`);
    console.log(r);
  } else if (mode === 'welcome') {    const r = await evalIn(page, `JSON.stringify({
      title: document.title,
      hasLauncherApi: typeof window.launcher !== 'undefined',
      statePill: document.getElementById('state-pill') ? document.getElementById('state-pill').textContent : null,
      backendKind: document.getElementById('backend-kind') ? document.getElementById('backend-kind').textContent : null,
      serviceUrl: document.getElementById('service-url') ? document.getElementById('service-url').textContent : null,
      homePath: document.getElementById('home-path') ? document.getElementById('home-path').textContent : null,
      migrateSummary: document.getElementById('migrate-summary') ? document.getElementById('migrate-summary').textContent : null,
      sourceCount: document.querySelectorAll('.source-item').length,
      projectCount: document.querySelectorAll('.project-item').length,
      firstProjectName: document.querySelector('.project-item .proj-name') ? document.querySelector('.project-item .proj-name').textContent : null,
      buttons: ['btn-start','btn-open-app','btn-migrate','btn-data-dir'].map(id => ({ id, disabled: document.getElementById(id) ? document.getElementById(id).disabled : null, text: document.getElementById(id) ? document.getElementById(id).textContent : null }))
    })`);
    console.log(r);
  } else {
    const r = await evalIn(page, `JSON.stringify({
      title: document.title,
      hasBoot: typeof window.__DSH_BOOT__ !== 'undefined',
      url: location.href,
      bodyText: document.body.innerText.slice(0, 600)
    })`);
    console.log(r);
  }
}

main().catch((err) => {
  console.error(`验证失败：${err.message}`);
  process.exit(1);
});
