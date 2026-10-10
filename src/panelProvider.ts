import * as vscode from 'vscode';
import { buildPreview, type PreviewOptions } from './core/preview';
import { toPosix } from './core/plan';
import { RenameExecutor } from './core/execute';
import { setCanUndo, setHasPreview, INPUT_FOCUS_KEY } from './extension';
import type {
  ExecuteResult,
  FromWebviewMessage,
  MatchOptions,
  PreviewResult,
  RenamePair,
  ToWebviewMessage,
  UiConfig,
} from './types';

export class SearchRenamePanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'searchRename.panel';

  private view?: vscode.WebviewView;
  private lastPreview?: PreviewResult;
  private previewAbort?: vscode.CancellationTokenSource;

  /** 供 switchToContent 复用：最近一次查找串 */
  public lastFind = '';
  public lastOptions: MatchOptions = defaultMatchOptions();

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly executor: RenameExecutor
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.ctx.extensionUri],
    };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage((msg: FromWebviewMessage) => {
      void this.onMessage(msg, view);
    });

    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.post({ type: 'options', options: this.lastOptions, config: this.uiConfig() });
      }
    });

    void setCanUndo(this.executor.hasUndo());
  }

  reveal(): void {
    this.view?.show?.(true);
  }

  post(msg: ToWebviewMessage): void {
    void this.view?.webview.postMessage(msg);
  }

  private uiConfig(): UiConfig {
    const cfg = vscode.workspace.getConfiguration('searchAndRename');
    return {
      confirmThreshold: cfg.get<number>('confirmThreshold', 15),
      canUndo: this.executor.hasUndo(),
    };
  }

  private async onMessage(msg: FromWebviewMessage, view: vscode.WebviewView): Promise<void> {
    switch (msg.type) {
      case 'ready': {
        await view.webview.postMessage({
          type: 'options',
          options: this.lastOptions,
          config: this.uiConfig(),
        } satisfies ToWebviewMessage);
        break;
      }
      case 'switchMode': {
        if (msg.mode === 'content') {
          await vscode.commands.executeCommand('searchRename.switchToContent', {
            find: this.lastFind,
          });
        }
        break;
      }
      case 'openNativeSearch': {
        await vscode.commands.executeCommand('workbench.action.findInFiles', {
          query: msg.find,
          triggerSearch: msg.find.length > 0,
        });
        break;
      }
      case 'preview': {
        this.lastOptions = msg.options;
        this.lastFind = msg.options.find;
        await this.doPreview(msg.options);
        break;
      }
      case 'execute': {
        await this.executeKeys(msg.keys);
        break;
      }
      case 'undo': {
        await vscode.commands.executeCommand('searchRename.undoLast');
        break;
      }
      case 'notify': {
        if (msg.level === 'error') {
          void vscode.window.showErrorMessage(msg.message);
        } else if (msg.level === 'warn') {
          void vscode.window.showWarningMessage(msg.message);
        } else {
          void vscode.window.showInformationMessage(msg.message);
        }
        break;
      }
      case 'inputFocus': {
        // webview 内部的 DOM 焦点不会自动同步到 VSCode 上下文键，
        // 这里手动上报，供快捷键的 when 子句使用。
        await vscode.commands.executeCommand('setContext', INPUT_FOCUS_KEY, msg.focused);
        break;
      }
    }
  }

  /** 由命令/标题栏按钮触发：用当前 UI 状态重新预览 */
  public requestPreview(): void {
    this.post({ type: 'mode', mode: 'rename' });
    this.post({ type: 'busy', busy: true, message: '正在扫描工作区…' });
    void this.doPreview(this.lastOptions);
  }

  public async executeAll(): Promise<void> {
    if (!this.lastPreview) {
      void vscode.window.showWarningMessage('Search & Rename：请先预览，再执行重命名。');
      return;
    }
    const keys = this.lastPreview.items
      .filter((i) => !isBlockingKind(i.conflict))
      .map((i) => i.key);
    await this.executeKeys(keys);
  }

  private async doPreview(options: MatchOptions): Promise<void> {
    if (!options.find) {
      await setHasPreview(false);
      this.post({
        type: 'previewResult',
        result: { items: [], rows: [], total: 0, conflictCount: 0, truncated: false },
      });
      this.post({ type: 'busy', busy: false });
      return;
    }

    this.previewAbort?.cancel();
    this.previewAbort?.dispose();
    const cts = new vscode.CancellationTokenSource();
    this.previewAbort = cts;

    const cfg = vscode.workspace.getConfiguration('searchAndRename');
    const full: PreviewOptions = {
      ...options,
      respectExclude: cfg.get<boolean>('respectExclude', true),
      extraExclude: cfg.get<string[]>('extraExclude', []),
      maxEntries: cfg.get<number>('maxEntries', 200000),
    };

    try {
      const result = await buildPreview(full, cts.token);
      if (cts.token.isCancellationRequested) {
        return;
      }
      this.lastPreview = result;
      await setHasPreview(result.items.length > 0);
      this.post({ type: 'previewResult', result });
      if (result.truncated) {
        void vscode.window.showWarningMessage(
          'Search & Rename：扫描条目已达上限，结果可能不完整，请缩小查找范围。'
        );
      }
    } catch (err) {
      this.post({ type: 'error', message: `预览失败：${describe(err)}` });
    } finally {
      if (this.previewAbort === cts) {
        this.post({ type: 'busy', busy: false });
      }
    }
  }

  private async executeKeys(keys: string[]): Promise<void> {
    if (!this.lastPreview) {
      return;
    }
    const keySet = new Set(keys);
    const pairs = this.lastPreview.items.filter(
      (i) => keySet.has(i.key) && !isBlockingKind(i.conflict)
    );
    if (pairs.length === 0) {
      void vscode.window.showWarningMessage(
        'Search & Rename：没有可执行的项（可能全部冲突或都未勾选）。'
      );
      return;
    }

    // 只读 / 虚拟文件系统守卫
    for (const p of pairs) {
      const uri = vscode.Uri.file(p.fsPath);
      if (vscode.workspace.fs.isWritableFileSystem(uri.scheme) === false) {
        void vscode.window.showErrorMessage(
          `Search & Rename：文件系统 ${uri.scheme} 不可写，无法重命名。`
        );
        return;
      }
    }

    const cfg = vscode.workspace.getConfiguration('searchAndRename');
    const threshold = cfg.get<number>('confirmThreshold', 15);

    if (pairs.length > threshold) {
      const pick = await vscode.window.showWarningMessage(
        `将要重命名 ${pairs.length} 个文件/文件夹，是否继续？`,
        { modal: true },
        '继续'
      );
      if (pick !== '继续') {
        return;
      }
    }

    this.post({ type: 'busy', busy: true, message: '正在重命名…' });

    const renamePairs: RenamePair[] = pairs.map((p) => ({
      fromPath: p.fsPath,
      toPath: joinName(p.fsPath, p.newName),
      fromUri: toUriStr(p.fsPath),
      toUri: toUriStr(joinName(p.fsPath, p.newName)),
      oldName: p.oldName,
      newName: p.newName,
      relPath: p.relPath,
      isDirectory: p.isDirectory,
    }));
    renamePairs.sort((a, b) => depth(b.fromPath) - depth(a.fromPath));

    const result: ExecuteResult = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: '重命名文件/文件夹',
        cancellable: true,
      },
      (progress, token) => this.executor.execute(renamePairs, token, progress)
    );

    await setCanUndo(this.executor.hasUndo());
    this.post({ type: 'result', result });
    this.post({ type: 'busy', busy: false });

    if (result.failed.length === 0 && !result.cancelled) {
      const pick = await vscode.window.showInformationMessage(
        `已重命名 ${result.done} 项。`,
        '撤销'
      );
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

    // 重命名后旧结果失效，自动重新预览
    this.lastPreview = undefined;
    await setHasPreview(false);
    await this.doPreview(this.lastOptions);
  }

  private html(webview: vscode.Webview): string {
    const uri = (f: string): vscode.Uri =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', f));
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${uri('panel.css')}" />
<title>查找与重命名</title>
</head>
<body>
  <div id="root">
    <div class="tabs" role="tablist">
      <button id="tab-content" class="tab" role="tab" aria-selected="false">
        <span class="codicon">⇄</span> 内容替换
      </button>
      <button id="tab-rename" class="tab" role="tab" aria-selected="true">
        <span class="codicon">✎</span> 名称重命名
      </button>
    </div>

    <div class="pane" id="pane-rename">
      <div class="fields">
        <div class="field">
          <label for="find">查找名称</label>
          <input id="find" type="text" placeholder="例如 Buttom" autocomplete="off" spellcheck="false" />
        </div>
        <div class="field">
          <label for="replace">替换为</label>
          <input id="replace" type="text" placeholder="例如 Button" autocomplete="off" spellcheck="false" />
        </div>
        <div class="hint">支持 <code>$1</code> 捕获组、<code>$&amp;</code> 整体匹配、<code>$$</code> 字面 $。（不支持 <code>\\1</code>）</div>
      </div>

      <div class="options">
        <button id="opt-case" class="toggle" title="区分大小写">Aa</button>
        <button id="opt-word" class="toggle" title="全字匹配">|ab|</button>
        <button id="opt-regex" class="toggle" title="使用正则表达式">.*</button>
        <button id="opt-preserve" class="toggle" title="保留大小写">AB</button>
        <span class="sep"></span>
        <select id="opt-target" title="匹配范围">
          <option value="both">文件 + 文件夹</option>
          <option value="filesOnly">仅文件</option>
          <option value="foldersOnly">仅文件夹</option>
        </select>
        <label class="chk" title="重命名文件名时保留扩展名">
          <input id="opt-ext" type="checkbox" checked /> 保留扩展名
        </label>
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
          <button id="btn-expand" class="mini" title="全部展开">展开</button>
          <button id="btn-collapse" class="mini" title="全部折叠">折叠</button>
          <button
            id="btn-wrap"
            class="mini"
            aria-pressed="false"
            title="名字过长时换行显示。关闭时旧名会被省略，但新名始终完整（悬停可看完整路径）"
          >换行</button>
        </div>
      </div>
      <div id="list" class="list"></div>
      <div id="empty" class="empty">输入「查找名称」后点击预览。</div>
    </div>

    <div class="pane" id="pane-content" hidden>
      <p class="empty">
        内容替换使用 VSCode 原生搜索。<br />
        点击下方按钮把当前查找串交给原生搜索，或直接按 <kbd>Ctrl/Cmd+Shift+F</kbd>。
      </p>
      <button id="btn-native" class="go">在原生搜索中查找</button>
    </div>
  </div>
  <script nonce="${nonce}" src="${uri('panel.js')}"></script>
</body>
</html>`;
  }
}

/* ------------------------------ helpers ------------------------------ */

export function defaultMatchOptions(): MatchOptions {
  const cfg = vscode.workspace.getConfiguration('searchAndRename');
  return {
    find: '',
    replace: '',
    isRegex: false,
    caseSensitive: cfg.get<boolean>('defaultCaseSensitive', false),
    wholeWord: false,
    preserveCase: false,
    preserveExtension: cfg.get<boolean>('preserveExtension', true),
    matchTarget: cfg.get<MatchOptions['matchTarget']>('matchTarget', 'both'),
  };
}

function isBlockingKind(kind: string | undefined): boolean {
  return kind === 'targetExists' || kind === 'duplicateTarget' || kind === 'invalidName';
}

function joinName(fsPath: string, newName: string): string {
  const norm = toPosix(fsPath).replace(/\/+$/, '');
  const i = norm.lastIndexOf('/');
  return i < 0 ? newName : `${norm.slice(0, i + 1)}${newName}`;
}

function depth(p: string): number {
  return toPosix(p).replace(/\/+$/, '').split('/').length;
}

function toUriStr(fsPath: string): string {
  const norm = toPosix(fsPath);
  const withSlash = norm.startsWith('/') ? norm : `/${norm}`;
  return encodeURI(`file://${withSlash}`);
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
