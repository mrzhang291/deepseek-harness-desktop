'use strict';

/**
 * 查询一个运行中的 DSH 实例的会话清单（不依赖 Electron）：
 *   node scripts/verify-sessions.js [port]   （默认 3180）
 * 输出：项目与会话列表，可用来核对迁移结果。
 */

const port = Number(process.argv[2] || 3180);
const origin = `http://127.0.0.1:${port}`;

async function rpc(method, payload) {
  const res = await fetch(`${origin}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ type: 'client-request', rpcId: `v-${Date.now()}`, method, payload })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for /api/${method}`);
  const json = await res.json();
  if (!json.result || json.result.ok !== true) {
    throw new Error(`RPC 失败：${JSON.stringify(json.result || json)}`);
  }
  return json.result.value;
}

async function main() {
  const { items } = await rpc('session.list', {});
  console.log(`实例 ${origin}：${items.length} 个会话\n`);
  const byCwd = new Map();
  for (const item of items) {
    const key = item.cwd || '(无工作目录)';
    if (!byCwd.has(key)) byCwd.set(key, []);
    byCwd.get(key).push(item);
  }
  for (const [cwd, list] of [...byCwd.entries()].sort()) {
    console.log(`【${cwd}】 ${list.length} 个会话`);
    for (const s of list) {
      const title = s.projections?.values?.title || '(无标题)';
      console.log(`  - ${s.sessionId}  ${title}${s.running ? '  [运行中]' : ''}`);
    }
  }
}

main().catch((err) => {
  console.error(`验证失败：${err.message}`);
  console.error('提示：先用 dsh web（或 DeepSeek Harness 桌面版）启动后端再执行本脚本。');
  process.exit(1);
});
