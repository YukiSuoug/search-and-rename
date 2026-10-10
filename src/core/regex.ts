/**
 * 纯函数工具：正则编译、名称切分、保留大小写、diff 片段。
 * 不依赖 vscode，可直接在 node 中单测。
 */

import type { DiffSegment } from '../types';

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface CompiledPattern {
  regex: RegExp;
  /** 该正则是否会匹配空串（会导致无限替换，必须拒绝） */
  matchesEmpty: boolean;
}

/**
 * 把 UI 选项编译成全局正则。
 *
 * ⚠️ 关键坑：查找串为空 → 编译出 /(?:)/g 会匹配一切空位。
 *   必须由调用方在 find === '' 时直接不下发预览。
 */
export function compilePattern(
  find: string,
  opts: { isRegex: boolean; caseSensitive: boolean; wholeWord: boolean }
): CompiledPattern {
  let pat = opts.isRegex ? find : escapeRegExp(find);
  if (opts.wholeWord) {
    pat = `\\b(?:${pat})\\b`;
  }
  const flags = opts.caseSensitive ? 'g' : 'gi';
  const regex = new RegExp(pat, flags);
  return { regex, matchesEmpty: regex.test('') };
}

/** 扩展名切分：  "a.ts" -> {subject:"a", ext:".ts"};  "a.test.ts" -> {subject:"a.test", ext:".ts"} */
const EXT_RE = /^(.*?)(\.[^.]*)?$/;

export function splitName(
  name: string,
  preserveExtension: boolean,
  isDirectory: boolean
): { subject: string; ext: string } {
  if (!preserveExtension || isDirectory) {
    return { subject: name, ext: '' };
  }
  const m = EXT_RE.exec(name);
  if (!m) {
    return { subject: name, ext: '' };
  }
  const subject = m[1] ?? '';
  const ext = m[2] ?? '';
  // 隐藏文件（.env / .gitignore）主体为空 → 视为无扩展名，整体当主体
  if (subject === '') {
    return { subject: name, ext: '' };
  }
  return { subject, ext };
}

/** 与 VSCode 搜索框 preserveCase 同款的三种策略 */
export function applyPreserveCase(original: string, replaced: string): string {
  if (!replaced) {
    return replaced;
  }
  if (original === original.toUpperCase() && original !== original.toLowerCase()) {
    return replaced.toUpperCase();
  }
  if (original === original.toLowerCase() && original !== original.toUpperCase()) {
    return replaced.toLowerCase();
  }
  if (/^[A-Z]/.test(original)) {
    return replaced.charAt(0).toUpperCase() + replaced.slice(1);
  }
  return replaced;
}

/**
 * 用编译好的正则替换主体。
 * 走 JS 引擎：支持 $1 $& $$，**不支持 \1**（与 VSCode 搜索框不同，UI 需提示）。
 */
export function replaceSubject(
  subject: string,
  regex: RegExp,
  replacement: string,
  preserveCase: boolean
): string {
  regex.lastIndex = 0;
  /*
   * 始终走回调路径 —— 不要"关 preserveCase 时用原生 replace、开时用自实现"。
   *
   * 踩过的坑：原生 `String.replace` 支持 `$1`~`$99`、`$&`、`` $` ``、`$'`、`$$`、`$<name>`，
   * 而手写的展开器一开始只认 `$$`/`$&`/单位数 `$1`~`$9`。于是同一个替换串：
   *   `$10`  → 关：第 10 个捕获组    开：第 1 个捕获组 + 字面量 "0"
   *   `$<x>` → 关：命名捕获组        开：原样输出 "$<x>"
   * 勾一下「保留大小写」就静默改了替换的含义，进而生成错误的文件名。
   *
   * 现在两条路径合并成一条，`expandReplacement` 按规范实现，结构上杜绝这种分歧。
   */
  return subject.replace(regex, (matched: string, ...rest: unknown[]) => {
    const expanded = expandReplacement(replacement, matched, rest);
    return preserveCase ? applyPreserveCase(matched, expanded) : expanded;
  });
}

/**
 * 按 ECMAScript 的 GetSubstitution 语义展开替换串。
 *
 * 支持：`$$`（字面 $）、`$&`（整体匹配）、`` $` ``（匹配前文本）、`$'`（匹配后文本）、
 * `$n` / `$nn`（捕获组，两位优先且需存在）、`$<name>`（命名捕获组）。
 * 其余情况一律原样保留 `$` 及其后字符。
 */
function expandReplacement(replacement: string, matched: string, rest: unknown[]): string {
  const args = [...rest];

  // 回调参数排列：[g1…gn, offset, input, groups?]，其中 groups 仅在正则含命名组时出现
  const last = args[args.length - 1];
  const namedCaptures =
    last !== null && typeof last === 'object'
      ? (args.pop() as Record<string, string | undefined>)
      : undefined;
  const input = typeof args[args.length - 1] === 'string' ? (args.pop() as string) : matched;
  const position = typeof args[args.length - 1] === 'number' ? (args.pop() as number) : 0;
  const captures = args as Array<string | undefined>;

  let out = '';
  for (let i = 0; i < replacement.length; i++) {
    const ch = replacement[i];
    if (ch !== '$' || i + 1 >= replacement.length) {
      out += ch;
      continue;
    }
    const next = replacement[i + 1];

    if (next === '$') {
      out += '$';
      i += 1;
    } else if (next === '&') {
      out += matched;
      i += 1;
    } else if (next === '`') {
      out += input.slice(0, position);
      i += 1;
    } else if (next === "'") {
      out += input.slice(position + matched.length);
      i += 1;
    } else if (next >= '0' && next <= '9') {
      // 两位数字优先（且必须真有这么多组），否则退化为一位
      let digits = next;
      let consumed = 1;
      const second = replacement[i + 2];
      if (second !== undefined && second >= '0' && second <= '9') {
        const two = Number(next + second);
        if (two <= captures.length) {
          digits = next + second;
          consumed = 2;
        }
      }
      const idx = Number(digits);
      if (idx === 0 || idx > captures.length) {
        out += replacement.slice(i, i + 1 + consumed); // 无此组 → 原样保留
      } else {
        out += captures[idx - 1] ?? '';
      }
      i += consumed;
    } else if (next === '<') {
      const end = replacement.indexOf('>', i + 2);
      if (namedCaptures === undefined || end < 0) {
        out += ch;
        continue;
      }
      const name = replacement.slice(i + 2, end);
      if (!(name in namedCaptures)) {
        out += replacement.slice(i, end + 1); // 无此命名组 → 原样保留
      } else {
        out += namedCaptures[name] ?? '';
      }
      i = end;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * 生成两种 diff 片段：
 *  - old: 在旧名中把「命中查找」的片段标 changed
 *  - new: 在新名中把「由替换产生」的片段标 changed
 *
 * ⚠️ 新名一侧不能用「公共前后缀切除」来算 —— 那会得出
 *    `Buttom.md → Butto{n}.md`（只高亮 n）这种虽然"最小"却**误导人**的结果。
 *    正确做法：以旧名的命中区间为锚点，按「未匹配的前缀/后缀」对齐到新名上，
 *    使高亮覆盖**整个被替换的 token**（`{Buttom}.md → {Button}.md`）。
 */
export function diffNames(oldName: string, newName: string, regex: RegExp): {
  oldDiff: DiffSegment[];
  newDiff: DiffSegment[];
} {
  const regions = matchRegions(oldName, regex);
  if (regions.length === 0) {
    return {
      oldDiff: [{ text: oldName, changed: false }],
      newDiff: [{ text: newName, changed: false }],
    };
  }

  const oldDiff: DiffSegment[] = [];
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];
    const prevEnd = i === 0 ? 0 : regions[i - 1].end;
    if (r.start > prevEnd) {
      oldDiff.push({ text: oldName.slice(prevEnd, r.start), changed: false });
    }
    oldDiff.push({ text: oldName.slice(r.start, r.end), changed: true });
  }
  const tailStart = regions[regions.length - 1].end;
  if (tailStart < oldName.length) {
    oldDiff.push({ text: oldName.slice(tailStart), changed: false });
  }

  // 新名：用「匹配区间之外的部分」作为锚，逐段定位
  const newDiff = alignToNew(oldName, newName, regions);
  return { oldDiff, newDiff };
}

interface Region {
  start: number;
  end: number;
}

/** 找出所有命中区间（空匹配会被跳过，调用方本就不该接受空匹配模式） */
function matchRegions(text: string, regex: RegExp): Region[] {
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  const out: Region[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    out.push({ start: m.index, end: m.index + m[0].length });
    if (out.length > 200) {
      break; // 防御异常多的匹配
    }
  }
  return out;
}

/**
 * 把旧名的命中区间对齐到新名上。
 *
 * 思路：命中区间之间的「文本夹层」在替换后保持不变，
 *   所以按顺序在新名里查找这些夹层，夹层之间的部分就是变化区。
 * 兜底：定位失败时，退化为「公共前后缀」策略。
 */
function alignToNew(oldName: string, newName: string, regions: Region[]): DiffSegment[] {
  // 构造夹层序列：head(首个匹配前) + middle... + tail(末个匹配后)
  const gaps: string[] = [];
  let prevEnd = 0;
  for (const r of regions) {
    gaps.push(oldName.slice(prevEnd, r.start));
    prevEnd = r.end;
  }
  gaps.push(oldName.slice(prevEnd));

  const segs: DiffSegment[] = [];
  let cursor = 0;
  const trailingGap = gaps[gaps.length - 1];
  // 新名末尾必须为 trailingGap 留出的边界（只有当它是真正的后缀时）
  const bodyEnd = trailingGap && newName.endsWith(trailingGap)
    ? newName.length - trailingGap.length
    : newName.length;

  for (let i = 0; i < regions.length; i++) {
    // 变化区 = 从 cursor 到「下一段夹层在新名中的位置」
    const nextGap = gaps[i + 1];
    let gapIdx: number;

    if (nextGap === '') {
      // 夹层为空：变化区延伸到"主体末尾"（而不是整串末尾），
      // 把 trailingGap 保留给最后一段
      gapIdx = bodyEnd;
    } else if (i === regions.length - 1 && trailingGap) {
      // 最后一段夹层（新名后缀）：只认「贴在新名末尾」的位置
      gapIdx = bodyEnd;
    } else {
      gapIdx = newName.indexOf(nextGap, cursor);
    }

    if (gapIdx < cursor) {
      gapIdx = -1;
    }
    if (gapIdx < 0) {
      // 锚点定位失败 → 剩余主体视为变化区
      if (cursor < bodyEnd) {
        segs.push({ text: newName.slice(cursor, bodyEnd), changed: true });
      }
      cursor = bodyEnd;
      break;
    }

    // 前导夹层（gaps[i]）应原样出现在 cursor 处
    const leading = gaps[i];
    if (leading && newName.startsWith(leading, cursor)) {
      segs.push({ text: leading, changed: false });
      cursor += leading.length;
    }
    if (gapIdx > cursor) {
      segs.push({ text: newName.slice(cursor, gapIdx), changed: true });
      cursor = gapIdx;
    }
  }

  if (cursor < newName.length) {
    segs.push({ text: newName.slice(cursor), changed: false });
  }

  return mergeSegs(segs.length > 0 ? segs : [{ text: newName, changed: false }]);
}

function mergeSegs(segs: DiffSegment[]): DiffSegment[] {
  const out: DiffSegment[] = [];
  for (const s of segs) {
    if (s.text === '') {
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.changed === s.changed) {
      last.text += s.text;
    } else {
      out.push({ text: s.text, changed: s.changed });
    }
  }
  return out;
}

/* ---------------------- 非法文件名校验 ---------------------- */

const ILLEGAL_CHARS = /[\\/:*?"<>|]/;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function validateName(name: string): string | undefined {
  if (name.length === 0) {
    return '名称不能为空';
  }
  if (name.length > 255) {
    return '名称过长（超过 255 字符）';
  }
  if (ILLEGAL_CHARS.test(name)) {
    return '包含非法字符（\\ / : * ? " < > |）';
  }
  if (name.endsWith(' ') || name.endsWith('.')) {
    return '不能以空格或点结尾';
  }
  const base = name.replace(/\.[^.]*$/, '');
  if (RESERVED.test(base)) {
    return '使用了系统保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）';
  }
  return undefined;
}
