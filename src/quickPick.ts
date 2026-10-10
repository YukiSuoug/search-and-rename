/**
 * 批量重命名主流程（右键菜单入口）。
 *
 * 交互链：
 *   右键「按名称批量重命名…」
 *     → 输入查找名（带语法提示 + 实时校验）
 *     → 输入替换名
 *     → 选择匹配选项
 *     → （若右键的是文件夹且范围含文件夹）询问是否连该文件夹自身一起改
 *     → QuickPick 展示预览（树形缩进 + 冲突标注 + 祖先高亮）
 *     → 执行
 *
 * 范围：仅扫描用户选中的目录子树，不扫全工作区。
 */

import * as vscode from 'vscode';
import { buildPreview, type PreviewOptions } from './core/preview';
import { compilePattern, validateName } from './core/regex';
import { RenameExecutor } from './core/execute';
import { setCanUndo } from './extension';
import type { MatchOptions, RenamePair, TreeRow } from './types';

interface RenameQuickPickItem extends vscode.QuickPickItem {
  fsPath: string;
  newName: string;
  isDirectory: boolean;
  blocking: boolean;
  /** 这是「目录分组头」而非可执行条目（用 Separator 渲染，永不被选中） */
  container: boolean;
}

const COMMON_EXT = ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'css', 'scss', 'html', 'md'];

export interface ScopeInfo {
  /** 选中的目录（扫描根） */
  roots: vscode.Uri[];
  /** 选中的项里含有文件夹 */
  hasDirectory: boolean;
  /** 选中的项里含有文件 */
  hasFile: boolean;
  /** 选中的文件夹自身（供"是否连自身一起改"询问用） */
  selectedDirs: vscode.Uri[];
  /** 展示用的范围描述 */
  label: string;
}

/**
 * 从 Explorer 的右键参数解析出作用范围。
 *
 * 关键点：**必须 stat 才能区分文件与文件夹**（不能靠扩展名猜）。
 * 语义设计：
 * - 选中一个文件夹 → 扫描它**内部**的子树（这正是"批量重命名"最常见的诉求）；
 * - 选中一个文件   → 只把它的**父目录**当作扫描根，再按名称过滤命中它。
 *
 * 两种情况的差别只体现在 `includeRootsThemselves`：文件夹自身是否也参与匹配。
 */
export async function resolveScope(
  resources: vscode.Uri[] | undefined
): Promise<ScopeInfo | undefined> {
  if (!resources || resources.length === 0) {
    return undefined;
  }

  const selectedDirs: vscode.Uri[] = [];
  const parentMap = new Map<string, vscode.Uri>();
  let hasFile = false;

  const addParent = (uri: vscode.Uri): void => {
    const parent = vscode.Uri.joinPath(uri, '..');
    parentMap.set(parent.toString(), parent);
  };

  for (const uri of resources) {
    let isDir = false;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      isDir = (stat.type & vscode.FileType.Directory) !== 0;
    } catch {
      // stat 失败（文件被删/无权限）时不臆测类型，按文件处理其父目录
      isDir = false;
    }

    if (isDir) {
      selectedDirs.push(uri);
      // 扫描它的内部
      parentMap.set(uri.toString(), uri);
    } else {
      hasFile = true;
      addParent(uri);
    }
  }

  const roots = [...parentMap.values()];

  const label =
    resources.length === 1
      ? vscode.workspace.asRelativePath(resources[0], false) || resources[0].fsPath
      : `${resources.length} 个位置`;

  return { roots, hasDirectory: selectedDirs.length > 0, hasFile, selectedDirs, label };
}

export async function quickRename(
  _ctx: vscode.ExtensionContext,
  executor: RenameExecutor,
  resources?: vscode.Uri[]
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('searchAndRename');
  const scope = await resolveScope(resources);

  // 1. 查找名
  const find = await promptPattern(scope);
  if (!find) {
    return;
  }

  // 2. 替换名
  const replace = await vscode.window.showInputBox({
    title: 'Search & Rename：替换为（2/3）',
    prompt: '支持 $1 捕获组、$& 整体匹配、$$ 字面 $',
    placeHolder: '例如 Button',
    value: '',
    ignoreFocusOut: true,
  });
  if (replace === undefined) {
    return;
  }

  // 3. 匹配选项
  const options = await promptOptions(cfg, find, replace);
  if (!options) {
    return;
  }

  // 4. 范围细化：若选中的是文件夹，询问"该文件夹自身是否也参与改名"
  const includeRootsThemselves = await promptIncludeRoots(scope, options);

  // 5. 预览
  const full = makePreviewOptions(cfg, options, scope, includeRootsThemselves);
  const preview = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: scope ? `Search & Rename：扫描 ${scope.label}…` : 'Search & Rename：扫描工作区…',
      cancellable: true,
    },
    (_progress, token) => buildPreview(full, token)
  );

  if (preview.rows.length === 0) {
    void vscode.window.showInformationMessage('Search & Rename：没有匹配到可重命名的名称。');
    return;
  }

  // 6. 选择要执行的项
  const picked = await showPreviewQuickPick(preview.rows, preview.items.length, preview.conflictCount);
  if (!picked || picked.length === 0) {
    return;
  }

  // 7. 执行
  await runRename(picked, cfg, executor);
}

/* ----------------------------- 步骤 1 ----------------------------- */

async function promptPattern(scope: ScopeInfo | undefined): Promise<string | undefined> {
  const box = vscode.window.createInputBox();
  box.title = 'Search & Rename：查找名称（1/3）';
  box.prompt = scope ? `范围：${scope.label}` : '范围：整个工作区';
  box.placeholder = '例如 Buttom';
  box.ignoreFocusOut = true;
  box.buttons = [{ iconPath: new vscode.ThemeIcon('info'), tooltip: '语法说明' }];

  box.onDidTriggerButton(() => {
    void vscode.window.showInformationMessage(
      '匹配的是文件/文件夹「名称」，不是文件内容。\n正则语法由下一步的选项控制；替换串支持 $1 / $& / $$。'
    );
  });

  return new Promise<string | undefined>((resolve) => {
    let settled = false;
    const done = (v: string | undefined): void => {
      if (settled) {
        return;
      }
      settled = true;
      box.dispose();
      resolve(v);
    };
    box.onDidChangeValue((v) => {
      box.validationMessage = v.trim() === '' ? '请输入要查找的名称片段' : '';
    });
    box.onDidAccept(() => done(box.value.trim() || undefined));
    box.onDidHide(() => done(undefined));
    box.show();
  });
}

/* ----------------------------- 步骤 3 ----------------------------- */

async function promptOptions(
  cfg: vscode.WorkspaceConfiguration,
  find: string,
  replace: string
): Promise<MatchOptions | undefined> {
  const picks = await vscode.window.showQuickPick(
    [
      { label: '$(case-sensitive) 区分大小写', id: 'case' },
      { label: '$(whole-word) 全字匹配', id: 'word' },
      { label: '$(regex) 使用正则表达式', id: 'regex' },
      { label: '$(symbol-constant) 保留大小写', id: 'preserve' },
      { label: '$(file-directory) 只匹配文件夹', id: 'folders' },
      { label: '$(file) 只匹配文件', id: 'files' },
    ],
    {
      title: 'Search & Rename：匹配选项（3/3，可多选，直接回车继续）',
      canPickMany: true,
      ignoreFocusOut: true,
    }
  );
  if (picks === undefined) {
    return undefined;
  }

  const ids = new Set(picks.map((p) => (p as { id: string }).id));
  const options: MatchOptions = {
    find,
    replace,
    isRegex: ids.has('regex'),
    caseSensitive: ids.has('case'),
    wholeWord: ids.has('word'),
    preserveCase: ids.has('preserve'),
    preserveExtension: cfg.get<boolean>('preserveExtension', true),
    matchTarget: ids.has('folders') ? 'foldersOnly' : ids.has('files') ? 'filesOnly' : 'both',
  };

  // 实时校验：能匹配空串的正则会被后续拒绝，这里提前告知
  const { matchesEmpty } = compilePattern(find, {
    isRegex: options.isRegex,
    caseSensitive: options.caseSensitive,
    wholeWord: options.wholeWord,
  });
  if (matchesEmpty) {
    void vscode.window.showErrorMessage(
      'Search & Rename：该表达式会匹配空字符串（如 .* 或 ^），无法用于名称替换。'
    );
    return undefined;
  }

  return options;
}

/* ----------------------------- 步骤 4 ----------------------------- */

/**
 * 当右键的是文件夹、且匹配范围允许文件夹时，问一句"这个文件夹本身要不要也改名"。
 *
 * 为什么值得单独问：右键 `src/` 输入 `src` 时，用户的意图可能是
 *   ①「把 src 改掉」，也可能是 ②「src 不用动，只改里面的文件」。
 * 猜错一次就是一次误操作，所以宁可多问一句。用两行 QuickPick 而不是 modal ，
 * 是为了不打断键盘流（回车即选第一项）。
 */
async function promptIncludeRoots(
  scope: ScopeInfo | undefined,
  options: MatchOptions
): Promise<boolean> {
  if (!scope || !scope.hasDirectory || scope.selectedDirs.length === 0) {
    return true;
  }
  if (options.matchTarget === 'filesOnly') {
    return true;
  }

  const dirsLabel = scope.selectedDirs
    .map((d) => `「${vscode.workspace.asRelativePath(d, false) || d.fsPath}」`)
    .join('、');

  const pick = await vscode.window.showQuickPick(
    [
      { label: '$(check) 一起处理', detail: `范围包含 ${dirsLabel} 自身及其内部全部子项` },
      { label: '$(arrow-down) 只处理内部', detail: `保留 ${dirsLabel} 不变，只重命名其内部的文件/文件夹` },
    ],
    {
      title: 'Search & Rename：范围（4/4）',
      placeHolder: '选中的是文件夹，是否连它本身一起重命名？',
      ignoreFocusOut: true,
    }
  );
  if (pick === undefined) {
    // 用户按 Esc —— 视作"只处理内部"，这是更保守的一侧
    return false;
  }
  return pick.label.includes('一起处理');
}

/* ----------------------------- 步骤 5 ----------------------------- */

/**
 * 用 QuickPick 展示树形预览。
 *
 * QuickPick 不支持真正的树，这里：
 *  - 用缩进（全角空格）表达层级；
 *  - 「目录头」用 `QuickPickItemKind.Separator` 渲染 —— 它天然**不可选中**，
 *    正好符合容器头的语义（只是分组，不是待重命名的条目）。
 *
 * ⚠️ 容器行的 `key` 是 `dir::<相对路径>` 合成值而非真实 fsPath，
 * 一旦被当成待执行项传下去就会去重命名一个不存在的路径。用 Separator 从根上避免。
 */
async function showPreviewQuickPick(
  rows: TreeRow[],
  itemCount: number,
  conflictCount: number
): Promise<RenameQuickPickItem[] | undefined> {
  const qp = vscode.window.createQuickPick<RenameQuickPickItem>();
  qp.title =
    `Search & Rename：${itemCount} 项待重命名` +
    (conflictCount > 0 ? `（${conflictCount} 项冲突，默认不勾选）` : '');
  qp.placeholder = '空格或回车确认选择；取消则不执行';
  qp.canSelectMany = true;
  qp.ignoreFocusOut = true;

  const items: RenameQuickPickItem[] = [];
  for (const row of rows) {
    if (row.isContainer) {
      items.push({
        // Separator 只用到 label；其余字段仅为满足类型
        kind: vscode.QuickPickItemKind.Separator,
        label: `📁 ${row.relPath}`,
        description: '',
        detail: undefined,
        fsPath: '',
        newName: '',
        isDirectory: true,
        blocking: false,
        container: true,
      });
      continue;
    }
    items.push(toQuickPickItem(row));
  }

  qp.items = items;
  qp.selectedItems = items.filter((i) => !i.blocking && !i.container);

  const picked = await new Promise<RenameQuickPickItem[] | undefined>((resolve) => {
    qp.onDidAccept(() => resolve([...qp.selectedItems]));
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  qp.dispose();
  // 双保险：即便某个 VSCode 版本把 Separator 也算进 selectedItems，这里也拦掉
  return picked?.filter((p) => !p.container);
}

function toQuickPickItem(row: TreeRow): RenameQuickPickItem {
  const blocking =
    row.conflict === 'targetExists' ||
    row.conflict === 'duplicateTarget' ||
    row.conflict === 'invalidName';

  const indent = '　'.repeat(row.depth); // 全角空格，缩进视觉更明显
  const icon = row.isDirectory ? '$(file-directory)' : '$(file)';
  const warn = row.conflict ? '$(warning) ' : '';
  const suffix = row.isGroup && row.childConflictCount
    ? `\u00a0\u00a0⚠ 子树内 ${row.childConflictCount} 项冲突`
    : '';

  // 行内只显示文件名（目录已由 Separator 头给出）；完整路径放到 detail
  const name = basename(row.relPath);
  const hint = row.dirHint ? `${row.dirHint}/` : '';

  return {
    label: `${indent}${warn}${icon} ${hint}${name}`,
    description: `${row.oldName} → ${row.newName}${suffix}`,
    detail: row.conflictMessage ? `⚠ ${row.conflictMessage}` : dirOf(row.relPath),
    fsPath: row.key,
    newName: row.newName,
    isDirectory: row.isDirectory,
    blocking,
    container: false,
  };
}

/* ----------------------------- 步骤 6 ----------------------------- */

async function runRename(
  picked: RenameQuickPickItem[],
  cfg: vscode.WorkspaceConfiguration,
  executor: RenameExecutor
): Promise<void> {
  // 只读 / 虚拟文件系统守卫
  for (const p of picked) {
    const uri = vscode.Uri.file(p.fsPath);
    if (vscode.workspace.fs.isWritableFileSystem(uri.scheme) === false) {
      void vscode.window.showErrorMessage(
        `Search & Rename：文件系统 ${uri.scheme} 不可写，无法重命名。`
      );
      return;
    }
  }

  const threshold = cfg.get<number>('confirmThreshold', 15);
  if (picked.length > threshold) {
    const sure = await vscode.window.showWarningMessage(
      `将要重命名 ${picked.length} 个文件/文件夹，是否继续？`,
      { modal: true },
      '继续'
    );
    if (sure !== '继续') {
      return;
    }
  }

  // 先深后浅，避免父目录改名后子路径失效
  const pairs: RenamePair[] = picked
    .map((p) => ({
      fromPath: p.fsPath,
      toPath: joinName(p.fsPath, p.newName),
      fromUri: toUriStr(p.fsPath),
      toUri: toUriStr(joinName(p.fsPath, p.newName)),
      oldName: basename(p.fsPath),
      newName: p.newName,
      relPath: vscode.workspace.asRelativePath(vscode.Uri.file(p.fsPath), false),
      isDirectory: p.isDirectory,
    }))
    .sort((a, b) => depth(b.fromPath) - depth(a.fromPath));

  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: '重命名文件/文件夹',
      cancellable: true,
    },
    (progress, token) => executor.execute(pairs, token, progress)
  );

  await setCanUndo(executor.hasUndo());

  if (result.failed.length === 0 && !result.cancelled) {
    const pick = await vscode.window.showInformationMessage(`已重命名 ${result.done} 项。`, '撤销');
    if (pick === '撤销') {
      await vscode.commands.executeCommand('searchRename.undoLast');
    }
  } else {
    void vscode.window.showWarningMessage(
      `已重命名 ${result.done} 项，${result.failed.length} 项失败${
        result.cancelled ? '（已取消）' : ''
      }。`
    );
  }
}

/* ----------------------------- helpers ----------------------------- */

export function makePreviewOptions(
  cfg: vscode.WorkspaceConfiguration,
  options: MatchOptions,
  scope: ScopeInfo | undefined,
  includeRootsThemselves: boolean
): PreviewOptions {
  return {
    ...options,
    respectExclude: cfg.get<boolean>('respectExclude', true),
    extraExclude: cfg.get<string[]>('extraExclude', []),
    maxEntries: cfg.get<number>('maxEntries', 200000),
    roots: scope?.roots,
    includeRootsThemselves,
  };
}

export { validateName, COMMON_EXT };

function joinName(fsPath: string, newName: string): string {
  const norm = fsPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const i = norm.lastIndexOf('/');
  return i < 0 ? newName : `${norm.slice(0, i + 1)}${newName}`;
}

function depth(p: string): number {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').split('/').length;
}

function basename(p: string): string {
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const i = norm.lastIndexOf('/');
  return i < 0 ? norm : norm.slice(i + 1);
}

/** 相对路径的目录部分（无分隔符 → ''） */
function dirOf(p: string): string {
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const i = norm.lastIndexOf('/');
  return i < 0 ? '' : norm.slice(0, i);
}
function toUriStr(fsPath: string): string {
  const norm = fsPath.replace(/\\/g, '/');
  const withSlash = norm.startsWith('/') ? norm : `/${norm}`;
  return encodeURI(`file://${withSlash}`);
}
