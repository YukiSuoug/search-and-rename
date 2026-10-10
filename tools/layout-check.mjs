/**
 * 布局回归检查：在真实浏览器里验证「预览列表」的行内布局。
 *
 * 为什么需要它：本项目的列表布局已经回归过两次 ——
 *   ① `flex-wrap: wrap` → 长名字折成三四行（太挤）
 *   ② 整行 `nowrap + text-overflow: ellipsis` → 不折行了，但把**新名**截掉（`→ ot_bo…`）
 * 两次都是「CSS 静态检查全过、单测全过，但用户看到的界面是错的」。
 * `text-overflow` / flex 收缩这类行为**只有真浏览器能验证**，jsdom 不算布局。
 *
 * 做法：用真实的 buildTree 产出 TreeRow → 注入真实的 panel.js 的 renderRow
 * → 套真实的 panel.css → 在 CDP 里量每一行的行数与新名可见性。
 *
 * 运行：node tools/layout-check.mjs
 * 没有可用浏览器时优雅跳过（退出码 0），不阻塞开发流程。
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { buildCandidates, buildPlan } = require(path.join(ROOT, 'out/core/plan.js'));
const { buildTree } = require(path.join(ROOT, 'out/core/tree.js'));
const { compilePattern, diffNames } = require(path.join(ROOT, 'out/core/regex.js'));

/* --------------------------- 1. 造真实数据 --------------------------- */

/** 复刻用户截图里的场景：深层目录 + 同目录多文件 */
function entry(fsPath, isDirectory) {
  const name = fsPath.slice(fsPath.lastIndexOf('/') + 1);
  return { fsPath, uri: `file://${fsPath}`, name, isDirectory, relPath: fsPath.replace('/ws/', '') };
}

const FIXTURES = [
  entry('/ws/nativePC/otomo/equip/ot029', true),
  entry('/ws/nativePC/otomo/equip/ot029/body/mod/ot_body_029.ccl', false),
  entry('/ws/nativePC/otomo/equip/ot029/body/mod/ot_body_029.ctc', false),
  entry('/ws/nativePC/otomo/equip/ot029/body/mod/ot_body_029.mod3', false),
  entry('/ws/nativePC/otomo/equip/ot029/body/mod/ot_body_029.mrl3', false),
  entry('/ws/nativePC/otomo/equip/ot029/helm/mod/ot_helm_029.ctc', false),
  entry('/ws/nativePC/otomo/equip/ot029/helm/mod/ot_helm_029.mod3', false),
];

/** 长文件名：旧名 + 新名加起来超过行宽，但新名本身放得下 → 检验"旧名让位" */
const FIXTURES_LONG = [
  entry('/ws/nativePC/otomo/equip/ot029', true),
  entry('/ws/nativePC/otomo/equip/ot029/body/mod/ot_body_029_longname.ccl', false),
  entry('/ws/nativePC/otomo/equip/ot029/body/mod/ot_body_029_longname.ctc', false),
];

function makeRows(find, replace, fixtures = FIXTURES, target = 'both') {
  const opts = {
    find, replace, isRegex: false, caseSensitive: true, wholeWord: false,
    preserveCase: false, preserveExtension: true, matchTarget: target,
  };
  const plan = buildPlan(buildCandidates(fixtures, opts));
  const { regex } = compilePattern(find, { isRegex: false, caseSensitive: true, wholeWord: false });
  const nameDiffs = new Map();
  for (const p of plan) nameDiffs.set(p.fromPath, diffNames(p.oldName, p.newName, regex));
  return { items: plan, rows: buildTree({ pairs: plan, conflicts: new Map(), nameDiffs }), total: plan.length, conflictCount: 0, truncated: false };
}

const SCENARIOS = [
  // 用户截图里的真实场景：改完应该全部放得下，甚至旧名都不用省略
  { name: '常规文件名（应全部完整）', result: makeRows('029', '1'), expectNewComplete: true },
  // 核心场景：旧名必须让位，新名保持完整
  { name: '旧名让位（新名须完整）', result: makeRows('029_longname', '1_long', FIXTURES_LONG), expectNewComplete: true, expectOldYields: true },
  // 同一批数据、但打开「换行」开关：应当不再截断任何一侧，而是折行
  { name: '开启换行（不截断，改折行）', result: makeRows('029_longname', '1_long', FIXTURES_LONG), wrap: true, expectWrap: true },
  // 极端场景：新名本身就比整行还长。此时允许截断新名，但绝不能顶破行宽
  { name: '新名超长（须优雅降级）', result: makeRows('029', '1_' + 'x'.repeat(60)), expectNewComplete: false, expectOldYields: true },
];

/* --------------------------- 2. 组装页面 --------------------------- */

/** 真实 panelProvider.html() 里的骨架（去掉 CSP 与 nonce） */
const SKELETON = `
<div id="root">
  <div class="tabs" role="tablist">
    <button id="tab-content" class="tab" role="tab" aria-selected="false">内容替换</button>
    <button id="tab-rename" class="tab" role="tab" aria-selected="true">名称重命名</button>
  </div>
  <div class="pane" id="pane-rename">
    <div class="fields">
      <div class="field"><label for="find">查找名称</label>
        <input id="find" type="text" /></div>
      <div class="field"><label for="replace">替换为</label>
        <input id="replace" type="text" /></div>
      <div class="hint">支持 <code>$1</code> 捕获组</div>
    </div>
    <div class="options">
      <button id="opt-case" class="toggle">Aa</button>
      <button id="opt-word" class="toggle">|ab|</button>
      <button id="opt-regex" class="toggle">.*</button>
      <button id="opt-preserve" class="toggle">AB</button>
      <span class="sep"></span>
      <select id="opt-target"><option value="both">文件 + 文件夹</option></select>
      <label class="chk"><input id="opt-ext" type="checkbox" checked /> 保留扩展名</label>
    </div>
    <div class="actions">
      <button id="btn-preview" class="primary">预览</button>
      <button id="btn-execute" class="go" disabled>全部重命名</button>
      <button id="btn-undo" class="ghost" disabled>撤销上次</button>
    </div>
    <div id="status" class="status"></div>
    <div id="list-head" class="list-head" hidden>
      <label><input id="check-all" type="checkbox" checked /> 全选</label>
      <div class="head-right">
        <span id="count"></span>
        <button id="btn-expand" class="mini">展开</button>
        <button id="btn-collapse" class="mini">折叠</button>
        <button id="btn-wrap" class="mini" aria-pressed="false">换行</button>
      </div>
    </div>
    <div id="list" class="list"></div>
    <div id="empty" class="empty">输入「查找名称」后点击预览。</div>
  </div>
  <div class="pane" id="pane-content" hidden>
    <p class="empty">内容替换使用 VSCode 原生搜索。</p>
    <button id="btn-native" class="go">在原生搜索中查找</button>
  </div>
</div>`;

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8" />
<link rel="stylesheet" href="media/panel.css" />
<title>layout-check</title></head>
<body>
<script>
  window.__sent = [];
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => window.__sent.push(m),
    getState: () => null,
    setState: () => {},
  });
  window.__scenarios = ${JSON.stringify(SCENARIOS)};
  window.__inject = (i) => {
    const s = window.__scenarios[i];
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'previewResult', result: s.result },
    }));
  };
  window.__setWrap = (on) => {
    const btn = document.getElementById('btn-wrap');
    if (btn && btn.classList.contains('on') !== !!on) btn.click();
  };
<\/script>
${SKELETON}
<script src="media/panel.js"><\/script>
</body></html>`;

const HTML_PATH = path.join(ROOT, 'tmp-layout-check.html');
fs.writeFileSync(HTML_PATH, html, 'utf8');

/* --------------------------- 3. 启浏览器 --------------------------- */

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((p) => { try { return fs.existsSync(p); } catch { return false; } });

if (BROWSERS.length === 0) {
  console.log('未找到 Chrome/Edge，跳过布局检查（这不影响 npm test）。');
  fs.unlinkSync(HTML_PATH);
  process.exit(0);
}

const PORT = 9411;
const PROFILE = path.join(os.tmpdir(), `layout-check-${Date.now()}`);
const browser = spawn(BROWSERS[0], [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-networking', '--allow-file-access-from-files',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTarget() {
  for (let i = 0; i < 80; i++) {
    await sleep(200);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const t = list.find((x) => x.type === 'page');
      if (t) return t;
    } catch { /* 还没起来 */ }
  }
  throw new Error('CDP target 超时');
}

class CDP {
  constructor(url) {
    this.id = 0; this.pending = new Map();
    this.ws = new WebSocket(url);
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', () => rej(new Error('CDP 连接失败')));
    });
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    const p = new Promise((res, rej) => this.pending.set(id, { res, rej }));
    this.ws.send(JSON.stringify({ id, method, params }));
    return p;
  }
}

let pass = 0; let fail = 0;
const check = (label, ok, extra) => {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${extra ? `  → ${extra}` : ''}`); }
};

const MEASURE = `(() => {
  const list = document.querySelector('#list');
  const names = [...list.querySelectorAll('.row')].map((el) => {
    const n = el.querySelector('.names');
    const oldEl = el.querySelector('.name-old');
    const newEl = el.querySelector('.name-new');
    const lh = n ? parseFloat(getComputedStyle(n).lineHeight) : 0;
    const rowRight = el.getBoundingClientRect().right;
    const trunc = (e) => (e ? e.scrollWidth > e.clientWidth + 1 : null);
    return {
      text: el.textContent.replace(/\\s+/g, ' ').trim(),
      container: el.classList.contains('container'),
      group: el.classList.contains('group'),
      rowH: Math.round(el.getBoundingClientRect().height),
      lines: n && lh ? Math.round(n.getBoundingClientRect().height / lh) : 0,
      // 截断判定用 scrollWidth > clientWidth：只有当元素本身**可以被压窄**时它才有效。
      // （曾用 getBoundingClientRect().right 判定，但元素被 overflow:hidden 压到合适宽度后，
      //   盒子的右边界永远落在行内 → 恒为 false，检不出文字被省略。）
      oldTrunc: trunc(oldEl),
      newTrunc: trunc(newEl),
      // 兜底：盒子本身就越界（没有任何裁剪生效）—— 这才是真正"撑破行宽"
      oldBleeds: oldEl ? oldEl.getBoundingClientRect().right > rowRight + 1 : null,
      newBleeds: newEl ? newEl.getBoundingClientRect().right > rowRight + 1 : null,
      oldText: oldEl ? oldEl.textContent : null,
      newText: newEl ? newEl.textContent : null,
    };
  });
  return { names, listOverflowX: list.scrollWidth > list.clientWidth + 1 };
})()`;

async function run() {
  const target = await getTarget();
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  const evalJs = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 抛错');
    return r.result.value;
  };

  // 侧边栏实测宽度（用户截图 493px @2x ≈ 246 CSS px）
  const WIDTH = 246;
  await cdp.send('Emulation.setDeviceMetricsOverride',
    { width: WIDTH, height: 620, deviceScaleFactor: 2, mobile: false });

  await cdp.send('Page.navigate', { url: 'file:///' + HTML_PATH.replace(/\\/g, '/') });
  for (let i = 0; i < 60; i++) {
    await sleep(150);
    if (await evalJs('typeof window.__inject === "function" && !!document.querySelector("#list")')) break;
  }

  const rowsVisible = await evalJs('document.querySelectorAll("#list .row").length === 0');
  check('初始状态列表为空', rowsVisible);

  /*
   * 预检：panel.js 引用的每个元素 id，都必须存在于本页的骨架里。
   *
   * 这个骨架是**手抄**真实 panelProvider.html() 的，很容易脱节。而一旦缺了元素，
   * `panel.js` 会在 `$('x').addEventListener(...)` 处抛异常；由于那行在初始化代码之前，
   * **整个初始化会静默中断** —— 列表照旧渲染（消息监听已注册），异常只出现在控制台，
   * 极难察觉。（本工具的换行开关就因此第一次跑测试时完全没生效。）
   */
  const panelSrc = fs.readFileSync(path.join(ROOT, 'media', 'panel.js'), 'utf8');
  const neededIds = [...new Set([...panelSrc.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]))];
  const missingIds = await evalJs(
    `${JSON.stringify(neededIds)}.filter((id) => !document.getElementById(id))`
  );
  check(
    `测试骨架包含 panel.js 引用的全部元素（共 ${neededIds.length} 个）`,
    Array.isArray(missingIds) && missingIds.length === 0,
    `缺失：${Array.isArray(missingIds) ? missingIds.join(', ') : String(missingIds)}`
  );

  console.log(`\n面板宽度 ${WIDTH}px（模拟 VSCode 侧边栏）\n`);

  for (let s = 0; s < SCENARIOS.length; s++) {
    const sc = SCENARIOS[s];
    await evalJs(`window.__setWrap(${!!sc.wrap})`);
    await evalJs(`window.__inject(${s})`);
    await sleep(120);
    const m = await evalJs(MEASURE);

    const leaves = m.names.filter((r) => !r.container && !r.group);
    if (leaves.length === 0) {
      console.log('   （本场景没有叶子行，跳过断言）\n');
      continue;
    }

    console.log(`── 场景 ${s + 1}：${sc.name}（${m.names.length} 行，其中叶子 ${leaves.length}）──`);
    for (const r of m.names) {
      const kind = r.container ? '目录分组' : r.group ? '改名头' : '叶子';
      const state = r.group || r.container
        ? ''
        : `${r.newTrunc ? '新名截断' : '新名完整'}${r.oldTrunc ? ' / 旧名让位' : ''}`;
      console.log(`   ${String(r.rowH).padStart(3)}px ${String(r.lines)}行 ${kind} ${state}`);
    }

    if (sc.wrap) {
      // 换行模式的契约与紧凑模式**正好相反**：必须真的折行，且不再截断任何一侧
      check('换行模式下确实折行了（行数 ≥ 2）', leaves.some((r) => r.lines >= 2));
      check('换行模式下旧名不再被截断', leaves.every((r) => r.oldTrunc === false),
        leaves.filter((r) => r.oldTrunc).map((r) => r.oldText).join(' | '));
      check('换行模式下新名仍完整', leaves.every((r) => r.newTrunc === false));
    } else {
      // 紧凑模式的底线：单行（「折成三四行」是我们专门修过的回归）
      check('紧凑模式：所有叶子行都是单行', leaves.every((r) => r.lines <= 1));
    }

    // 2) 盒子本身都不能越界（裁剪必须生效）
    check(
      '没有元素撑破行宽',
      leaves.every((r) => r.oldBleeds === false && r.newBleeds === false)
    );
    check('行内没有横向溢出', !m.listOverflowX);

    // 3) 方案 B 的核心：新名在正常范围内必须完整可见
    // ⚠️ 用 `=== true` / `=== false` 而不是真值判断：
    //    `!undefined === true` 会让"没配置这个标志"的场景误跑到极端分支 —— 踩过。
    if (sc.expectNewComplete === true) {
      const bad = leaves.filter((r) => r.newTrunc);
      check('新名完整（未被省略）', bad.length === 0, bad.map((r) => `${r.newText}`).join(' | '));
    }

    // 4) 旧名确实是「先让位」的那一侧
    if (sc.expectOldYields === true) {
      check('旧名确实让了位（被省略）', leaves.some((r) => r.oldTrunc));
    }

    // 5) 极端超长时允许截断新名 —— 但必须是"省略号"而不是"溢出"
    if (sc.expectNewComplete === false) {
      check(
        '极长新名走省略号而非撑破行宽',
        leaves.every((r) => r.newTrunc) && !m.listOverflowX
      );
    }

    // 6) 列表头必须单行：窄侧边栏下按钮不能被挤成竖排文字
    //    （加第三个视图按钮时真的踩过 —— 「展开」变成竖排的「展/开」）
    if (s === 0) {
      const head = await evalJs(`(() => {
        const h = document.getElementById('list-head');
        const btns = [...h.querySelectorAll('.mini')];
        const count = document.getElementById('count');
        return {
          headH: Math.round(h.getBoundingClientRect().height),
          maxBtnH: Math.max(0, ...btns.map((b) => Math.round(b.getBoundingClientRect().height))),
          btnCount: btns.length,
          countTruncated: count.scrollWidth > count.clientWidth + 1,
        };
      })()`);
      check('列表头有 3 个视图按钮（展开 / 折叠 / 换行）', head.btnCount === 3, `实际 ${head.btnCount}`);
      check('列表头按钮没有被挤成竖排', head.maxBtnH <= 22, `按钮最高 ${head.maxBtnH}px`);
      console.log(
        `   （列表头高 ${head.headH}px；条目数${head.countTruncated ? '已按需截断' : '完整显示'}）`
      );
    }
    console.log('');
  }

  // 两种模式各截一张，便于肉眼核对（用常规文件名场景，最有代表性）
  for (const shot of [
    { wrap: false, file: 'tmp-layout-check.png', label: '紧凑模式' },
    { wrap: true, file: 'tmp-layout-check-wrap.png', label: '换行模式' },
  ]) {
    await evalJs(`window.__setWrap(${shot.wrap})`);
    await evalJs('window.__inject(0)');
    await sleep(150);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const p = path.join(ROOT, shot.file);
    fs.writeFileSync(p, Buffer.from(data, 'base64'));
    console.log(`截图（${shot.label}）：${p}`);
  }
}

try {
  await run();
} catch (e) {
  console.error('布局检查出错：', e.message);
  fail++;
} finally {
  browser.kill();
  await sleep(300);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* 忽略 */ }
  try { fs.unlinkSync(HTML_PATH); } catch { /* 忽略 */ }
}

console.log('\n================================');
console.log(`通过 ${pass}，失败 ${fail}`);
console.log('================================\n');
process.exit(fail > 0 ? 1 : 0);
