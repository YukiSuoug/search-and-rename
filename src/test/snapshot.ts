/**
 * 渲染快照测试：用真实场景数据跑通 buildCandidates → buildPlan → buildTree，
 * 并把结果以纯文本"画"出来，人眼可快速核对树的形状。
 *
 * 运行：node ./out/test/snapshot.js
 */

import { buildCandidates, buildPlan } from '../core/plan';
import { buildTree } from '../core/tree';
import { compilePattern, diffNames } from '../core/regex';
import type { DiffSegment, Entry, MatchOptions } from '../types';

function entry(fsPath: string, isDirectory: boolean): Entry {
  const name = fsPath.slice(fsPath.lastIndexOf('/') + 1);
  return {
    fsPath,
    uri: `file://${fsPath}`,
    name,
    isDirectory,
    relPath: fsPath.replace('/ws/', ''),
  };
}

const fixtures: Entry[] = [
  entry('/ws/src/Buttom', true),
  entry('/ws/src/Buttom/Buttom.tsx', false),
  entry('/ws/src/Buttom/styles.css', false),
  entry('/ws/src/Buttom/nested/Buttom.test.ts', false),
  entry('/ws/src/utils/ButtomHelper.ts', false),
  entry('/ws/docs/Buttom.md', false),
  entry('/ws/README.md', false),
];

function run(
  find: string,
  replace: string,
  target: MatchOptions['matchTarget'],
  fixturesOverride?: Entry[],
  title?: string
): void {
  const opts: MatchOptions = {
    find,
    replace,
    isRegex: false,
    caseSensitive: true,
    wholeWord: false,
    preserveCase: false,
    preserveExtension: true,
    matchTarget: target,
  };

  const cands = buildCandidates(fixturesOverride ?? fixtures, opts);
  const plan = buildPlan(cands);
  const { regex } = compilePattern(find, {
    isRegex: false,
    caseSensitive: true,
    wholeWord: false,
  });
  const nameDiffs = new Map<string, { oldDiff: DiffSegment[]; newDiff: DiffSegment[] }>();
  for (const p of plan) {
    nameDiffs.set(p.fromPath, diffNames(p.oldName, p.newName, regex));
  }
  const rows = buildTree({ pairs: plan, conflicts: new Map(), nameDiffs });

  console.log(`\n═══ ${title ?? `find="${find}" → replace="${replace}" (target=${target})`} ═══`);
  console.log(`  计划 ${plan.length} 条，树行 ${rows.length} 条\n`);

  for (const r of rows) {
    const indent = '  '.repeat(r.depth);
    const caret = r.isGroup ? (r.hasChildren ? '▼ ' : '· ') : '  ';
    const kind = r.isDirectory ? '📁' : '📄';

    const oldName = r.oldDiff.map((s) => (s.changed ? `{${s.text}}` : s.text)).join('');
    const newName = r.newDiff.map((s) => (s.changed ? `{${s.text}}` : s.text)).join('');

    if (r.isContainer) {
      // 容器头 = 纯目录分组（该目录自身不重命名），只报路径与条目数
      console.log(
        `  ${indent}${caret}${kind} ${r.relPath}/  [目录分组 · ${r.containerCount} 项]`
      );
      continue;
    }

    // 改名头：显示它自己的相对路径 + 旧名→新名
    // 叶子：只显示 old → new。祖先路径**不再**渲染到行内（目录已由分组头给出），
    // 这正是「太挤」的修复点 —— 这里刻意与真实面板保持一致，快照才有核对价值。
    const label = r.isGroup ? `${r.relPath}  ` : '';
    const hint = r.dirHint ? `${r.dirHint}/` : '';

    console.log(`  ${indent}${caret}${kind} ${label}${hint}${oldName} → ${newName}`);
  }
}

/**
 * 回归场景（对应用户反馈的「太挤」）：
 * 深层目录 + 同一目录下多个文件。
 *
 * 旧实现会把 `d:/1/2/下载/.../mod/` 这样的**绝对路径**逐段刷在每一行上，
 * 一行折成三行；现在应该只出现一次目录，叶子各占一行。
 */
const deepFixtures: Entry[] = [
  entry('/ws/nativePC/otomo/equip/ot029/body/mod/ot_body_029.ccl', false),
  entry('/ws/nativePC/otomo/equip/ot029/body/mod/ot_body_029.ctc', false),
  entry('/ws/nativePC/otomo/equip/ot029/body/mod/ot_body_029.mod3', false),
  entry('/ws/nativePC/otomo/equip/ot029/body/mod/ot_body_029.mrl3', false),
];

/** 同上，但把中间目录也纳入候选 —— 演示「改名头 / 容器头嵌套」 */
const deepWithDirs: Entry[] = [
  entry('/ws/nativePC/otomo/equip/ot029', true),
  ...deepFixtures,
];

console.log('\n============================ 树形渲染快照 ============================');
run('Buttom', 'Button', 'both');
run('Buttom', 'Button', 'foldersOnly');
run('Buttom', 'Button', 'filesOnly');
run('029', '1', 'both', deepFixtures, '深层目录 + 同目录多文件（用户反馈的「太挤」场景）');
run('029', '1', 'both', deepWithDirs, '同上，且目录自身也改名（改名头 + 容器头嵌套）');
console.log('\n======================================================================\n');
