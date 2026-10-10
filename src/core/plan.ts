/**
 * 路径映射计算与执行顺序排序。
 * 纯函数，不依赖 vscode 运行时（只用 path 的字符串操作，跨平台统一走 posix 分隔符）。
 */

import type { Entry, MatchOptions, RenamePair } from '../types';
import { compilePattern, replaceSubject, splitName, validateName } from './regex';

/** 把绝对路径拆成 posix 段（Windows 的 C:\a\b 也归一化） */
export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

export function depthOf(p: string): number {
  const norm = toPosix(p).replace(/\/+$/, '');
  return norm.split('/').length;
}

export function parentOf(p: string): string {
  const norm = toPosix(p).replace(/\/+$/, '');
  const idx = norm.lastIndexOf('/');
  return idx <= 0 ? norm.slice(0, idx + 1) || '/' : norm.slice(0, idx);
}

export function joinPath(dir: string, name: string): string {
  const d = toPosix(dir).replace(/\/+$/, '');
  return `${d}/${name}`;
}

export function baseName(p: string): string {
  const norm = toPosix(p).replace(/\/+$/, '');
  const idx = norm.lastIndexOf('/');
  return idx < 0 ? norm : norm.slice(idx + 1);
}

/** 计算单个条目的新名称；返回 undefined 表示不匹配或无变化 */
export function computeNewName(entry: Entry, opts: MatchOptions): string | undefined {
  if (entry.isDirectory && opts.matchTarget === 'filesOnly') {
    return undefined;
  }
  if (!entry.isDirectory && opts.matchTarget === 'foldersOnly') {
    return undefined;
  }
  if (opts.find === '') {
    return undefined;
  }

  const { regex, matchesEmpty } = compilePattern(opts.find, {
    isRegex: opts.isRegex,
    caseSensitive: opts.caseSensitive,
    wholeWord: opts.wholeWord,
  });
  if (matchesEmpty) {
    return undefined;
  }

  const { subject, ext } = splitName(entry.name, opts.preserveExtension, entry.isDirectory);
  regex.lastIndex = 0;
  if (!regex.test(subject)) {
    return undefined;
  }

  const newSubject = replaceSubject(subject, regex, opts.replace, opts.preserveCase);
  const newName = newSubject + ext;
  if (newName === entry.name) {
    return undefined;
  }
  return newName;
}

/** 一条候选（尚未排序、尚未查冲突） */
export interface Candidate {
  entry: Entry;
  newName: string;
  reason?: string;
}

/** 从扫描结果生成候选列表（含名称合法性预检） */
export function buildCandidates(entries: Entry[], opts: MatchOptions): Candidate[] {
  const out: Candidate[] = [];
  for (const entry of entries) {
    const newName = computeNewName(entry, opts);
    if (newName === undefined) {
      continue;
    }
    const invalid = validateName(newName);
    out.push({ entry, newName, reason: invalid });
  }
  return out;
}

/**
 * 把候选转成重命名计划，并**先深后浅**排序。
 *
 * ⚠️ 核心不变量：父目录改名后，其子项的 from 路径会失效。
 *    所以必须让**更深的路径先执行**。同深度按路径长度降序，保证稳定。
 *
 * 返回的 plan 已过滤掉目标与原路径相同的项，但不做冲突判定（交给 conflict.ts）。
 */
export function buildPlan(candidates: Candidate[]): RenamePair[] {
  const plan: RenamePair[] = [];
  for (const c of candidates) {
    if (c.reason) {
      // 非法名不进 plan，由 conflict.ts 单独报
      continue;
    }
    const parent = parentOf(c.entry.fsPath);
    const toPath = joinPath(parent, c.newName);
    if (toPosix(toPath) === toPosix(c.entry.fsPath)) {
      continue;
    }
    plan.push({
      fromPath: toPosix(c.entry.fsPath),
      toPath: toPosix(toPath),
      fromUri: c.entry.uri,
      toUri: buildUriString(c.entry.uri, c.newName),
      oldName: c.entry.name,
      newName: c.newName,
      relPath: c.entry.relPath,
      isDirectory: c.entry.isDirectory,
    });
  }

  plan.sort(compareDeepFirst);
  return plan;
}

/** 先深后浅；同深度按路径长度降序（更长的更靠内，先处理） */
export function compareDeepFirst(a: RenamePair, b: RenamePair): number {
  const da = depthOf(a.fromPath);
  const db = depthOf(b.fromPath);
  if (da !== db) {
    return db - da;
  }
  if (a.fromPath.length !== b.fromPath.length) {
    return b.fromPath.length - a.fromPath.length;
  }
  return a.fromPath < b.fromPath ? -1 : a.fromPath > b.fromPath ? 1 : 0;
}

/**
 * 把 uri 字符串的最后一段替换成 newName。
 * 只做字符串操作，避免引入 vscode.Uri 依赖（保持纯函数）。
 */
export function buildUriString(oldUri: string, newName: string): string {
  const q = oldUri.search(/[?#]/);
  const pathPart = q < 0 ? oldUri : oldUri.slice(0, q);
  const tail = q < 0 ? '' : oldUri.slice(q);
  const idx = pathPart.lastIndexOf('/');
  if (idx < 0) {
    return encodeURIComponent(newName) + tail;
  }
  return pathPart.slice(0, idx + 1) + encodeURIComponent(newName) + tail;
}
