/**
 * 预览编排：扫描 → 候选 → 计划 → 冲突 → 组装 PreviewItem。
 * 依赖 vscode（需要 workspace.fs 探测目标是否存在）。
 */

import * as vscode from 'vscode';
import type {
  ConflictKind,
  DiffSegment,
  Entry,
  MatchOptions,
  PreviewItem,
  PreviewResult,
  RenamePair,
} from '../types';
import { buildCandidates, buildPlan, toPosix } from './plan';
import { detectConflicts, isBlocking } from './conflict';
import { diffNames, compilePattern } from './regex';
import { buildTree } from './tree';
import { walkWorkspace } from './walk';

export interface PreviewOptions extends MatchOptions {
  respectExclude: boolean;
  extraExclude: string[];
  maxEntries: number;
  /** 限定扫描范围（右键菜单传入选中的目录）；不传 = 全工作区 */
  roots?: vscode.Uri[];
  /** 是否把 roots 自身也纳入候选（右键文件夹时可选） */
  includeRootsThemselves?: boolean;
}

export async function buildPreview(
  opts: PreviewOptions,
  token: vscode.CancellationToken
): Promise<PreviewResult> {
  const empty: PreviewResult = {
    items: [],
    rows: [],
    total: 0,
    conflictCount: 0,
    truncated: false,
  };
  if (opts.find === '') {
    return empty;
  }

  const { entries, truncated } = await walkWorkspace(token, {
    includeFiles: opts.matchTarget !== 'foldersOnly',
    includeFolders: opts.matchTarget !== 'filesOnly',
    respectExclude: opts.respectExclude,
    extraExclude: opts.extraExclude,
    maxEntries: opts.maxEntries,
    roots: opts.roots,
    includeRootsThemselves: opts.includeRootsThemselves,
  });

  if (token.isCancellationRequested) {
    return { ...empty, truncated };
  }

  const candidates = buildCandidates(entries, opts);
  const plan = buildPlan(candidates);

  // 先批量探测所有目标是否已存在于磁盘，再交给纯函数层做冲突判定
  const existsMap = await probeTargets(plan, token);

  const { conflicts, invalid } = detectConflicts(candidates, plan, {
    exists: (p) => existsMap.get(p) === true,
    caseSensitiveFs: isCaseSensitiveFs(),
  });

  const compiled = compilePattern(opts.find, {
    isRegex: opts.isRegex,
    caseSensitive: opts.caseSensitive,
    wholeWord: opts.wholeWord,
  });

  const items: PreviewItem[] = [];
  const nameDiffs = new Map<string, { oldDiff: DiffSegment[]; newDiff: DiffSegment[] }>();
  let conflictCount = 0;

  for (const p of plan) {
    const c = conflicts.get(p.fromPath);
    const { oldDiff, newDiff } = diffNames(p.oldName, p.newName, compiled.regex);
    nameDiffs.set(p.fromPath, { oldDiff, newDiff });
    if (c && isBlocking(c.kind)) {
      conflictCount++;
    }
    items.push({
      key: p.fromPath,
      fsPath: p.fromPath,
      relPath: p.relPath,
      oldName: p.oldName,
      newName: p.newName,
      isDirectory: p.isDirectory,
      oldDiff,
      newDiff,
      conflict: c?.kind,
      conflictMessage: c?.message,
    });
  }

  for (const c of invalid) {
    conflictCount++;
    items.push({
      key: c.fsPath,
      fsPath: c.fsPath,
      relPath: vscode.workspace.asRelativePath(vscode.Uri.file(c.fsPath), false),
      oldName: basename(c.fsPath),
      newName: '',
      isDirectory: false,
      oldDiff: [],
      newDiff: [],
      conflict: c.kind,
      conflictMessage: c.message,
    });
  }

  items.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  // 树形行：把冲突信息与 diff 汇成 map 交给纯函数 builder
  const conflictMap = new Map<string, { kind: ConflictKind; message: string }>();
  for (const [fromPath, c] of conflicts) {
    conflictMap.set(fromPath, { kind: c.kind, message: c.message });
  }
  for (const c of invalid) {
    conflictMap.set(c.fsPath, { kind: c.kind, message: c.message });
  }
  const rows = buildTree({ pairs: plan, conflicts: conflictMap, nameDiffs });

  return {
    items,
    rows,
    total: items.length,
    conflictCount,
    truncated,
  };
}

/** 批量探测目标路径是否已存在；返回 map: posixPath -> exists */
async function probeTargets(
  plan: RenamePair[],
  token: vscode.CancellationToken
): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>();
  const sourceSet = new Set(plan.map((p) => toPosix(p.fromPath)));

  const targets = plan
    .map((p) => toPosix(p.toPath))
    .filter((t) => !sourceSet.has(t));

  const unique = Array.from(new Set(targets));

  const CONC = 32;
  let idx = 0;
  const workers: Promise<void>[] = [];
  const worker = async (): Promise<void> => {
    while (idx < unique.length) {
      if (token.isCancellationRequested) {
        return;
      }
      const cur = unique[idx++];
      let exists = false;
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(cur));
        exists = true;
      } catch {
        exists = false;
      }
      map.set(cur, exists);
    }
  };
  for (let i = 0; i < Math.min(CONC, unique.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return map;
}

export function isCaseSensitiveFs(): boolean {
  // Windows / macOS 默认大小写不敏感；Linux 敏感。
  // 用平台判断（无法可靠探测挂载选项，且 VSCode 也用类似策略）。
  return process.platform === 'linux';
}

function basename(p: string): string {
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '');
  const i = norm.lastIndexOf('/');
  return i < 0 ? norm : norm.slice(i + 1);
}

export type { Entry, ConflictKind };
