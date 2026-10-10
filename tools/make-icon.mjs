/**
 * 生成 Marketplace 用的扩展图标 → resources/icon.png
 *
 * 为什么需要单独一步：VSCode Marketplace 的 `icon` 字段**只接受 PNG**（SVG 不行），
 * 而 `resources/icon.svg` 是 24×24 的描边字形，直接拿去当图标太小、也没有底板。
 *
 * 做法：用 headless Edge/Chrome 的 `--screenshot` 把 SVG 渲染成 256×256 PNG，
 * 省掉引入 sharp / canvas 这类原生依赖（本项目零运行时依赖是硬约束）。
 *
 * 运行：node tools/make-icon.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG_PATH = path.join(ROOT, 'resources', 'icon.svg');
const OUT_PATH = path.join(ROOT, 'resources', 'icon.png');

const SIZE = 256;
const BRAND = '#007ACC';

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((p) => {
  try { return fs.existsSync(p); } catch { return false; }
});

if (BROWSERS.length === 0) {
  console.error('未找到 Chrome/Edge，无法生成图标。');
  process.exit(1);
}

const svg = fs.readFileSync(SVG_PATH, 'utf8');

const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8" /><style>
  html, body { margin: 0; padding: 0; width: ${SIZE}px; height: ${SIZE}px; background: transparent; }
  .bg {
    width: ${SIZE}px; height: ${SIZE}px;
    border-radius: ${Math.round(SIZE * 0.22)}px;
    background: ${BRAND};
    display: flex; align-items: center; justify-content: center;
  }
  /* CSS 的 width/height 优先级高于 SVG 上的同名呈现属性，所以能覆盖 24×24 */
  .bg svg { width: ${Math.round(SIZE * 0.6)}px; height: ${Math.round(SIZE * 0.6)}px; color: #fff; }
</style></head><body><div class="bg">${svg}</div></body></html>`;

const htmlPath = path.join(os.tmpdir(), `icon-${Date.now()}.html`);
fs.writeFileSync(htmlPath, html, 'utf8');

const args = [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  // 让圆角之外保持透明（否则会带上一块白底）
  '--default-background-color=00000000',
  `--window-size=${SIZE},${SIZE}`,
  `--screenshot=${OUT_PATH}`,
  'file:///' + htmlPath.replace(/\\/g, '/'),
];

const code = await new Promise((resolve) => {
  const p = spawn(BROWSERS[0], args, { stdio: 'ignore' });
  p.on('exit', (c) => resolve(c));
});

try { fs.unlinkSync(htmlPath); } catch { /* 忽略 */ }

if (code !== 0 || !fs.existsSync(OUT_PATH)) {
  console.error(`渲染失败（退出码 ${code}）。`);
  process.exit(1);
}

// 校验真的是一张 256×256 的 PNG（读 IHDR 里的宽高，避免"文件存在但是空的"）
const buf = fs.readFileSync(OUT_PATH);
const isPng = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const w = isPng ? buf.readUInt32BE(16) : 0;
const h = isPng ? buf.readUInt32BE(20) : 0;

if (!isPng || w !== SIZE || h !== SIZE) {
  console.error(`生成的不是预期的 PNG：isPng=${isPng} ${w}×${h}`);
  process.exit(1);
}

console.log(`✓ 已生成 ${path.relative(ROOT, OUT_PATH)}  ${w}×${h}  ${(buf.length / 1024).toFixed(1)} KB`);
