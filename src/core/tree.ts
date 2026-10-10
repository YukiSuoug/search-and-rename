/**
 * 把扁平的重命名计划组织成树形渲染行。
 *
 * 纯函数，不依赖 vscode —— 可以 node 直测。
 *
 * 要解决的核心展示问题：
 *  1. 文件夹改名后，它**整棵子树**都会跟着移动。平铺列表看不出这层关系。
 *  2. 同一个目录下的多个文件会把目录路径**重复刷 N 遍**，列表又长又挤。
 *  3. 一个文件自身的名字没变、但父目录改名了 —— 它其实也会"移动"。
 *
 * 本版的三个设计决定：
 *
 *  A. **一切基于相对路径**。上一版拿绝对路径（`d:/1/2/下载/.../ot029/body/mod/`）
 *     逐段渲染成「祖先 diff」，结果每行都把完整绝对目录刷一遍，一行撑成三行。
 *     相对路径既短又和用户的心智模型一致。
 *
 *  B. **每个目录只出现一次**。文件按所在目录分组成「目录头」：
 *     - 该目录自身也在计划里 → **改名头**（显示 `旧名 → 新名`，highlight 命中片段）
 *     - 该目录自身不在计划里 → **容器头**（纯分组，显示相对路径 + 条目数）
 *     子项只显示文件名，不再重复目录。
 *
 *  C. **中间层自动折叠**。只有「真的有条目」的目录才成为节点，
 *     所以 `a/b/c/mod` 只画一个 `mod` 头，而不是 `a`、`b`、`c`、`mod` 四层。
 */

import type { ConflictKind, DiffSegment, RenamePair, TreeRow } from '../types';

export interface BuildTreeInput {
  /** 重命名计划（顺序无关，本函数内部自行分层排序） */
  pairs: RenamePair[];
  /** fromPath -> 冲突信息 */
  conflicts: Map<string, { kind: ConflictKind; message: string }>;
  /** fromPath -> 名字 diff（用于行内 old/new 的高亮） */
  nameDiffs: Map<string, { oldDiff: DiffSegment[]; newDiff: DiffSegment[] }>;
}

type ConflictMap = Map<string, { kind: ConflictKind; message: string }>;
type DiffMap = Map<string, { oldDiff: DiffSegment[]; newDiff: DiffSegment[] }>;

/** 目录节点。key 是**相对目录路径**（'' 表示工作区/扫描根自身） */
interface DirNode {
  rel: string;
  /** 该目录自身也在重命名计划里 */
  renamed?: RenamePair;
  /** 直接位于该目录下的文件条目 */
  leaves: RenamePair[];
  children: DirNode[];
}

interface Ctx {
  conflicts: ConflictMap;
  nameDiffs: DiffMap;
  /** 相对目录路径 -> 被改名的目录条目 */
  renamedByRel: Map<string, RenamePair>;
}

export function buildTree(input: BuildTreeInput): TreeRow[] {
  const { pairs, conflicts, nameDiffs } = input;

  const nodes = new Map<string, DirNode>();
  const nodeOf = (rel: string): DirNode => {
    let n = nodes.get(rel);
    if (!n) {
      n = { rel, leaves: [], children: [] };
      nodes.set(rel, n);
    }
    return n;
  };

  // 1. 目录条目 → 它自己就是一个「改名头」节点
  const renamedByRel = new Map<string, RenamePair>();
  for (const p of pairs) {
    if (p.isDirectory) {
      const rel = normDir(p.relPath);
      nodeOf(rel).renamed = p;
      renamedByRel.set(rel, p);
    }
  }

  // 2. 文件条目 → 挂到它所在目录的节点上
  for (const p of pairs) {
    if (!p.isDirectory) {
      nodeOf(dirOf(p.relPath)).leaves.push(p);
    }
  }

  // 3. 建层级：每个节点挂到「最近的存在节点祖先」下（中间层自动跳过）
  const roots: DirNode[] = [];
  const ordered = [...nodes.values()].sort((a, b) => segCount(a.rel) - segCount(b.rel));
  for (const n of ordered) {
    const parent = nearestNodeAncestor(n.rel, nodes);
    if (parent) {
      parent.children.push(n);
    } else {
      roots.push(n);
    }
  }

  // 4. 稳定排序，保证渲染顺序可复现
  for (const n of nodes.values()) {
    n.children.sort((a, b) => cmp(a.rel, b.rel));
    n.leaves.sort((a, b) => cmp(a.relPath, b.relPath));
  }

  const ctx: Ctx = { conflicts, nameDiffs, renamedByRel };
  const rows: TreeRow[] = [];
  roots.sort((a, b) => cmp(a.rel, b.rel));
  for (const r of roots) {
    emitNode(r, 0, rows, ctx, null);
  }
  return rows;
}

/** 递归输出一个目录节点：头 → 子目录 → 本目录下的文件 */
function emitNode(
  n: DirNode,
  depth: number,
  rows: TreeRow[],
  ctx: Ctx,
  parentRel: string | null
): void {
  let childDepth = depth;
  let dirHint: string | undefined;

  // 根节点（rel === '' 且自身不参与重命名）：不画头，直接平铺其内容
  const skipHeader = n.rel === '' && !n.renamed;

  if (!skipHeader && isSolo(n)) {
    // 只有一个条目的目录：为它单开一行头不划算（1 条改名要占 2 行），
    // 把目录名降级成行内灰色前缀，叶子仍留在当前层级。
    dirHint = labelOf(n.rel, parentRel);
  } else if (!skipHeader) {
    rows.push(makeHeaderRow(n, labelOf(n.rel, parentRel), depth, ctx));
    childDepth = depth + 1;
  }

  for (const c of n.children) {
    emitNode(c, childDepth, rows, ctx, n.rel);
  }

  for (const leaf of n.leaves) {
    rows.push(
      makeLeafRow(
        leaf,
        childDepth,
        ctx,
        // 祖先 diff 里标出「被改名的祖先段」，供 tooltip / QuickPick 使用。
        // 注意用**相对**路径算，否则又会把绝对目录刷出来。
        ancestorDiffFor(leaf.relPath, ctx.renamedByRel),
        dirHint
      )
    );
  }
}

/** 只有一个条目、且自身不改名的目录 —— 不值得单独占一行分组头 */
function isSolo(n: DirNode): boolean {
  return !n.renamed && n.children.length === 0 && n.leaves.length === 1;
}

function makeHeaderRow(n: DirNode, label: string, depth: number, ctx: Ctx): TreeRow {
  const hasChildren = n.children.length + n.leaves.length > 0;

  if (n.renamed) {
    const p = n.renamed;
    const d = ctx.nameDiffs.get(p.fromPath) ?? { oldDiff: [], newDiff: [] };
    const c = ctx.conflicts.get(p.fromPath);
    return {
      key: p.fromPath,
      depth,
      isGroup: true,
      isContainer: false,
      hasChildren,
      isDirectory: true,
      oldName: p.oldName,
      newName: p.newName,
      relPath: label,
      oldDiff: d.oldDiff,
      newDiff: d.newDiff,
      ancestorDiff: ancestorDiffFor(p.relPath, ctx.renamedByRel),
      conflict: c?.kind,
      conflictMessage: c?.message,
      childConflictCount: countConflictsIn(n, ctx.conflicts),
    };
  }

  return {
    // 容器不是真实条目，key 用特殊前缀，避免和真实 fsPath 撞车
    key: `dir::${n.rel}`,
    depth,
    isGroup: true,
    isContainer: true,
    hasChildren,
    isDirectory: true,
    oldName: '',
    newName: '',
    relPath: label,
    oldDiff: [],
    newDiff: [],
    ancestorDiff: [],
    containerCount: totalOf(n),
    childConflictCount: countConflictsIn(n, ctx.conflicts),
  };
}

function makeLeafRow(
  p: RenamePair,
  depth: number,
  ctx: Ctx,
  ancestorDiff: DiffSegment[],
  dirHint?: string
): TreeRow {
  const d = ctx.nameDiffs.get(p.fromPath) ?? { oldDiff: [], newDiff: [] };
  const c = ctx.conflicts.get(p.fromPath);
  return {
    key: p.fromPath,
    depth,
    isGroup: false,
    hasChildren: false,
    isDirectory: false,
    oldName: p.oldName,
    newName: p.newName,
    // 叶子的 relPath 保留**完整相对路径**：行内只渲染 old → new（目录已由头部给出），
    // 完整路径供 tooltip / QuickPick 的 detail 使用。
    relPath: toPosix(p.relPath),
    dirHint,
    oldDiff: d.oldDiff,
    newDiff: d.newDiff,
    ancestorDiff,
    conflict: c?.kind,
    conflictMessage: c?.message,
  };
}

/* ------------------------------ 层级辅助 ------------------------------ */

/** 最近的存在节点祖先（跳过中间那些「没有条目」的目录） */
function nearestNodeAncestor(rel: string, nodes: Map<string, DirNode>): DirNode | undefined {
  let cur = dirOf(rel);
  // ⚠️ 根节点（rel === ''）不能认自己当父亲：dirOf('') === ''，
  // 若直接查表会命中它自身，导致所有节点都挂在自己下面、整棵树一行都输出不了。
  if (cur === rel) {
    return undefined;
  }
  for (;;) {
    const found = nodes.get(cur);
    if (found) {
      return found;
    }
    const next = dirOf(cur);
    if (next === cur) {
      return undefined;
    }
    cur = next;
  }
}

/** 子节点的显示标签：相对父节点的部分 */
function labelOf(rel: string, parentRel: string | null): string {
  if (parentRel === null || parentRel === '') {
    return rel;
  }
  const prefix = `${parentRel}/`;
  return rel.startsWith(prefix) ? rel.slice(prefix.length) : rel;
}

/** 子树内条目总数（含改名目录自身） */
function totalOf(n: DirNode): number {
  let c = n.leaves.length + (n.renamed ? 1 : 0);
  for (const k of n.children) {
    c += totalOf(k);
  }
  return c;
}

/** 子树内（含自身）冲突计数 */
function countConflictsIn(n: DirNode, conflicts: ConflictMap): number {
  let c = conflicts.has(n.renamed?.fromPath ?? '\u0000') ? 1 : 0;
  for (const l of n.leaves) {
    if (conflicts.has(l.fromPath)) {
      c++;
    }
  }
  for (const k of n.children) {
    c += countConflictsIn(k, conflicts);
  }
  return c;
}

/* ------------------------------ 路径辅助 ------------------------------ */

function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}

/** 归一化目录相对路径：去首尾斜杠 */
function normDir(rel: string): string {
  return toPosix(rel).replace(/^\/+/, '').replace(/\/+$/, '');
}

/** 取父目录的相对路径；无分隔符则返回 '' */
function dirOf(rel: string): string {
  const norm = normDir(rel);
  const idx = norm.lastIndexOf('/');
  return idx < 0 ? '' : norm.slice(0, idx);
}

function segCount(rel: string): number {
  return rel === '' ? 0 : rel.split('/').filter((s) => s.length > 0).length;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* ------------------------------ 祖先 diff ------------------------------ */

/**
 * 构造「祖先路径 diff」：对每一级祖先目录，若它也改名了则该段标 `changed`。
 *
 * 实现方式：按分隔符切段，逐段累加判断「拼到这一级的路径」是否在 renamedDirs 里。
 * 这样天然避免手工维护偏移量（之前手写 slice 偏移出过 `//s` 的 bug）。
 *
 * 同时支持绝对路径与相对路径：
 * - 绝对：`/ws/src/Buttom/a.ts` + renamedDirs 含 `/ws/src/Buttom`
 * - 相对：`src/Buttom/a.ts`     + renamedDirs 含 `src/Buttom`
 *
 * ⚠️ 必须用**相对**路径来算（见文件头 A.）。传绝对路径不会崩，
 * 但渲染出 `d:/1/2/下载/...` 那种噪声 —— 这正是本版要消灭的东西。
 */
export function ancestorDiffFor(
  path: string,
  renamedDirs: Map<string, RenamePair>
): DiffSegment[] {
  const norm = toPosix(path);
  const lastSlash = norm.lastIndexOf('/');
  if (lastSlash < 0) {
    return [];
  }
  // 父目录部分（不含最后的文件名）
  const dirPart = norm.slice(0, lastSlash);
  const isAbsolute = dirPart.startsWith('/');

  const segs = dirPart.split('/').filter((s) => s.length > 0);
  if (segs.length === 0) {
    return isAbsolute ? [{ text: '/', changed: false }] : [];
  }

  const out: DiffSegment[] = [];
  // 绝对路径补回开头的 "/"
  if (isAbsolute) {
    out.push({ text: '/', changed: false });
  }

  let acc = '';
  for (const seg of segs) {
    // 绝对路径的 key 形如 `/ws/src`；相对路径形如 `src/Buttom`
    acc = acc === '' && !isAbsolute ? seg : `${acc}/${seg}`;
    out.push({ text: seg, changed: renamedDirs.has(acc) });
    out.push({ text: '/', changed: false });
  }

  return mergeSegments(out);
}

function mergeSegments(segs: DiffSegment[]): DiffSegment[] {
  const out: DiffSegment[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.changed === s.changed) {
      last.text += s.text;
    } else {
      out.push({ text: s.text, changed: s.changed });
    }
  }
  return out;
}
