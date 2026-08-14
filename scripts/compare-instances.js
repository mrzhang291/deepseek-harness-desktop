'use strict';

/**
 * 对比两个运行中实例的会话命名/工作区：
 *   node scripts/compare-instances.js <portA> <portB>   （默认 3080 3190）
 */

const portA = Number(process.argv[2] || 3080);
const portB = Number(process.argv[3] || 3190);

async function rpc(port, method, payload) {
  const res = await fetch(`http://127.0.0.1:${port}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
    body: JSON.stringify({ type: 'client-request', rpcId: `c-${Date.now()}-${Math.random()}`, method, payload })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (!json.result || json.result.ok !== true) throw new Error(JSON.stringify(json.result || json));
  return json.result.value;
}

function titleOf(item) {
  return (item.projections && item.projections.values && item.projections.values.title) || '';
}

async function main() {
  const [a, b] = await Promise.all([rpc(portA, 'session.list', {}), rpc(portB, 'session.list', {})]);
  const mapA = new Map(a.items.map((i) => [i.sessionId, i]));
  const mapB = new Map(b.items.map((i) => [i.sessionId, i]));
  console.log(`实例 ${portA}：${a.items.length} 个会话；实例 ${portB}：${b.items.length} 个会话\n`);

  let same = 0;
  let diff = 0;
  for (const [id, itemA] of mapA) {
    const itemB = mapB.get(id);
    if (!itemB) {
      console.log(`[缺失] ${id}（${portB} 没有）`);
      diff += 1;
      continue;
    }
    const tA = titleOf(itemA);
    const tB = titleOf(itemB);
    if (tA === tB) {
      same += 1;
    } else {
      diff += 1;
      console.log(`[命名不同] ${id}`);
      console.log(`   ${portA}: ${tA || '(空)'}`);
      console.log(`   ${portB}: ${tB || '(空)'}`);
    }
  }
  for (const [id] of mapB) {
    if (!mapA.has(id)) console.log(`[新增] ${id}（${portB} 独有）`);
  }
  console.log(`\n标题一致：${same} / ${mapA.size}，不一致：${diff}`);

  // 工作区对比
  try {
    const [wa, wb] = await Promise.all([rpc(portA, 'workspace.list', {}), rpc(portB, 'workspace.list', {})]);
    const nameOf = (w) => `${w.title ?? ''} @ ${w.path ?? ''}`;
    console.log(`\n工作区 ${portA}：`); (wa.workspaces || wa.items || []).forEach((w) => console.log(`  - ${nameOf(w)}`));
    console.log(`工作区 ${portB}：`); (wb.workspaces || wb.items || []).forEach((w) => console.log(`  - ${nameOf(w)}`));
  } catch (err) {
    console.log(`工作区对比跳过：${err.message}`);
  }
}

main().catch((err) => {
  console.error(`对比失败：${err.message}`);
  process.exit(1);
});
