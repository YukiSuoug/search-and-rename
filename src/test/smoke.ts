/**
 * 模块图冒烟测试。
 *
 * 目的：在**不起 VSCode** 的前提下，把整个扩展的 import 图跑一遍，
 * 确保没有运行时导入错误、没有顶层抛异常。
 *
 * 做法：拦截 require('vscode')，返回一个"够用的假 vscode"。
 * 这不是要验证业务逻辑（那是 core.test.ts 的事），而是抓住这类问题：
 *   - 某个模块顶层就调用了不存在的 API（例如 `vscode.Uri.parent`）;
 *   - 循环 import 导致某处拿到 undefined 并在顶层解构；
 *   - 路径写错、文件没编译进去。
 *
 * 这类 bug 的表现恰恰就是用户在 VSCode 里看到的「没有任何反应」——
 * activate() 一抛异常，扩展静默死掉，不弹任何提示。
 */

import * as Module from 'module';
import * as path from 'path';
import * as fs from 'fs';

/* ------------------------- 1. 构造假 vscode ------------------------- */

const fakeUri = (p: string): unknown => ({
  scheme: 'file',
  fsPath: p,
  path: p,
  toString: () => `file://${p}`,
});

const disposable = { dispose: () => undefined };

/** 记录所有注册过的命令，后面核对清单 */
const registeredCommands: string[] = [];
/** 记录 registerWebviewViewProvider 的 viewType */
const registeredViewTypes: string[] = [];

const fakeVscode = {
  Uri: {
    file: (p: string): unknown => fakeUri(p.replace(/\\/g, '/')),
    joinPath: (base: unknown, ...segs: string[]): unknown => {
      const b = (base as { fsPath: string }).fsPath;
      const joined = segs.reduce<string>((acc, s) => {
        if (s === '..') {
          const i = acc.lastIndexOf('/');
          return i <= 0 ? acc : acc.slice(0, i);
        }
        return `${acc}/${s}`;
      }, b);
      return fakeUri(joined);
    },
    parse: (s: string): unknown => fakeUri(s),
  },
  FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
  ThemeIcon: class {
    constructor(public id: string) {}
  },
  ProgressLocation: { Notification: 15, Window: 10, SourceControl: 1 },
  ViewColumn: { Active: -1, One: 1, Two: 2, Beside: -2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  CompletionItemKind: { Text: 0 },
  window: {
    registerWebviewViewProvider: (viewType: string): unknown => {
      registeredViewTypes.push(viewType);
      return disposable;
    },
    createInputBox: () => ({
      show: () => undefined,
      hide: () => undefined,
      dispose: () => undefined,
      onDidChangeValue: () => disposable,
      onDidAccept: () => disposable,
      onDidHide: () => disposable,
      onDidTriggerButton: () => disposable,
    }),
    createQuickPick: () => ({
      show: () => undefined,
      hide: () => undefined,
      dispose: () => undefined,
      onDidAccept: () => disposable,
      onDidHide: () => disposable,
      onDidChangeSelection: () => disposable,
    }),
    showQuickPick: async () => undefined,
    showInputBox: async () => undefined,
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    withProgress: async (_o: unknown, task: Function) => task({ report: () => undefined }, { isCancellationRequested: false, onCancellationRequested: () => disposable }),
    onDidChangeActiveTextEditor: () => disposable,
  },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({
      get: <T>(_k: string, d: T): T => d,
      update: async () => undefined,
    }),
    fs: {
      stat: async () => ({ type: 1 }),
      readDirectory: async () => [],
      rename: async () => undefined,
      isWritableFileSystem: () => true,
    },
    asRelativePath: (u: unknown) => (u as { fsPath: string }).fsPath,
    onWillRenameFiles: () => disposable,
    onDidRenameFiles: () => disposable,
    applyEdit: async () => true,
    openTextDocument: async () => ({}),
  },
  commands: {
    registerCommand: (id: string): unknown => {
      registeredCommands.push(id);
      return disposable;
    },
    executeCommand: async () => undefined,
  },
  languages: {
    registerWorkspaceSymbolProvider: () => disposable,
  },
  Progress: class {},
  CancellationTokenSource: class {
    token = { isCancellationRequested: false, onCancellationRequested: () => disposable };
    cancel(): void {}
    dispose(): void {}
  },
  EventEmitter: class {
    event = () => disposable;
    fire(): void {}
    dispose(): void {}
  },
  RelativePattern: class {
    constructor(public base: unknown, public pattern: string) {}
  },
  WorkspaceEdit: class {
    renameFile(): void {}
    deleteFile(): void {}
    createFile(): void {}
    has(): boolean {
      return false;
    }
  },
  window$: undefined,
};

/* ------------------------- 2. 拦截 require ------------------------- */

/**
 * Node 20+ 把 `Module._load` 变成了不可配置的访问器属性，
 * 既不能赋值、也不能 defineProperty 覆盖。
 *
 * 所以改从**更外层的入口**拦截：`Module.prototype.require`。
 * 它才是用户代码里 `require('vscode')` 实际走的那条路，
 * 语义上比 `_load` 更贴近我们要模拟的场景。
 * 注意要在每个模块被 require 之前装好，且必须还原（避免污染后续测试）。
 */
const proto = Module.prototype as unknown as { require: (id: string) => unknown };
const originalRequire = proto.require;
proto.require = function (this: unknown, id: string): unknown {
  if (id === 'vscode') {
    return fakeVscode;
  }
  return originalRequire.call(this, id);
};

/* ------------------------- 3. 断言脚手架 ------------------------- */

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, extra?: string): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${extra ? `  → ${extra}` : ''}`);
  }
}

const OUT = path.join(__dirname, '..');

function load(relative: string): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(path.join(OUT, relative)) as Record<string, unknown>;
}

/* ------------------------- 4. 跑起来 ------------------------- */

console.log('\n[smoke] 模块图冒烟测试\n');

console.log('— 逐个模块 require，检查顶层是否可执行 —');
const modules = [
  'types',
  'core/glob',
  'core/regex',
  'core/plan',
  'core/conflict',
  'core/tree',
  'core/walk',
  'core/preview',
  'core/execute',
  'panelProvider',
  'quickPick',
  'extension',
];
for (const m of modules) {
  try {
    load(m);
    check(`require ${m}`, true);
  } catch (e) {
    check(`require ${m}`, false, (e as Error).message);
  }
}

console.log('\n— 扩展入口导出完整性 —');
const ext = load('extension');
check('activate 是函数', typeof ext.activate === 'function');
check('deactivate 是函数', typeof ext.deactivate === 'function');
check('导出了 MODE_KEY', typeof ext.MODE_KEY === 'string');
check('导出了 HAS_PREVIEW_KEY', typeof ext.HAS_PREVIEW_KEY === 'string');
check('导出了 CAN_UNDO_KEY', typeof ext.CAN_UNDO_KEY === 'string');

console.log('\n— 调用 activate()，核对注册结果 —');
try {
  const ctx = {
    subscriptions: [] as unknown[],
    workspaceState: {
      get: <T>(_k: string, d: T): T => d,
      update: async () => undefined,
    },
    globalState: {
      get: <T>(_k: string, d: T): T => d,
      update: async () => undefined,
    },
    extensionUri: fakeUri('/ext'),
    extensionPath: '/ext',
    asAbsolutePath: (p: string) => `/ext/${p}`,
  };
  (ext.activate as (c: unknown) => void)(ctx);
  check('activate() 未抛异常', true);
  check('注册了 webview view provider', registeredViewTypes.length === 1, `实际 ${registeredViewTypes.length}`);
  check(
    'viewType 与 package.json 的 views 配置一致',
    registeredViewTypes[0] === 'searchRename.panel',
    `实际 ${registeredViewTypes[0]}`
  );

  const expected = [
    'searchRename.openPanel',
    'searchRename.quickRename',
    'searchRename.switchToRename',
    'searchRename.switchToContent',
    'searchRename.refreshPreview',
    'searchRename.executeRename',
    'searchRename.undoLast',
  ];
  for (const cmd of expected) {
    check(`注册命令 ${cmd}`, registeredCommands.includes(cmd));
  }
} catch (e) {
  check('activate() 未抛异常', false, (e as Error).message);
}

console.log('\n— package.json 与运行时常量一致性 —');
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pkg = require(path.join(OUT, '..', 'package.json')) as {
    contributes: {
      viewsContainers?: Record<string, { id: string }[]>;
      views?: Record<string, { id: string; type?: string }[]>;
      menus?: Record<string, { command: string }[]>;
      commands?: { command: string }[];
    };
    engines?: { vscode?: string };
  };

  const containers = Object.keys(pkg.contributes.viewsContainers ?? {});
  check(
    'viewsContainers 只用了合法位置键',
    containers.every((k) => ['activitybar', 'panel', 'secondarySidebar'].includes(k)),
    `实际 ${containers.join(',')}`
  );
  check('没有非法的 auxiliarybar', !containers.includes('auxiliarybar'));

  // views 的 key 有两种合法形态：
  //   ① 某个自定义容器的 id（来自 viewsContainers.<position>[].id）
  //   ② 内置容器名（explorer / scm / debug / test）
  // 常见错误恰恰是把 ② 写成 "search"，或把 ① 写成位置名（如 "auxiliarybar"）。
  const containerIds = new Set<string>();
  for (const list of Object.values(pkg.contributes.viewsContainers ?? {})) {
    for (const c of list) {
      containerIds.add(c.id);
    }
  }
  const builtinContainers = ['explorer', 'scm', 'debug', 'test'];
  for (const key of Object.keys(pkg.contributes.views ?? {})) {
    check(
      `views["${key}"] 指向合法的宿主容器`,
      containerIds.has(key) || builtinContainers.includes(key),
      `既不是自定义容器 id（${[...containerIds].join(',')}），也不是内置容器（${builtinContainers.join(',')}）`
    );
  }

  // webview 类型视图必须有对应的 registerWebviewViewProvider
  for (const [, list] of Object.entries(pkg.contributes.views ?? {})) {
    for (const v of list) {
      if (v.type === 'webview') {
        check(`webview 视图 ${v.id} 已在运行时注册`, registeredViewTypes.includes(v.id));
      }
    }
  }

  // 每个 menus 里引用的命令都必须在 commands 里声明过
  const declared = new Set((pkg.contributes.commands ?? []).map((c) => c.command));
  for (const [where, list] of Object.entries(pkg.contributes.menus ?? {})) {
    for (const item of list) {
      check(`${where} → ${item.command} 已声明`, declared.has(item.command), '命令未在 contributes.commands 中声明');
    }
  }

  // 每个 menus 里引用的命令也必须在运行时注册过
  for (const [where, list] of Object.entries(pkg.contributes.menus ?? {})) {
    for (const item of list) {
      check(`${where} → ${item.command} 已注册`, registeredCommands.includes(item.command));
    }
  }

  check('声明了 explorer/context 菜单', 'explorer/context' in (pkg.contributes.menus ?? {}));
  check(
    'explorer/context 挂了 quickRename',
    (pkg.contributes.menus?.['explorer/context'] ?? []).some((m) => m.command === 'searchRename.quickRename')
  );

  /* ------------------------- 快捷键冲突校验 ------------------------- */

  // 背景：Ctrl+Alt+Shift+R 是 VSCode 内置的 workbench.action.showAllSymbols。
  // 扩展贡献的同键绑定在不做处理时**抢不过内置命令**，用户按下去会跳到别的视图，
  // 表现为"这个快捷键打不开我的面板"。必须用 `-command` 语法显式解绑内置命令。
  const kb = (pkg.contributes as { keybindings?: { command: string; key: string }[] }).keybindings ?? [];

  // VSCode 内置占用 Ctrl+Alt+Shift+R 的命令（踩过的坑，记录下来）
  const BUILTIN_OWNERS: Record<string, string> = {
    'ctrl+alt+shift+r': 'workbench.action.showAllSymbols',
  };

  for (const [key, owner] of Object.entries(BUILTIN_OWNERS)) {
    const ours = kb.filter((k) => k.key === key && !k.command.startsWith('-'));
    if (ours.length === 0) continue;
    const unbind = kb.some((k) => k.key === key && k.command === `-${owner}`);
    check(
      `${key} 已显式解绑内置命令 ${owner}`,
      unbind,
      '不同键则无需处理；同键时必须加 "-' + owner + '" 条目，否则快捷键会被内置命令抢走'
    );
  }

  // 我们自己的命令之间不能有同键冲突（除了解绑项）
  const ownByKey = new Map<string, string[]>();
  for (const k of kb) {
    if (k.command.startsWith('-')) continue;
    const list = ownByKey.get(k.key) ?? [];
    list.push(k.command);
    ownByKey.set(k.key, list);
  }
  for (const [key, cmds] of ownByKey) {
    const dup = cmds.filter((c, i) => cmds.indexOf(c) !== i);
    check(`${key} 在我们自己的命令间无重复绑定`, dup.length === 0, dup.join(','));
  }

  for (const cmd of ['searchRename.openPanel', 'searchRename.quickRename']) {
    check(`${cmd} 至少有一个快捷键`, kb.some((k) => k.command === cmd && !k.command.startsWith('-')));
  }

  // openPanel 必须有备选键：主键被系统/输入法抢占时还有退路
  const openPanelKeys = kb.filter((k) => k.command === 'searchRename.openPanel').map((k) => k.key);
  check('openPanel 有 ≥2 个快捷键（含备选）', openPanelKeys.length >= 2, openPanelKeys.join(','));

  // inputFocus 上下文键：必须在运行时注册过（由 webview 上报）
  check(
    'keybindings 引用的 searchRename.inputFocus 有对应导出',
    typeof (ext as { INPUT_FOCUS_KEY?: string }).INPUT_FOCUS_KEY === 'string'
  );
} catch (e) {
  check('读取 package.json', false, (e as Error).message);
}

/* ------------------------- 6. 前端资源静态检查 ------------------------- */

/**
 * webview 的前端（media/*.js|css）没有测试脚手架，很难做行为测试。
 * 但下面这两类 bug 都**已经复发过**，用源码级断言兜住性价比很高。
 */

console.log('— 前端资源静态检查（防复发）—');
const ROOT = path.join(OUT, '..');
const cssPath = path.join(ROOT, 'media', 'panel.css');
const jsPath = path.join(ROOT, 'media', 'panel.js');

let css = '';
let js = '';
try {
  css = fs.readFileSync(cssPath, 'utf8');
  check('读取 media/panel.css', true);
} catch (e) {
  check('读取 media/panel.css', false, (e as Error).message);
}
try {
  js = fs.readFileSync(jsPath, 'utf8');
  check('读取 media/panel.js', true);
} catch (e) {
  check('读取 media/panel.js', false, (e as Error).message);
}

// ⚠️ 坑 16：只要给元素写了 display，`hidden` 属性就失效（`[hidden]{display:none}` 来自
// 浏览器默认样式表，优先级低于作者样式）。必须有一条全局兜底规则。
check(
  'panel.css 有全局 [hidden] 兜底（防止 display 覆盖导致 hidden 失效）',
  /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(css)
);

// ⚠️ 坑 17：展示路径不能用绝对路径拼。ancestorDiff 曾把 `d:/a/b/c/.../` 刷满每一行。
// 修复后行内不再渲染它（只在 tooltip / QuickPick 里用）。
check(
  'panel.js 不再把 ancestorDiff 渲染进行内（防绝对路径刷屏复发）',
  !/classList\.add\('ancestor'\)|className\s*=\s*'ancestor'/.test(js)
);

// 容器头（目录分组）不是可执行条目，它的 key 是 `dir::xxx` 合成值。
// 若忘了排除，执行层会拿到一个假路径。
check(
  'panel.js 的 getSelectedKeys 排除容器头',
  /dataset\.container\s*!==\s*'1'/.test(js)
);
check(
  'panel.js 选中计数排除容器头',
  /:not\(\[data-container="1"\]\)/.test(js)
);

// 名字行必须"永远一行"，且**新名优先**。
// 演进史（两次都踩过，所以这里钉死机制而不是钉死具体数值）：
//   ① `flex-wrap: wrap` → 长名字折成三四行，太挤；
//   ② 整行 `nowrap + text-overflow: ellipsis` → 不折行了，但把新名截掉（`→ ot_bo…`）。
// 现在的机制：缺口按 `flex-shrink × base 宽度` 分摊，旧名系数远大于新名 → 旧名先让位。
const oldRule = /\.name-old\s*\{([^}]*)\}/s.exec(css);
const newRule = /\.name-new\s*\{([^}]*)\}/s.exec(css);
check('panel.css 有 .name-old / .name-new 两条规则', oldRule !== null && newRule !== null);

const shrinkOf = (body: string | undefined): number => {
  const m = body ? /flex:\s*[\d.]+\s+([\d.]+)\s+\S+/.exec(body) : null;
  return m ? Number(m[1]) : NaN;
};
const oldShrink = shrinkOf(oldRule?.[1]);
const newShrink = shrinkOf(newRule?.[1]);

check(
  '旧名的收缩权重远大于新名（保证"旧名先让位"）',
  Number.isFinite(oldShrink) && Number.isFinite(newShrink) && oldShrink >= newShrink * 10,
  `old=${oldShrink} new=${newShrink}`
);
check(
  '旧名可省略（overflow + ellipsis）',
  !!oldRule && /overflow:\s*hidden/.test(oldRule[1]) && /text-overflow:\s*ellipsis/.test(oldRule[1])
);
// 新名必须**保留**可收缩 + 省略号：否则新名长到超过整行时会顶破行宽。
// （实测踩过：`flex: 0 0 auto` 的新名会硬撑出横向溢出。）
check(
  '新名保留可收缩 + 省略号（超长时优雅降级而非溢出）',
  !!newRule && /min-width:\s*0/.test(newRule[1]) && /text-overflow:\s*ellipsis/.test(newRule[1])
);
check(
  'panel.css 的名字行是 nowrap（不再折行）',
  /\.row \.names\s*\{[^}]*white-space:\s*nowrap/s.test(css)
);
// 换行模式是**可选**的，默认必须关：紧凑模式下行高统一才好快速扫视，
// 而且紧凑模式下「新名已经永远完整」，被省略的只有旧名。
// 这里钉住四件事：规则存在、确实放开了截断、状态被持久化、默认是 false。
check('panel.css 有换行模式规则（.list.wrap）', /\.list\.wrap\s+\.names\s*\{/s.test(css));
check(
  'panel.css 换行模式放开了两侧截断',
  /\.list\.wrap\s+\.name-new\s*\{[^}]*overflow:\s*visible/s.test(css)
);
check('panel.js 有换行开关 applyWrap', /function applyWrap\s*\(/.test(js));
check('panel.js 换行状态被持久化', /wrap:\s*state\.wrap/.test(js));
check('panel.js 换行默认关闭', /wrap:\s*false/.test(js));
check('panel.js 启动时会应用换行状态', /applyWrap\(\);/.test(js));

// 叶子行不再画图标（树里叶子必然是文件，图标是冗余信息，还占 ~16px）
check(
  'panel.js 不再给叶子行加文件图标',
  !/row\.isDirectory\s*\?\s*'📁'\s*:\s*'📄'/.test(js)
);

// ⚠️ 最关键的一条：**前端脚本引用的每个元素 id，都必须真实存在于 webview HTML 里**。
//
// 踩过的坑：`tools/layout-check.mjs` 里的面板骨架是手抄的，加了新元素却忘了同步，
// 结果 `panel.js` 在 `$('btn-wrap').addEventListener(...)` 处抛异常 ——
// 而那行在初始化代码**之前**，于是整个初始化静默中断（列表照旧渲染，所以看不出异常）。
// 这类"元素不存在 → 整段脚本挂掉"的问题，靠这条交叉核对可以彻底堵住。
console.log('\n— webview HTML × 前端脚本 的元素 id 交叉核对 —');
try {
  const mod = load('panelProvider') as { SearchRenamePanel: { prototype: object } };
  const proto = mod.SearchRenamePanel.prototype as { html: (w: unknown) => string };

  const fakePanel = Object.create(proto) as Record<string, unknown>;
  fakePanel.ctx = { extensionUri: fakeUri('/ext') };
  const fakeWebview = { asWebviewUri: () => 'RESOURCE', cspSource: 'vscode-resource:' };

  const panelHtml = proto.html.call(fakePanel, fakeWebview);
  check('能取到 webview HTML', panelHtml.includes('<div id="root">'));

  const htmlIds = new Set([...panelHtml.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const jsIds = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));

  check('panel.js 里能解析出元素引用', jsIds.size > 0, `解析到 ${jsIds.size} 个`);

  const missing = [...jsIds].filter((id) => !htmlIds.has(id));
  check(
    'panel.js 引用的元素在 HTML 里都存在',
    missing.length === 0,
    `缺失：${missing.join(', ')}（新增元素时忘了同步 panelProvider.html()？）`
  );

  // 反向：按钮类的元素不该是"定义了但前端从没引用"——多半是拼错了 id
  const unusedButtons = [...htmlIds].filter(
    (id) => id.startsWith('btn-') && id !== 'btn-native' && !jsIds.has(id)
  );
  check('没有定义了却没人引用的按钮 id', unusedButtons.length === 0, unusedButtons.join(', '));
} catch (e) {
  check('webview HTML 交叉核对', false, (e as Error).message);
}

/* ------------------------- 5. 汇总 ------------------------- */

console.log('\n================================');
console.log(`通过 ${pass}，失败 ${fail}`);
console.log('================================\n');

if (fail > 0) {
  process.exit(1);
}
