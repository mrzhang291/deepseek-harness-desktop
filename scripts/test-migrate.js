'use strict';

/**
 * 无头验证脚本（不需要 Electron）：
 *   node scripts/test-migrate.js [--fresh] [sourceDir]
 * --fresh：先清空 D:\deepseek\home\sessions，模拟全新桌面实例的首次迁移。
 */

const fs = require('node:fs');
const path = require('node:path');

const migrate = require('../main/migrate');

async function main() {
  const args = process.argv.slice(2);
  const fresh = args.includes('--fresh');
  const source = args.find((a) => !a.startsWith('--')) || migrate.defaultSourceHomes()[0];

  if (!source) {
    console.error('未找到迁移源（~/.dsh 不存在）');
    process.exit(1);
  }
  console.log(`迁移源：${source}`);

  if (fresh) {
    const sessions = path.join('D:\\deepseek\\home', 'sessions');
    console.log(`--fresh：清空 ${sessions}`);
    fs.rmSync(sessions, { recursive: true, force: true });
  }

  const scan = migrate.scanSource(source);
  console.log(`扫描：${scan.projects.length} 个项目，共 ${scan.projects.reduce((s, p) => s + p.sessionCount, 0)} 个会话`);
  for (const p of scan.projects) {
    console.log(`  - ${p.display}  [${p.name}]  ${p.sessionCount} 会话 ${p.bytes} 字节`);
  }

  const report = await migrate.runMigration(
    {
      source,
      projects: [],
      conflictPolicy: 'skip',
      includeSettings: true,
      includeCredentials: true,
      includeAnonymousId: true,
      includeProfiles: false,
      includeStorages: true
    },
    (progress) => {
      if (progress.step === 'session') {
        console.log(`  [${progress.action}] ${progress.project}/${progress.session}`);
      }
    }
  );

  console.log('==== 迁移报告 ====');
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.errors.length > 0 ? 2 : 0);
}

main();
