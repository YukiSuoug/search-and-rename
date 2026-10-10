/**
 * 核心算法自测（纯 node，无需 vscode 运行时）。
 * 运行：npm run compile && npm run test:core
 *
 * 覆盖设计文档里点名的易回归点。
 */

import {
  compilePattern,
  escapeRegExp,
  splitName,
  replaceSubject,
  applyPreserveCase,
  validateName,
  diffNames,
} from '../core/regex';
import { buildPlan, buildCandidates, compareDeepFirst, depthOf } from '../core/plan';
import { detectConflicts, detectDuplicateTargets } from '../core/conflict';
import { globToRegExp } from '../core/glob';
import { buildTree, ancestorDiffFor } from '../core/tree';
import type { Entry, MatchOptions, RenamePair } from '../types';

let passed = 0;
let failed = 0;

function ok(name: string, cond: boolean, extra?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${extra ? `  → ${extra}` : ''}`);
  }
}

function eq<T>(name: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(name, a === e, `期望 ${e}，实际 ${a}`);
}

function entry(fsPath: string, name: string, isDirectory: boolean): Entry {
  return {
    fsPath,
    uri: `file:///${fsPath}`,
    name,
    isDirectory,
    relPath: fsPath.replace('/root/', ''),
  };
}

function opts(partial: Partial<MatchOptions>): MatchOptions {
  return {
    find: '',
    replace: '',
    isRegex: false,
    caseSensitive: false,
    wholeWord: false,
    preserveCase: false,
    preserveExtension: true,
    matchTarget: 'both',
    ...partial,
  };
}

/* ============================ 1. 正则与替换 ============================ */

console.log('\n[1] 正则编译与替换');

{
  const { regex, matchesEmpty } = compilePattern('a', {
    isRegex: false,
    caseSensitive: false,
    wholeWord: false,
  });
  ok('字面量编译可匹配', regex.test('a'));
  ok('字面量不匹配空串', !matchesEmpty);

  const empty = compilePattern('', { isRegex: true, caseSensitive: false, wholeWord: false });
  ok('空正则被识别为匹配空串（必须拒绝）', empty.matchesEmpty);

  const dot = compilePattern('.*', { isRegex: true, caseSensitive: false, wholeWord: false });
  ok('.* 被识别为匹配空串', dot.matchesEmpty);

  const special = compilePattern('a.b', {
    isRegex: false,
    caseSensitive: false,
    wholeWord: false,
  });
  ok('非正则模式下 . 被转义', special.regex.test('a.b') && !special.regex.test('axb'));

  eq('escapeRegExp 正确', escapeRegExp('a.b*c'), 'a\\.b\\*c');
}

{
  const { regex } = compilePattern('(\\w+)_(\\w+)', {
    isRegex: true,
    caseSensitive: true,
    wholeWord: false,
  });
  eq('$1 $2 捕获组交换', replaceSubject('foo_bar', regex, '$2_$1', false), 'bar_foo');
}

{
  const { regex } = compilePattern('a', { isRegex: false, caseSensitive: false, wholeWord: false });
  eq('$$ 转义为字面 $', replaceSubject('a', regex, '$$1', false), '$1');
  eq('$& 为整体匹配', replaceSubject('a', regex, '[$&]', false), '[a]');
}

{
  const { regex } = compilePattern('b', { isRegex: false, caseSensitive: false, wholeWord: false });
  // 小写 b 命中大写 B，逐字符保留大小写 → X
  eq('preserveCase 命中大写字母保持大写', replaceSubject('aBc', regex, 'x', true), 'aXc');
  eq('applyPreserveCase 全大写', applyPreserveCase('FOO', 'bar'), 'BAR');
  eq('applyPreserveCase 首字母大写', applyPreserveCase('Foo', 'bar'), 'Bar');
  eq('applyPreserveCase 全小写', applyPreserveCase('foo', 'BAR'), 'bar');
}

/* ============================ 2. 名称切分 ============================ */

console.log('\n[2] 扩展名切分');

{
  eq('a.ts', splitName('a.ts', true, false), { subject: 'a', ext: '.ts' });
  eq('a.test.ts → 只切最后一个点', splitName('a.test.ts', true, false), {
    subject: 'a.test',
    ext: '.ts',
  });
  eq('隐藏文件 .env 不切', splitName('.env', true, false), { subject: '.env', ext: '' });
  eq('文件夹不切扩展名', splitName('my.folder', true, true), {
    subject: 'my.folder',
    ext: '',
  });
  eq('无扩展名', splitName('README', true, false), { subject: 'README', ext: '' });
  eq('关闭保留扩展名时整体当主体', splitName('a.ts', false, false), {
    subject: 'a.ts',
    ext: '',
  });
}

/* ============================ 3. 计划与排序 ============================ */

console.log('\n[3] 路径映射与「先深后浅」排序');

{
  const entries = [
    entry('/root/src/Buttom', 'Buttom', true),
    entry('/root/src/Buttom/Buttom.tsx', 'Buttom.tsx', false),
  ];
  const o = opts({ find: 'Buttom', replace: 'Button' });
  const cands = buildCandidates(entries, o);
  const plan = buildPlan(cands);

  eq('生成 2 条计划（文件夹 + 文件名）', plan.length, 2);
  ok(
    '文件先于其父目录执行',
    plan[0].fromPath === '/root/src/Buttom/Buttom.tsx' &&
      plan[1].fromPath === '/root/src/Buttom',
    JSON.stringify(plan.map((p) => p.fromPath))
  );
  ok('深度：子 5 段 > 父 4 段', depthOf(plan[0].fromPath) > depthOf(plan[1].fromPath));
}

{
  // 深度的边界：a/b 与 a/b/c
  const a: RenamePair = {
    fromPath: '/r/a/b',
    toPath: '/r/a/bb',
    fromUri: '',
    toUri: '',
    oldName: 'b',
    newName: 'bb',
    relPath: 'a/b',
    isDirectory: true,
  };
  const b: RenamePair = { ...a, fromPath: '/r/a/b/c', toPath: '/r/a/b/cc', relPath: 'a/b/c' };
  const sorted = [a, b].sort(compareDeepFirst);
  ok('compareDeepFirst 把更深者排前', sorted[0].fromPath === '/r/a/b/c');
}

{
  // 无变化的不进计划
  const entries = [entry('/root/x.ts', 'x.ts', false)];
  const cands = buildCandidates(entries, opts({ find: 'x', replace: 'x' }));
  eq('同名替换不生成计划', buildPlan(cands).length, 0);
}

{
  // 保留扩展名：util → utils，util.test.ts 只改主体
  const entries = [entry('/root/util.test.ts', 'util.test.ts', false)];
  const cands = buildCandidates(
    entries,
    opts({ find: 'util', replace: 'utils', preserveExtension: true })
  );
  eq('util.test.ts → utils.test.ts', cands[0]?.newName, 'utils.test.ts');
}

{
  // 匹配范围过滤
  const entries = [
    entry('/root/comp', 'comp', true),
    entry('/root/comp.ts', 'comp.ts', false),
  ];
  const onlyFiles = buildCandidates(entries, opts({ find: 'comp', replace: 'x', matchTarget: 'filesOnly' }));
  eq('仅文件：1 条', onlyFiles.length, 1);
  ok('仅文件：命中的是文件', !onlyFiles[0].entry.isDirectory);

  const onlyFolders = buildCandidates(
    entries,
    opts({ find: 'comp', replace: 'x', matchTarget: 'foldersOnly' })
  );
  eq('仅文件夹：1 条', onlyFolders.length, 1);
  ok('仅文件夹：命中的是文件夹', onlyFolders[0].entry.isDirectory);
}

/* ============================ 4. 冲突检测 ============================ */

console.log('\n[4] 冲突检测');

{
  // 批次内撞名：a.ts 和 c.ts 都 → b.ts（b.ts 本身不改名）
  const entries = [
    entry('/root/a.ts', 'a.ts', false),
    entry('/root/c.ts', 'c.ts', false),
  ];
  const cands = buildCandidates(
    entries,
    opts({ find: '^(a|c)$', replace: 'b', isRegex: true, preserveExtension: true })
  );
  const plan = buildPlan(cands);
  eq('两条计划都指向 b.ts', plan.length, 2);
  const dup = detectDuplicateTargets(plan);
  eq('两个源撞同一目标都被标记', dup.size, 2);
  ok('冲突类型为 duplicateTarget', dup.get('/root/a.ts') === 'duplicateTarget');
  ok('冲突类型为 duplicateTarget (c)', dup.get('/root/c.ts') === 'duplicateTarget');
}

{
  // 目标已存在（且不在本批源中）
  const entries = [entry('/root/a.ts', 'a.ts', false)];
  const cands = buildCandidates(entries, opts({ find: 'a', replace: 'b', preserveExtension: false }));
  const plan = buildPlan(cands);
  // 目标 /root/b.ts ... 注意 find 'a' replace 'b' → "a.ts" 里 a→b 得 "b.ts"
  const probe = (p: string): boolean => p === '/root/b.ts';
  const res = detectConflicts(cands, plan, { exists: probe, caseSensitiveFs: true });
  ok('命中 targetExists', res.conflicts.get('/root/a.ts')?.kind === 'targetExists');
}

{
  // 目标存在于磁盘，且不在本批次源集合中 → 必须报 targetExists
  const entries = [entry('/root/a.ts', 'a.ts', false)];
  const cands = buildCandidates(entries, opts({ find: 'a', replace: 'b', preserveExtension: false }));
  const plan = buildPlan(cands);
  const res = detectConflicts(cands, plan, {
    exists: (p) => p === '/root/b.ts',
    caseSensitiveFs: true,
  });
  ok(
    '目标存在于磁盘且非本批源 → 报 targetExists',
    res.conflicts.get('/root/a.ts')?.kind === 'targetExists'
  );
}

{
  // 本批次源豁免：a.ts → b.ts 且 b.ts → c.ts
  const entries = [entry('/root/a.ts', 'a.ts', false), entry('/root/b.ts', 'b.ts', false)];
  const cands = buildCandidates(
    entries,
    opts({ find: '^a$', replace: 'b', isRegex: true, preserveExtension: true })
  );
  const extra = buildCandidates(
    [entry('/root/b.ts', 'b.ts', false)],
    opts({ find: '^b$', replace: 'c', isRegex: true, preserveExtension: true })
  );
  const plan = buildPlan([...cands, ...extra]);
  const res = detectConflicts([...cands, ...extra], plan, {
    exists: (p) => p === '/root/b.ts',
    caseSensitiveFs: true,
  });
  ok(
    'a→b 且 b→c 时，a 不因 b 存在而报冲突（b 是本批源）',
    !res.conflicts.has('/root/a.ts'),
    JSON.stringify([...res.conflicts.keys()])
  );
}

{
  // 仅大小写变化，大小写不敏感 FS
  const entries = [entry('/root/Button.tsx', 'Button.tsx', false)];
  const cands = buildCandidates(
    entries,
    opts({ find: 'Button', replace: 'button', preserveExtension: true })
  );
  const plan = buildPlan(cands);
  const res = detectConflicts(cands, plan, { exists: () => false, caseSensitiveFs: false });
  ok('caseOnly 被标记', res.conflicts.get('/root/Button.tsx')?.kind === 'caseOnly');
}

{
  // 非法名
  const entries = [entry('/root/a.ts', 'a.ts', false)];
  const cands = buildCandidates(
    entries,
    opts({ find: 'a', replace: 'con', preserveExtension: false })
  );
  const invalid = detectConflicts(cands, buildPlan(cands), {
    exists: () => false,
    caseSensitiveFs: true,
  });
  ok('CON 保留名被判非法', invalid.invalid.length === 1);
}

console.log('\n[5] 名称合法性');

{
  ok('空名非法', !!validateName(''));
  ok('含 / 非法', !!validateName('a/b'));
  ok('结尾空格非法', !!validateName('ab '));
  ok('正常名合法', !validateName('Button.tsx'));
  ok('.env 合法', !validateName('.env'));
}

console.log('\n[6] glob → RegExp');

{
  const re = globToRegExp('**/node_modules/**');
  ok('**/node_modules/** 命中深层', !!re && re.test('/root/packages/x/node_modules/a.js'));
  ok('**/node_modules/** 命中顶层', !!re && re.test('/root/node_modules/a.js'));
  const re2 = globToRegExp('**/*.log');
  ok('**/*.log 命中', !!re2 && re2.test('/root/a/b/c.log'));
  ok('**/*.log 不命中 .txt', !!re2 && !re2.test('/root/a/b/c.txt'));
}

/* ============================ 7. 树形行构建 ============================ */

console.log('\n[7] 树形行构建（父目录改名 → 子树归属 + 祖先高亮）');

/** 造一个 RenamePair */
function pair(fromPath: string, newName: string, relPath: string, isDirectory: boolean): RenamePair {
  return {
    fromPath,
    toPath: fromPath,
    fromUri: `file://${fromPath}`,
    toUri: `file://${fromPath}`,
    oldName: fromPath.slice(fromPath.lastIndexOf('/') + 1),
    newName,
    relPath,
    isDirectory,
  };
}

/** 用与 preview.ts 相同的方式算 nameDiff */
function diffsFor(p: RenamePair) {
  const { regex } = compilePattern(p.oldName, {
    isRegex: false,
    caseSensitive: true,
    wholeWord: false,
  });
  return diffNames(p.oldName, p.newName, regex);
}

{
  // 场景：src/Buttom 目录改名，且其中 a.ts 自身不改名
  const dir = pair('/root/src/Buttom', 'Button', 'src/Buttom', true);
  const file = pair('/root/src/Buttom/a.ts', 'a.ts', 'src/Buttom/a.ts', false);
  const nameDiffs = new Map([
    [dir.fromPath, diffsFor(dir)],
    [file.fromPath, diffsFor(file)],
  ]);
  const rows = buildTree({
    pairs: [file, dir], // 注意：故意传入「先深后浅」的顺序
    conflicts: new Map(),
    nameDiffs,
  });

  eq('生成 2 行（1 分组头 + 1 子项）', rows.length, 2);
  ok('第一行是分组头', rows[0].isGroup && rows[0].depth === 0);
  ok('分组头是被改名的文件夹', rows[0].key === '/root/src/Buttom');
  ok('第二行是子项且缩进一级', !rows[1].isGroup && rows[1].depth === 1);
  ok('子项归属到分组', rows[1].key === '/root/src/Buttom/a.ts');
}

{
  // 祖先高亮：文件 a.ts 自己名字没变，但父目录 Buttom → Button
  const dir = pair('/root/src/Buttom', 'Button', 'src/Buttom', true);
  const file = pair('/root/src/Buttom/a.ts', 'a.ts', 'src/Buttom/a.ts', false);
  const nameDiffs = new Map([
    [dir.fromPath, diffsFor(dir)],
    [file.fromPath, diffsFor(file)],
  ]);
  const rows = buildTree({ pairs: [file, dir], conflicts: new Map(), nameDiffs });
  const leaf = rows.find((r) => !r.isGroup)!;

  ok('子项带 ancestorDiff', leaf.ancestorDiff.length > 0);
  const changed = leaf.ancestorDiff.filter((s) => s.changed).map((s) => s.text).join('');
  ok('祖先 diff 命中被改名的目录名 Buttom', changed === 'Buttom', changed);
  const plain = leaf.ancestorDiff.filter((s) => !s.changed).map((s) => s.text).join('');
  ok('祖先 diff 的未变部分包含 src/', plain.includes('src/'), plain);
  // 新名一侧：父目录换成 Button
  eq('该行的新名即原名（自身未改名）', leaf.newName, 'a.ts');
}

{
  // ancestorDiffFor 直接单测：只有被改名的段标 changed
  const renamedDirs = new Map<string, RenamePair>([
    ['/root/src/Buttom', pair('/root/src/Buttom', 'Button', 'src/Buttom', true)],
  ]);
  const segs = ancestorDiffFor('/root/src/Buttom/sub/a.ts', renamedDirs);
  const changedTexts = segs.filter((s) => s.changed).map((s) => s.text);
  eq('只有 Buttom 段被标记', changedTexts, ['Buttom']);
  const plainText = segs.filter((s) => !s.changed).map((s) => s.text).join('');
  ok('未变段含 src/ 与 sub/', plainText.includes('src/') && plainText.includes('sub/'), plainText);
}


{
  // 嵌套：a/Buttom/b/Buttom/c 两层都改名
  const outer = pair('/root/a/Buttom', 'Button', 'a/Buttom', true);
  const inner = pair('/root/a/Buttom/b/Buttom', 'Button', 'a/Buttom/b/Buttom', true);
  const file = pair('/root/a/Buttom/b/Buttom/c.ts', 'c.ts', 'a/Buttom/b/Buttom/c.ts', false);
  const nameDiffs = new Map([outer, inner, file].map((p) => [p.fromPath, diffsFor(p)]));

  const rows = buildTree({ pairs: [file, inner, outer], conflicts: new Map(), nameDiffs });

  eq('3 行', rows.length, 3);
  eq('外层 depth 0', rows[0].depth, 0);
  eq('内层 depth 1', rows[1].depth, 1);
  eq('文件 depth 2', rows[2].depth, 2);
  const changedTexts = rows[2].ancestorDiff
    .filter((s) => s.changed)
    .map((s) => s.text)
    .join('|');
  eq('文件行祖先 diff 同时标记两层 Buttom', changedTexts, 'Buttom|Buttom');
}

{
  // 单条目目录不值得单独占一行分组头 → 降级成行内前缀 dirHint
  const f1 = pair('/root/x/Buttom.ts', 'Button.ts', 'x/Buttom.ts', false);
  const f2 = pair('/root/Buttom.md', 'Button.md', 'Buttom.md', false);
  const nameDiffs = new Map([f1, f2].map((p) => [p.fromPath, diffsFor(p)]));
  const rows = buildTree({ pairs: [f1, f2], conflicts: new Map(), nameDiffs });

  eq('目录 x 只有 1 个条目 → 不产生分组头', rows.filter((r) => r.isContainer).length, 0);
  eq('共 2 行，全部平铺', rows.length, 2);
  ok('全部 depth 为 0（不额外缩进）', rows.every((r) => r.depth === 0));

  const solo = rows.find((r) => r.key === f1.fromPath)!;
  eq('单条目目录的叶子带 dirHint', solo.dirHint, 'x');
  // 关键回归：没有分组头之后，行内也不能出现绝对路径
  ok(
    'dirHint 不是绝对路径',
    !String(solo.dirHint).includes('/root'),
    String(solo.dirHint)
  );
  // 叶子保留完整相对路径（供 tooltip / QuickPick），行内只渲染 old → new
  eq('叶子保留完整相对路径', solo.relPath, 'x/Buttom.ts');

  // 根目录下的文件不带 dirHint
  eq('工作区根下的叶子无 dirHint', rows.find((r) => r.key === f2.fromPath)?.dirHint, undefined);
}

{
  // 同一目录下的多个文件共用**一个**容器头 —— 目录不重复出现（本次「太挤」的修复点）
  const a = pair('/ws/deep/a/b/mod/ot_body_029.ccl', 'ot_body_1.ccl', 'deep/a/b/mod/ot_body_029.ccl', false);
  const b = pair('/ws/deep/a/b/mod/ot_body_029.ctc', 'ot_body_1.ctc', 'deep/a/b/mod/ot_body_029.ctc', false);
  const c = pair('/ws/deep/a/b/mod/ot_body_029.mod3', 'ot_body_1.mod3', 'deep/a/b/mod/ot_body_029.mod3', false);
  const nameDiffs = new Map([a, b, c].map((p) => [p.fromPath, diffsFor(p)]));
  const rows = buildTree({ pairs: [a, b, c], conflicts: new Map(), nameDiffs });

  eq('3 个文件 → 1 容器头 + 3 叶子', rows.length, 4);
  eq('只有 1 个容器头（目录合并）', rows.filter((r) => r.isContainer).length, 1);
  // 中间那些「没有条目」的目录（deep / a / b）不单独成层
  eq('中间层被折叠，只显示 mod', rows[0].relPath, 'deep/a/b/mod');
  eq('容器头条目数 = 3', rows[0].containerCount, 3);
  ok(
    '所有叶子都在容器头之下（缩进一级）',
    rows.slice(1).every((r) => !r.isGroup && r.depth === 1)
  );
  // 关键回归：叶子行的 ancestorDiff 不得含绝对路径片段
  const flat = rows
    .slice(1)
    .flatMap((r) => r.ancestorDiff.map((s) => s.text))
    .join('');
  ok('叶子的 ancestorDiff 不含绝对路径', !flat.includes('/ws/'), flat);
}

{
  // 改名目录 + 内部子目录（多条目）：改名头 → 容器头 → 叶子，逐级缩进
  const dir = pair('/ws/ot029', 'ot1', 'ot029', true);
  const a = pair('/ws/ot029/body/mod/ot_body_029.ccl', 'ot_body_1.ccl', 'ot029/body/mod/ot_body_029.ccl', false);
  const b = pair('/ws/ot029/body/mod/ot_body_029.ctc', 'ot_body_1.ctc', 'ot029/body/mod/ot_body_029.ctc', false);
  const nameDiffs = new Map([dir, a, b].map((p) => [p.fromPath, diffsFor(p)]));
  const rows = buildTree({ pairs: [a, b, dir], conflicts: new Map(), nameDiffs });

  eq('4 行（改名头 + 容器头 + 2 叶子）', rows.length, 4);
  ok(
    '第 1 行是改名头且显示旧名→新名',
    rows[0].isGroup && !rows[0].isContainer && rows[0].newName === 'ot1'
  );
  ok(
    '第 2 行是容器头，标签相对父节点',
    rows[1].isContainer === true && rows[1].relPath === 'body/mod'
  );
  eq('容器头嵌套在改名头下一级', rows[1].depth, 1);
  eq('容器头条目数 2（不是 solo）', rows[1].containerCount, 2);
  ok('叶子再缩进一级', rows[2].depth === 2 && rows[3].depth === 2);
  eq('叶子 key 是真实路径', rows[2].key, a.fromPath);
  eq('容器头的 key 是合成值，不是真实 fsPath', rows[1].key, 'dir::ot029/body/mod');
}

{
  // 冲突统计：分组头统计子树内冲突数
  const dir = pair('/root/Buttom', 'Button', 'Buttom', true);
  const a = pair('/root/Buttom/a.ts', 'a.ts', 'Buttom/a.ts', false);
  const b = pair('/root/Buttom/b.ts', 'b.ts', 'Buttom/b.ts', false);
  const nameDiffs = new Map([dir, a, b].map((p) => [p.fromPath, diffsFor(p)]));
  const conflicts = new Map([
    [a.fromPath, { kind: 'targetExists' as const, message: '目标已存在' }],
  ]);
  const rows = buildTree({ pairs: [a, b, dir], conflicts, nameDiffs });
  eq('分组头统计到 1 项冲突', rows[0].childConflictCount, 1);
  ok('冲突子项自身带 conflict 标记', !!rows.find((r) => r.key === a.fromPath)?.conflict);
  ok('无冲突子项不带标记', !rows.find((r) => r.key === b.fromPath)?.conflict);
}

{
  // 分组头 hasChildren 正确（空文件夹改名 → 无子项，不画箭头）
  const emptyDir = pair('/root/Buttom', 'Button', 'Buttom', true);
  const nameDiffs = new Map([[emptyDir.fromPath, diffsFor(emptyDir)]]);
  const rows = buildTree({ pairs: [emptyDir], conflicts: new Map(), nameDiffs });
  eq('空文件夹改名 → 1 行分组头', rows.length, 1);
  ok('分组头 hasChildren=false', rows[0].isGroup && !rows[0].hasChildren);
}

{
  // 边界：空输入
  const rows = buildTree({ pairs: [], conflicts: new Map(), nameDiffs: new Map() });
  eq('空输入 → 无行', rows.length, 0);
}

/* ============================ 8. diff 高亮（新名一侧要对齐到整个 token） ============================ */

console.log('\n[8] diff 高亮');

/** 把 diff 片段渲染成 `前缀{t高亮}后缀` 的紧凑串 */
function renderDiff(segs: { text: string; changed: boolean }[]): string {
  return segs.map((s) => (s.changed ? `{${s.text}}` : s.text)).join('');
}

function diffPair(oldName: string, newName: string, find: string, isRegex = false) {
  const { regex } = compilePattern(find, { isRegex, caseSensitive: true, wholeWord: false });
  return diffNames(oldName, newName, regex);
}

{
  const d = diffPair('Buttom.md', 'Button.md', 'Buttom');
  eq('旧名高亮整个 token', renderDiff(d.oldDiff), '{Buttom}.md');
  eq('新名也高亮整个 token（不是只高亮 n）', renderDiff(d.newDiff), '{Button}.md');
}

{
  const d = diffPair('ButtomHelper.ts', 'ButtonHelper.ts', 'Buttom');
  eq('前缀替换：旧名', renderDiff(d.oldDiff), '{Buttom}Helper.ts');
  eq('前缀替换：新名', renderDiff(d.newDiff), '{Button}Helper.ts');
}

{
  const d = diffPair('my_Buttom_x.ts', 'my_Button_x.ts', 'Buttom');
  eq('夹层保持：旧名', renderDiff(d.oldDiff), 'my_{Buttom}_x.ts');
  eq('夹层保持：新名', renderDiff(d.newDiff), 'my_{Button}_x.ts');
}

{
  // 整体替换（新名不再以原后缀结尾）→ 整个新名视为变化区
  const d = diffPair('Buttom.tsx', 'x.ts', 'Buttom');
  eq('整体替换：旧名', renderDiff(d.oldDiff), '{Buttom}.tsx');
  eq('整体替换：新名', renderDiff(d.newDiff), '{x.ts}');
}

{
  // 后缀被保留时应留在未变化区
  const d = diffPair('Buttom.tsx', 'x.tsx', 'Buttom');
  eq('保留后缀：新名', renderDiff(d.newDiff), '{x}.tsx');
}

{
  // 捕获组重排：foo_bar → bar_foo
  const d = diffPair('foo_bar.ts', 'bar_foo.ts', '(\\w+)_(\\w+)', true);
  eq('捕获组：旧名整体高亮', renderDiff(d.oldDiff), '{foo_bar}.ts');
  eq('捕获组：新名整体高亮', renderDiff(d.newDiff), '{bar_foo}.ts');
}

{
  // 多次命中
  const d = diffPair('ButtomButtom.ts', 'XY.ts', 'Buttom');
  eq('多次命中：旧名两处高亮', renderDiff(d.oldDiff), '{Buttom}{Buttom}.ts');
  eq('多次命中：新名（后缀 .ts 保留在未变化区）', renderDiff(d.newDiff), '{XY}.ts');
}

{
  // 无命中（不应崩）
  const d = diffPair('abc.ts', 'abc.ts', 'zzz');
  eq('无命中：旧名原样', renderDiff(d.oldDiff), 'abc.ts');
  eq('无命中：新名原样', renderDiff(d.newDiff), 'abc.ts');
}

{
  // 新名里含有与夹层相同的子串（锚点歧义）—— 不应错乱
  const d = diffPair('a-x-b', 'a-b', 'x-');
  const oldR = renderDiff(d.oldDiff);
  ok('歧义锚点：旧名高亮正确', oldR === 'a-{x-}b', oldR);
  ok('歧义锚点：新名不崩且拼回原串', d.newDiff.map((s) => s.text).join('') === 'a-b');
}


/* ==================== 9. 替换串展开：两条路径必须一致 ==================== */

console.log('\n[9] 替换串展开（$ 占位符语义，与 preserveCase 无关）');

/**
 * 核心不变量：`preserveCase` 只应该影响**大小写**，
 * 绝不应该改变替换串里 `$` 的**展开方式**。
 *
 * 这条不变量曾经被破坏：关 preserveCase 时走原生 `String.replace`，
 * 开时走手写展开器，而后者只认 `$$`/`$&`/单位数 `$1`~`$9`。
 * 结果勾一下「保留大小写」就静默生成了错误的文件名。
 */
{
  const cases: Array<[string, RegExp, string, string]> = [
    ['单数字捕获组 $1', /(a)(b)/, 'ab', '[$1]'],
    ['两位数捕获组 $10（真有 10 组）', /(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)/, 'abcdefghij', '[$10]'],
    ['两位数退化为一位 $10（只有 2 组）', /(a)(b)/, 'ab', '[$10]'],
    ['不存在的组 $3', /(a)(b)/, 'ab', '[$3]'],
    ['$0 按规范保留原样', /(a)/, 'a', '[$0]'],
    ['命名捕获组 $<x>', /(?<x>a)(b)/, 'ab', '[$<x>]'],
    ['不存在的命名组 $<y>', /(?<x>a)/, 'a', '[$<y>]'],
    ['整体匹配 $&', /(b)/, 'abc', '[$&]'],
    ['匹配前文本 $` ', /(b)/, 'abc', '[$`]'],
    ['匹配后文本 $\'', /(b)/, 'abc', "[$']"],
    ['字面 $', /(b)/, 'abc', '[$$]'],
    ['结尾孤立的 $', /(b)/, 'abc', 'x$'],
    ['无捕获组的普通文本', /(b)/, 'abc', 'z'],
  ];

  for (const [label, re, subject, repl] of cases) {
    const off = replaceSubject(subject, new RegExp(re.source, re.flags), repl, false);
    const on = replaceSubject(subject, new RegExp(re.source, re.flags), repl, true);
    // 用例里的匹配都是小写，preserveCase 不该产生任何差异
    ok(`${label}：开/关结果一致`, off === on, `关=${off} 开=${on}`);
  }

  // 逐个钉住语义本身（防止"两条路径一起错"）。
  // 注意：断言的是**整个结果串**，所以未匹配的前后文会原样保留 ——
  // 例如 'abc' 里替换 'b' 为 $`（匹配前文本 'a'）得到的是 'a'+'a'+'c' = 'aac'。
  eq('$10 取第 10 组', replaceSubject('abcdefghij', /(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)/, '$10', false), 'j');
  eq('只有 2 组时 $10 = 第1组 + "0"', replaceSubject('ab', /(a)(b)/, '$10', false), 'a0');
  eq('$<x> 取命名组', replaceSubject('ab', /(?<x>a)(b)/, '$<x>', false), 'a');
  eq('无命名组时 $<y> 原样', replaceSubject('a', /(?<x>a)/, '$<y>', false), '$<y>');
  eq('$` = 匹配前文本', replaceSubject('abc', /(b)/, '$`', false), 'aac');
  eq("$' = 匹配后文本", replaceSubject('abc', /(b)/, "$'", false), 'acc');
  eq('$$ = 字面 $', replaceSubject('abc', /(b)/, '$$', false), 'a$c');
  eq('$0 原样保留', replaceSubject('a', /(a)/, '$0', false), '$0');
  eq('结尾孤立 $ 原样保留', replaceSubject('abc', /(b)/, 'x$', false), 'ax$c');

  // 多次命中时，$` 的 position 必须跟着每个匹配走，不能都用第一个
  eq(
    '多次命中：$` 按各自位置展开',
    replaceSubject('aXaY', /a/g, '<$`>', false),
    '<>X<aX>Y'
  );

  // preserveCase 仍然要生效（别把功能改没了）。
  // ⚠️ 它是**逐字符**对齐匹配串的大小写形状，不是"整串变大写"：
  //    applyPreserveCase('Buttom', 'button') → 'Button'（只有首字母跟着大写）
  eq('保留大小写：全大写匹配', applyPreserveCase('ABC', 'xyz'), 'XYZ');
  eq(
    '保留大小写：逐字符对齐（首字母大写 → 首字母大写）',
    replaceSubject('Buttom', /(Buttom)/, 'button', true),
    'Button'
  );
  eq('保留大小写：全小写匹配 → 结果全小写', replaceSubject('buttom', /(buttom)/, 'BUTTON', true), 'button');
}


console.log(`\n================================`);
console.log(`通过 ${passed}，失败 ${failed}`);
console.log(`================================\n`);
process.exit(failed === 0 ? 0 : 1);
