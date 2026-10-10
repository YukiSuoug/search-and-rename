/**
 * 工作区递归扫描。
 *
 * 依赖 vscode API。要点：
 *  - 用 workspace.fs.readDirectory 逐层递归（能拿到空文件夹，findFiles 拿不到）
 *  - 并发限流，避免大仓库把 IO 打满
 *  - seen 集合防符号链接环
 *  - 尊重 files.exclude / search.exclude + 额外 glob
 *  - 全程响应 CancellationToken
 */

import * as vscode from 'vscode';
import type { Entry } from '../types';
import { toPosix } from './plan';
import { globToRegExp, normalizeGlob } from './glob';

export { globToRegExp, normalizeGlob } from './glob';

export interface WalkOptions {
  includeFiles: boolean;
  includeFolders: boolean;
  respectExclude: boolean;
  extraExclude: string[];
  maxEntries: number;
  /**
   * 扫描根。为空/未提供时 = 全部工作区文件夹。
   * 右键菜单场景传入「用户选中的目录」，从而把作用范围限制在子树内。
   */
  roots?: vscode.Uri[];
  /**
   * 是否把 roots 自身也作为候选条目。
   *  - 用户右键的是文件夹 A，想给「A 里面的东西」改名 → false（默认）
   *  - 用户右键的是文件夹 A，也想改名 A 自己 → true
   * 注意：仅对「传入的根」生效，根的子孙照常按 includeFiles/includeFolders 收。
   */
  includeRootsThemselves?: boolean;
}

export interface WalkResult {
  entries: Entry[];
  truncated: boolean;
  scanned: number;
}

const CONCURRENCY = 8;

export async function walkWorkspace(
  token: vscode.CancellationToken,
  opts: WalkOptions
): Promise<WalkResult> {
  const explicitRoots = opts.roots && opts.roots.length > 0;
  const roots = explicitRoots ? opts.roots! : (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri);

  const entries: Entry[] = [];
  const seen = new Set<string>();
  const state = { truncated: false, scanned: 0 };

  const matcher = buildExcludeMatcher(opts);

  const queue: vscode.Uri[] = [...roots];
  for (const r of roots) {
    seen.add(r.toString());
  }

  // 显式指定根时，默认**不**排除根自身（用户明确点了它）
  if (explicitRoots && opts.includeRootsThemselves) {
    for (const r of roots) {
      const isDir = await isDirectory(r);
      if (state.scanned++ > opts.maxEntries) {
        state.truncated = true;
        break;
      }
      if (isDir || opts.includeFiles) {
        entries.push(toEntry(r, isDir));
      }
    }
  }

  const scanDir = async (dir: vscode.Uri): Promise<void> => {
    let items: [string, vscode.FileType][];
    try {
      items = await vscode.workspace.fs.readDirectory(dir);
    } catch {
      return; // 无权限 / 已删除，跳过而不中断整体
    }
    if (token.isCancellationRequested) {
      return;
    }

    for (const [name, type] of items) {
      if (state.truncated || token.isCancellationRequested) {
        return;
      }
      const uri = vscode.Uri.joinPath(dir, name);
      const uriStr = uri.toString();
      const isDir = (type & vscode.FileType.Directory) !== 0;
      const isLink = (type & vscode.FileType.SymbolicLink) !== 0;

      state.scanned++;
      if (state.scanned > opts.maxEntries) {
        state.truncated = true;
        return;
      }

      // 排除匹配必须用「工作区相对路径」，不能用 fsPath。
      // extraExclude / files.exclude 里写的是相对 glob（如 **/node_modules/**），
      // 拿绝对路径去比虽然多数情况也能命中，但只要「工作区所在目录名」恰好等于
      // 某个被排除的目录名（例如仓库放在 ~/dist/myProj 下），就会整棵树被误伤。
      const relPath = vscode.workspace.asRelativePath(uri, false);
      if (matcher(name, toPosix(relPath), isDir)) {
        continue;
      }

      if (isDir || opts.includeFiles) {
        entries.push({
          fsPath: toPosix(uri.fsPath),
          uri: uriStr,
          name,
          isDirectory: isDir,
          relPath,
        });
      }

      // 不跟随符号链接（避免环与越界）
      if (isDir && !isLink && !seen.has(uriStr)) {
        seen.add(uriStr);
        queue.push(uri);
      }
    }
  };

  // 固定 worker 池：每个 worker 循环取目录直到队列空
  const worker = async (): Promise<void> => {
    while (!state.truncated && !token.isCancellationRequested) {
      const dir = queue.shift();
      if (!dir) {
        return;
      }
      await scanDir(dir);
    }
  };

  const workers: Promise<void>[] = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return { entries, truncated: state.truncated, scanned: state.scanned };
}

/** 把一个 URI 转成 Entry（用于「根自身」也在范围内的情况） */
function toEntry(uri: vscode.Uri, isDir: boolean): Entry {
  const norm = toPosix(uri.fsPath).replace(/\/+$/, '');
  const name = norm.slice(norm.lastIndexOf('/') + 1) || norm;
  return {
    fsPath: norm,
    uri: uri.toString(),
    name,
    isDirectory: isDir,
    relPath: vscode.workspace.asRelativePath(uri, false),
  };
}

async function isDirectory(uri: vscode.Uri): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return (stat.type & vscode.FileType.Directory) !== 0;
  } catch {
    return false;
  }
}

function buildExcludeMatcher(opts: WalkOptions): (
  name: string,
  fsPath: string,
  isDir: boolean
) => boolean {
  const exclude = opts.respectExclude ? collectExcludeGlobs() : {};
  const patterns: string[] = [];
  for (const key of Object.keys(exclude)) {
    if (exclude[key]) {
      patterns.push(normalizeExtra(key));
    }
  }
  for (const g of opts.extraExclude) {
    patterns.push(normalizeExtra(g));
  }
  const regexes = patterns.map(globToRegExp).filter((r): r is RegExp => r !== undefined);
  const plainDirs = new Set<string>(['.git']);

  return (name: string, fsPath: string, isDir: boolean): boolean => {
    if (plainDirs.has(name)) {
      return true;
    }
    for (const re of regexes) {
      if (re.test(fsPath)) {
        return true;
      }
    }
    void isDir;
    return false;
  };
}

function collectExcludeGlobs(): Record<string, boolean> {
  const files = vscode.workspace.getConfiguration('files');
  const search = vscode.workspace.getConfiguration('search');
  const out: Record<string, boolean> = {};
  const a = files.get<Record<string, boolean>>('exclude') ?? {};
  const b = search.get<Record<string, boolean>>('exclude') ?? {};
  for (const k of Object.keys(a)) {
    out[k] = a[k];
  }
  for (const k of Object.keys(b)) {
    out[k] = b[k];
  }
  return out;
}

function normalizeExtra(g: string): string {
  return normalizeGlob(g);
}
