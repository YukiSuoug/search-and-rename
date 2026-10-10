import * as vscode from 'vscode';
import { RenameExecutor } from './core/execute';
import { SearchRenamePanel } from './panelProvider';
import { quickRename } from './quickPick';
import type { ExtensionMode } from './types';

export const MODE_KEY = 'searchRename.mode';
export const HAS_PREVIEW_KEY = 'searchRename.hasPreview';
export const CAN_UNDO_KEY = 'searchRename.canUndo';
/**
 * 焦点是否在面板内的文本框上。
 *
 * 供 keybindings 的 `when: "!searchRename.inputFocus"` 使用，
 * 避免用户在查找框里敲字时按到 Ctrl+Alt+R 误触发重命名流程。
 * 由 `media/panel.js` 在 focus/blur 时 postMessage 上报。
 */
export const INPUT_FOCUS_KEY = 'searchRename.inputFocus';

let executor: RenameExecutor;

export function activate(context: vscode.ExtensionContext): void {
  executor = new RenameExecutor(context);

  const panel = new SearchRenamePanel(context, executor);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SearchRenamePanel.viewType, panel, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // 恢复上次的模式
  const savedMode = context.workspaceState.get<ExtensionMode>(MODE_KEY, 'content');
  void setMode(savedMode, { focus: false });

  context.subscriptions.push(
    vscode.commands.registerCommand('searchRename.openPanel', async () => {
      await setMode('rename', { focus: false });
      await revealPanel(panel);
      panel.post({ type: 'mode', mode: 'rename' });
    }),

    vscode.commands.registerCommand(
      'searchRename.quickRename',
      async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        // explorer/context 触发时：第 1 参是被右键的项，第 2 参是多选的全部项。
        // 命令面板 / 快捷键触发时两者都是 undefined → 走「全工作区」语义。
        const resources = collectResources(uri, uris);
        await quickRename(context, executor, resources);
      }
    ),

    vscode.commands.registerCommand('searchRename.switchToRename', async () => {
      await setMode('rename', { focus: true });
      await revealPanel(panel);
      panel.post({ type: 'mode', mode: 'rename' });
    }),

    vscode.commands.registerCommand('searchRename.switchToContent', async (arg?: { find?: string }) => {
      await setMode('content', { focus: false });
      const find = arg?.find ?? panel.lastFind;
      await vscode.commands.executeCommand('workbench.action.findInFiles', {
        query: find,
        triggerSearch: find.length > 0,
      });
    }),

    vscode.commands.registerCommand('searchRename.refreshPreview', () => {
      panel.requestPreview();
    }),

    vscode.commands.registerCommand('searchRename.executeRename', async () => {
      await panel.executeAll();
    }),

    vscode.commands.registerCommand('searchRename.undoLast', async () => {
      await doUndo();
    })
  );
}

/**
 * 归一化从 explorer/context 传进来的参数。
 *
 * 右键菜单的调用约定比较绕，实测行为是：
 * - 单选一个项 → `(uri, [uri])`，两个参数都有；
 * - 多选 N 个项  → `(被右键的那个 uri, [全部 N 个 uri])`，第 1 参在第 2 参里；
 * - 命令面板/快捷键 → `(undefined, undefined)`。
 *
 * 所以优先用第 2 参（它才是完整选区），退回到第 1 参；都没有就返回 undefined，
 * 由 quickPick 层解释为「全工作区扫描」。
 */
function collectResources(
  uri?: vscode.Uri,
  uris?: vscode.Uri[]
): vscode.Uri[] | undefined {
  const list: vscode.Uri[] = [];
  const seen = new Set<string>();

  const push = (u: unknown): void => {
    if (!u || typeof u !== 'object') return;
    const cand = u as vscode.Uri;
    // 只接受真正的 Uri（有 scheme + fsPath），过滤掉别人塞进来的杂项对象
    if (typeof cand.scheme !== 'string' || typeof cand.fsPath !== 'string') return;
    const key = cand.toString();
    if (seen.has(key)) return;
    seen.add(key);
    list.push(cand);
  };

  if (Array.isArray(uris)) uris.forEach(push);
  push(uri);

  return list.length > 0 ? list : undefined;
}

/**
 * 把面板「带到用户眼前」。
 *
 * 这里不能用单个写死的 workbench 命令：
 *  - `focusAuxiliaryBar` / `focusSecondarySidebar` 只在容器位于副侧边栏时有效；
 *  - 容器位于 Activity Bar（当前配置）时，需要的是点击视图图标的等效命令，
 *    而这个命令是**由 VSCode 按容器 id 动态生成**的：
 *    `workbench.view.extension.<containerId>`（注意是 `view.extension`）。
 *
 * 策略：先试动态生成的那个（对自定义容器最稳），失败再退回到 reveal()。
 * 全程 try/catch —— 用户点了菜单却因为一个可选命令报错弹窗，是最糟糕的体验。
 */
async function revealPanel(panel: SearchRenamePanel): Promise<void> {
  try {
    await vscode.commands.executeCommand('workbench.view.extension.searchAndRename');
  } catch {
    /* 命令不存在（换了容器位置等）时忽略，走下面的兜底 */
  }
  try {
    panel.reveal();
  } catch {
    /* 视图尚未创建时 reveal 可能抛错，忽略 */
  }
}

async function doUndo(): Promise<void> {
  if (!executor.hasUndo()) {
    void vscode.window.showInformationMessage('Search & Rename：没有可撤销的批量重命名记录。');
    return;
  }
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: '撤销批量重命名',
      cancellable: false,
    },
    () => executor.undoLast()
  );
  const failed = result.failed.length;
  await setCanUndo(executor.hasUndo());
  if (failed === 0) {
    void vscode.window.showInformationMessage(`Search & Rename：已撤销 ${result.done} 项。`);
  } else {
    void vscode.window.showWarningMessage(
      `Search & Rename：已撤销 ${result.done} 项，${failed} 项失败（目标被占用或已不存在）。`
    );
  }
}

async function setMode(mode: ExtensionMode, opts: { focus: boolean }): Promise<void> {
  await vscode.commands.executeCommand('setContext', MODE_KEY, mode);
  void opts;
}

export async function setHasPreview(v: boolean): Promise<void> {
  await vscode.commands.executeCommand('setContext', HAS_PREVIEW_KEY, v);
}

export async function setCanUndo(v: boolean): Promise<void> {
  await vscode.commands.executeCommand('setContext', CAN_UNDO_KEY, v);
}

export function deactivate(): void {
  /* noop */
}
