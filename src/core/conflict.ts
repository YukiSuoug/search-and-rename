/**
 * 冲突检测：四类。
 *  - invalidName     目标名非法
 *  - duplicateTarget 批次内两个源映射到同一目标
 *  - targetExists    目标在磁盘上已存在，且不是本批次的源
 *  - caseOnly        仅大小写变化（大小写不敏感 FS 上可行，但 git 可能无感）
 *
 * 其中 targetExists 需要探测文件系统，通过注入的 exists() 回调实现，
 * 便于单测时打桩。
 */

import type { Conflict, ConflictKind, RenamePair } from '../types';
import { toPosix, baseName, parentOf, type Candidate } from './plan';
import { validateName } from './regex';

export type { Conflict, ConflictKind } from '../types';

export interface ConflictDetectOptions {
  /** 探测路径是否存在（同步或异步均可，这里用同步以求简单） */
  exists: (posixPath: string) => boolean;
  /** 文件系统是否区分大小写（影响 caseOnly 的提示语） */
  caseSensitiveFs: boolean;
}

export interface DetectResult {
  plan: RenamePair[];
  conflicts: Map<string, Conflict>;
  /** 非法名单独列出（它们没进 plan） */
  invalid: Conflict[];
}

/** 纯函数部分：只依赖 plan 内部信息，不探测 FS */
export function detectDuplicateTargets(plan: RenamePair[]): Map<string, ConflictKind> {
  const byTarget = new Map<string, RenamePair[]>();
  for (const p of plan) {
    const key = toPosix(p.toPath);
    const list = byTarget.get(key);
    if (list) {
      list.push(p);
    } else {
      byTarget.set(key, [p]);
    }
  }
  const conflicts = new Map<string, ConflictKind>();
  for (const [, list] of byTarget) {
    if (list.length > 1) {
      for (const p of list) {
        conflicts.set(p.fromPath, 'duplicateTarget');
      }
    }
  }
  return conflicts;
}

/** 检测自引用：to 的某一级祖先正好是另一个 from */
export function detectCycles(plan: RenamePair[]): Map<string, ConflictKind> {
  const fromSet = new Set(plan.map((p) => toPosix(p.fromPath)));
  const out = new Map<string, ConflictKind>();
  for (const p of plan) {
    // 若目标目录落在某个将被改名的目录内部（同名链），可能产生环
    let cur = toPosix(p.toPath);
    while (true) {
      const parent = parentOf(cur);
      if (parent === cur) {
        break;
      }
      if (fromSet.has(parent) && parent !== toPosix(p.fromPath)) {
        // 目标是另一个改名项的子孙 → 该子孙项需要先执行；不一定是错误，
        // 但如果那个祖先自己也被改到别处就会断裂。保守起见不在这里报错，
        // 交给排序 + targetExists 处理。保留钩子。
        break;
      }
      cur = parent;
    }
  }
  return out;
}

/**
 * 完整检测。
 * 注意：targetExists 只对「目标不在本批次源集合中」的项检查，
 *       否则 a→b 与 b→c 这种链式会被误判。
 */
export function detectConflicts(
  candidates: Candidate[],
  plan: RenamePair[],
  opts: ConflictDetectOptions
): DetectResult {
  const conflicts = new Map<string, Conflict>();
  const invalid: Conflict[] = [];

  // 非法名
  for (const c of candidates) {
    const invalidReason = c.reason ?? validateName(c.newName);
    if (invalidReason) {
      invalid.push({
        fsPath: c.entry.fsPath,
        kind: 'invalidName',
        message: invalidReason,
      });
    }
  }

  // 批次内撞名
  const dup = detectDuplicateTargets(plan);
  for (const [fromPath, kind] of dup) {
    const pair = plan.find((p) => p.fromPath === fromPath);
    conflicts.set(fromPath, {
      fsPath: fromPath,
      kind,
      message: `多个源指向同一目标：${pair ? pair.newName : ''}`,
    });
  }

  // 本批次源集合（用于豁免 targetExists）
  const sourceSet = new Set(plan.map((p) => toPosix(p.fromPath)));
  const lowerSourceSet = new Set(plan.map((p) => toPosix(p.fromPath).toLowerCase()));

  for (const p of plan) {
    if (conflicts.has(p.fromPath)) {
      continue;
    }
    const toKey = toPosix(p.toPath);
    const toLower = toKey.toLowerCase();

    // 仅大小写变化
    if (toLower === toPosix(p.fromPath).toLowerCase() && toKey !== toPosix(p.fromPath)) {
      if (!opts.caseSensitiveFs) {
        // 大小写不敏感 FS：改名本身可行，但 git 可能不识别
        conflicts.set(p.fromPath, {
          fsPath: p.fromPath,
          kind: 'caseOnly',
          message: '仅大小写变化，git 可能不识别此改动（建议 git mv）',
        });
        continue;
      }
      // 大小写敏感 FS：若同目录下已有同名小写文件，由下面的 exists 捕获
    }

    if (sourceSet.has(toKey)) {
      continue;
    }
    // 链式场景：a→b 而 b 也在改名集合里，且 b 的改名会先执行（更深/更早）
    // 此时 b 的位置会被腾出来，这里豁免；无法精确判定时保守报错。
    if (lowerSourceSet.has(toLower) && opts.caseSensitiveFs) {
      continue;
    }

    if (opts.exists(toKey)) {
      conflicts.set(p.fromPath, {
        fsPath: p.fromPath,
        kind: 'targetExists',
        message: `目标已存在：${baseName(toKey)}`,
      });
    }
  }

  return { plan, conflicts, invalid };
}

export function isBlocking(kind: ConflictKind): boolean {
  return kind === 'targetExists' || kind === 'duplicateTarget' || kind === 'invalidName';
}
