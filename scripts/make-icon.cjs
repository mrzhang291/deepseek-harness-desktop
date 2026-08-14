'use strict';

/**
 * 生成应用图标：harness 小鲸鱼 favicon（assets/whale.svg）。
 * 样式：黑鲸 + 白色圆角底（窗口/托盘/打包图标统一）。
 */

const fs = require('node:fs');
const path = require('node:path');

async function render(sharp, outPath, size) {
  const whaleSvg = fs.readFileSync(path.join(__dirname, '..', 'assets', 'whale.svg'), 'utf8');
  const dCandidates = [...whaleSvg.matchAll(/d="([^"]+)"/g)].map((m) => m[1]);
  const whaleD = dCandidates.sort((a, b) => b.length - a.length)[0];
  if (!whaleD) throw new Error('whale.svg 中未找到 path 的 d 属性');

  // 鲸鱼实际包围盒（50×50 viewBox 内），居中并留白
  const BBOX = { x0: 0.53, y0: 7.0, x1: 49.37, y1: 48.85 };
  const cx = (BBOX.x0 + BBOX.x1) / 2;
  const cy = (BBOX.y0 + BBOX.y1) / 2;
  const PAD = 0.17;
  const scale = (50 * (1 - 2 * PAD)) / Math.max(BBOX.x1 - BBOX.x0, BBOX.y1 - BBOX.y0);
  const tx = 25 - cx * scale;
  const ty = 25 - cy * scale;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 50 50">
  <rect width="50" height="50" rx="11.5" fill="#ffffff"/>
  <g transform="translate(${tx.toFixed(4)} ${ty.toFixed(4)}) scale(${scale.toFixed(4)})">
    <path d="${whaleD}" fill="#000000"/>
  </g>
</svg>`;
  const buf = Buffer.from(svg);
  await sharp(buf, { density: 600 }).resize(size, size).png().toFile(outPath);
}

async function main() {
  const sharp = require(process.env.DSH_ICON_SHARP || 'sharp');
  const root = path.join(__dirname, '..');
  const assetsDir = path.join(root, 'assets');
  const buildDir = path.join(root, 'build');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.mkdirSync(buildDir, { recursive: true });

  await render(sharp, path.join(assetsDir, 'icon.png'), 512);
  await render(sharp, path.join(buildDir, 'icon.png'), 512);
  await render(sharp, path.join(assetsDir, 'tray.png'), 32);
  console.log('whale icons done: assets/icon.png assets/tray.png build/icon.png（黑鲸 + 白底）');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
