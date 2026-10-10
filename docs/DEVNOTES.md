# 开发者笔记

面向改这个项目的人。用户向的说明在 [README](../README.md)。

---

## 架构

```
src/
├─ extension.ts          激活 / 命令注册 / 上下文键 / 右键参数归一化
├─ panelProvider.ts      WebviewViewProvider（Activity Bar 面板 + 消息协议）
├─ quickPick.ts          右键菜单主流程（范围解析 → 4 步问答 → 树形预览 → 执行）
├─ types.ts              共享类型 + 消息协议
├─ core/
│  ├─ glob.ts            纯函数：glob → RegExp
│  ├─ regex.ts           纯函数：编译 / 替换 / 扩展名切分 / 保留大小写 / diff
│  ├─ plan.ts            纯函数：名称匹配 → 路径映射 → 先深后浅排序
│  ├─ conflict.ts        纯函数：四类冲突检测
│  ├─ tree.ts            纯函数：扁平计划 → 目录分组的树形行（改名头 / 容器头 / 单条目前缀）
│  ├─ walk.ts            递归扫描（并发池 + 排除 + 取消 + 限定 roots）
│  ├─ preview.ts         编排：扫描 → 计划 → 冲突 → 组装 PreviewItem/TreeRow
│  └─ execute.ts         WorkspaceEdit 批量执行 + 撤销日志
└─ test/
   ├─ core.test.ts       纯函数自测（107 项）
   ├─ snapshot.ts        树形渲染快照（人眼可核对的 ASCII 树）
   └─ smoke.ts           模块图冒烟（69 项：package.json 一致性、快捷键冲突、前端防复发）
tools/
├─ layout-check.mjs      真浏览器布局检查（CDP）
└─ make-icon.mjs         从 icon.svg 生成 Marketplace 用的 icon.png
```

`core/` 里除 `walk.ts` / `preview.ts` / `execute.ts` 外**都是纯函数**，不依赖 vscode，
可以直接在 node 里单测。新增纯逻辑一律放 `core/`；一旦某个纯函数文件混进 `vscode` import，
node 单测会直接 `Cannot find module 'vscode'`。

---

## 测试

```bash
npm test               # 编译 + 三套 node 测试
npm run test:core      # 107 项纯函数断言
npm run test:snapshot  # 树形渲染 ASCII 快照
npm run test:smoke     # 模块图冒烟 + package.json 一致性 + 快捷键冲突 + 前端防复发
npm run check:layout   # 真浏览器布局检查（需要本机有 Chrome/Edge，没有则自动跳过）
```

`check:layout` 用 **CDP 直连 headless Edge/Chrome**（Node 22 自带 `WebSocket`，
不引入 Playwright/Puppeteer），把真实的 `buildTree` 输出注入真实的 `renderRow`，
套真实的 `panel.css`，在 246px 宽下量每行的行数、新名是否被省略、有没有横向溢出。

> `smoke.ts` 里还有一批**源码级断言**（读 `media/*.css|js` 做正则检查）——
> webview 前端没有行为测试脚手架，这类 bug 又已复发多次，值得用最土的办法钉住。

---

## 打包与发布

```bash
node tools/make-icon.mjs   # 生成 resources/icon.png（Marketplace 只收 PNG）
npx vsce package           # 产出 search-and-rename-0.1.0.vsix
```

本地试用：VSCode → 扩展面板 → `...` → **从 VSIX 安装**。

⚠️ **`.vscodeignore` 里绝对不能排除 `out/`** ——
它是 VSIX 里唯一的可执行代码，排除掉就会发布一个"装上完全没反应"的空扩展。
而 F5 调试用的是工作区里的 `out/`，所以本地一切正常、只有装到别人机器上才炸。

`private` 字段会阻止 `vsce publish`，发布前必须删掉（目前已经没有）。
`publisher` 必须是已在 Marketplace 注册过的 ID。

---

## 实现要点（踩过的坑）

### 1. 必须「先深后浅」排序

父目录改名后，其所有子路径都会失效。若 `src/Buttom → src/Button` 与
`src/Buttom/Buttom.tsx → src/Buttom/Button.tsx` 同时存在，**必须先改文件、再改目录**。

`buildPlan()` 用 `compareDeepFirst()` 排序：路径段数降序 → 路径长度降序 → 字典序。

### 2. 用 `WorkspaceEdit` 而不是 `workspace.fs.rename`

| | `WorkspaceEdit.renameFile` | `workspace.fs.rename` |
|---|---|---|
| 打开中的编辑器 | ✅ 自动跟随 | ❌ 指向失效路径 |
| 脏缓冲区 | ✅ 保留 | ⚠️ 可能冲突 |
| 撤销 | ✅ 一次 Undo 全部 | ❌ 无 |
| 批量原子性 | ✅ 一批一次提交 | ❌ 逐个 |

### 3. 执行失败要「停止后续批次」

整批 `applyEdit` 返回 `false` 时，退化**逐项重试**以定位失败项，然后**停止后续批次**——
继续跑只会制造更多不一致状态。

### 4. 撤销不能朴素 `reverse()`

执行顺序是先深后浅，日志里父目录排在后面。撤销时重新按**深度降序**排序后再执行，
保证先撤销最深的后代、最后撤销浅层父目录。

### 5. 非法名与空匹配要提前拦

- 空查找串 / `.*` / `^` 等能匹配空串的正则 → `compilePattern` 的 `matchesEmpty` 直接拒绝，
  否则会无限替换；
- 目标名校验：非法字符 `\ / : * ? " < > |`、结尾空格或点、Windows 保留名
  `CON/PRN/AUX/NUL/COM1-9/LPT1-9`。

### 6. `$` 语义与原生不同

替换走 JS 引擎，`$1` / `$&` / `$$` 有效，**`\1` 无效**（会被当字面量）。UI 已给提示。

### 7. 新名一侧的 diff 不能用「公共前后缀」

`Buttom.md → Button.md` 若用公共前后缀法，会得出 `Butto{n}.md`（只高亮 `n`）——
虽然字符级"最小"，但**误导人**。正确做法是以旧名的**命中区间为锚点**，
把「匹配之外的夹层文本」当锚在新名里定位，使高亮覆盖**整个被替换的 token**：
`{Buttom}.md → {Button}.md`。

⚠️ 两个必须处理的边界：
- **新名的后缀要保留在未变化区**：`{XY}.ts` 而不是 `{XY.ts}`（`.ts` 在前后都是不变的）。
- **锚点定位失败时不要退回公共前后缀**：直接把剩余主体整块标为变化区，保持"整块高亮"的直觉。

### 8. 祖先路径高亮不能用「手算偏移量」

起初用「收集所有祖先路径 + 手写 slice 偏移」构造祖先 diff，结果切出了 `//s/src` 这种
重复斜杠的 bug（根路径 `/` 也算了一段，导致后续偏移全错）。

改成**按 `/` 切段、逐段累加判断**是否在 `renamedDirs` 里 —— 不需要维护任何偏移量，
天然不会错。

### 9. ⚠️ `viewsContainers` 的位置键只有三个，`auxiliarybar` 是错的

这是让扩展「**激活了但界面上什么都没有**」的元凶，也是最难查的一类问题：
`package.json` 里写了不存在的键，VSCode **不报错、不警告**，只是静默地不创建这个视图容器。

| 位置键 | 含义 | 最低版本 |
|---|---|---|
| `activitybar` | 左侧活动栏 | 长期支持 |
| `panel` | 底部面板区 | 长期支持 |
| `secondarySidebar` | 副侧边栏 | **1.106+** |

`auxiliarybar` **不在其中**（它是内部实现的叫法，不是贡献点）。
旧版本 VSCode 即使写 `secondarySidebar` 也不生效 —— 所以本项目用 `activitybar` 换兼容性。

### 10. `views` 的 key 是「容器 id」，不是「位置名」

```jsonc
"viewsContainers": {
  "activitybar": [                        // ← 位置名（枚举，只有 3 个）
    { "id": "searchAndRename", ... }      // ← 容器 id（自定义，随便起）
  ]
},
"views": {
  "searchAndRename": [ ... ]              // ← 这里填的是上面的「容器 id」
}
```

常见错误有三类：把位置名当容器 id 填进 `views`；把 `views` 的 key 写成 `search`
（内置搜索**不允许**被扩展加视图）；容器 id 与 `views` 的 key 不一致。
冒烟测试专门校验了这一致性。

### 11. `Module._load` 在 Node 20+ 已无法被覆盖

写「mock 掉 `vscode` 模块」的冒烟测试时，网上常见的写法是覆盖 `Module._load`。
但在 Node 20+ 上它会连续抛出两种错误：

```
TypeError: Cannot set property _load of #<Object> which has only a getter
TypeError: Cannot redefine property: _load
```

也就是既不能赋值、也不能 `defineProperty`（不可配置）。
**正确做法是覆盖 `Module.prototype.require`** —— 它才是用户代码里 `require('vscode')`
实际走的那条路。

### 12. 排除匹配必须用「工作区相对路径」

`extraExclude` / `files.exclude` 里写的是相对 glob（如 `**/node_modules/**`）。
起初拿 `uri.fsPath`（绝对路径）去比，多数情况也能命中，但存在一个隐蔽的误伤：
只要**工作区所在目录名**恰好等于某个被排除的目录名（例如把仓库放在 `~/dist/myProj/` 下），
`(^|/)**/dist/**$` 就会匹配到整个工作区路径，于是**整棵树被静默跳过**，
表现为「扫不到任何东西」。

### 13. `Uri.parent` 不存在

`vscode.Uri` 没有 `parent` 属性。取父目录要用 `vscode.Uri.joinPath(uri, '..')`。

另外，**判断一个 URI 是文件还是目录必须 `stat`**，不能靠扩展名猜
（`Makefile` / `LICENSE` / `v1.2` 都没有扩展名）。右键菜单的范围解析踩过这个点。

### 14. ⚠️ 快捷键抢不过 VSCode 内置命令，必须显式解绑

现象：`Ctrl+Alt+Shift+R` 按下去打开的是**别的东西**，而 `Ctrl+Alt+R` 正常。

原因：**`Ctrl+Alt+Shift+R` 是 VSCode 内置的 `workbench.action.showAllSymbols`
（转到编辑器中的符号）**。内置命令与扩展贡献的同键绑定优先级相同，此时**内置命令胜出**。

解法是用官方的 `-command` 语法显式解绑：

```jsonc
"keybindings": [
  { "command": "searchRename.openPanel", "key": "ctrl+alt+shift+r" },
  // ↓ 这一条才是关键：把内置的占用者解绑
  { "command": "-workbench.action.showAllSymbols", "key": "ctrl+alt+shift+r" }
]
```

⚠️ 这么做的代价是**用户的内置快捷键被我们改掉了**。所以 README 里必须写明，
并且必须同时提供不冲突的备选键 `Ctrl+Alt+P`。

> 排查这类问题的官方手段：`Developer: Toggle Keyboard Shortcuts Troubleshooting`，
> 会打开输出面板，按下快捷键后能看到它匹配到了哪个命令、来源是 built-in 还是扩展。

### 15. webview 里的 DOM 焦点不会同步到上下文键

`when: "!searchRename.inputFocus"` 看似写了防护，其实**从来没生效过**——
`searchRename.inputFocus` 这个上下文键从未被 `setContext` 设置。
而未定义的上下文键求值为 `undefined`，`!undefined === true`，于是条件**恒真**。

要让快捷键知道"用户正在输入框里打字"，必须由 webview 主动上报：

```js
document.addEventListener('focusin',  (e) => { if (isTextInput(e.target)) report(true);  }, true);
document.addEventListener('focusout', (e) => { if (!isTextInput(e.relatedTarget)) report(false); }, true);
```

三个细节：
- **用捕获阶段**（第三个参数 `true`）：`focusin` 冒泡会被某些组件吞掉；
- **用事件委托**而不是逐个绑定：列表行是动态重建的，逐个绑定重建后就失效；
- **`focusout` 要看 `relatedTarget`**：从 `find` 直接 Tab 到 `replace` 时不该"闪一下"置回 false；
  另外补一个 `window.blur` 兜底，避免残留在 true 导致快捷键**永久失效**。

### 16. ⚠️ 只要给元素写了 `display`，`hidden` 属性就废了

症状：列表里明明有 9 项，底部却一直挂着「没有匹配到可重命名」，而且**固定在底部不动**。

根因：HTML 的 `hidden` 属性**只靠浏览器默认样式表**的 `[hidden] { display: none }` 生效，
而默认样式表的优先级**低于作者样式**。`.empty { display: flex; flex: 1 1 auto }` 一写，
`el.hidden = true` 就彻底失效 —— 元素照常渲染，还被 `flex: 1` 撑满剩余空间，于是钉在底部。

```css
.empty {
  display: flex;    /* ← 这一行让 [hidden] 失效 */
  flex: 1 1 auto;   /* ← 这一行让它贴在底部 */
}
```

代码里 `.pane[hidden]` 和 `.row[hidden]` 都专门补过 `display: none`，
但 `.empty` 和 `.list-head` 漏了 —— **同一类 bug 已经复发三次**。
所以改成全局兜底：

```css
[hidden] { display: none !important; }
```

> 教训：CSS 里凡是"用 JS 切 `hidden`"的元素，都要检查自己有没有 `display` 声明。

### 17. ⚠️ 展示用的路径绝不能拿绝对路径去拼

症状：预览列表里每一行都把完整绝对目录刷一遍：

```
d:/1/2/下载/Compressed/MOD MHWS/Mods_582010/1008/files/nativePC/otomo/equip/
ot029/body/mod/ot_body_029.ccl → ot_body_1.ccl
```

一段路径撑成三行，9 个文件就把列表挤爆了。

根因：`ancestorDiffFor()` 是拿 `fromPath`（**绝对**路径）逐段渲染的，
哪怕里面一个片段都没改名，也照样全画出来。

修法是两条：
1. **全部改用相对路径**（`pair.relPath`）来算祖先 diff；
2. **目录信息交给分组头** —— 既然每个目录都会有一个头，行内的祖先路径就彻底是冗余的。

### 18. ⚠️ 「整行截断」会把最重要的信息截掉

把整行设成 `nowrap + text-overflow: ellipsis` 之后：

```
ot_body_029.ccl → ot_bo…      ← 被截掉的恰好是新名
```

**在一个"确认将要执行的批量改名"的界面里，新名是唯一必须看清的东西。**
正确做法是把宽度按重要性分配（见 README 的「一行放不下时：新名优先」），
而不是平均分配。

反直觉的坑：`text-overflow: ellipsis` 对 **flex 容器**无效，但对 **flex item** 有效。
所以要让 `.names` 当 flex 容器、让 `.name-old` / `.name-new` 当可裁剪的 flex item。

另外 `flex: 0 0 auto` 的新名在**自身超过整行**时会顶破行宽 ——
所以新名必须保留 `shrink: 1` + `ellipsis` 作为兜底，只在旧名耗尽后才生效。

### 19. ⚠️⚠️ 最危险的是「永远不会失败的断言」

给 `smoke.ts` 加「新名不能被截断」的源码断言时，布局检查里写的是：

```js
oldTrunc: oldEl.scrollWidth > oldEl.clientWidth + 1     // ← 恒为 false
```

为什么恒为 false：当 `.name-new` 是 `flex: 0 0 auto` 时，
**元素宽度永远等于内容宽度**，`scrollWidth` 与 `clientWidth` 必然相等 ——
于是这条断言**永远通过**，哪怕界面已经错得离谱。

同一个坑还踩了两次：
- 用 `getBoundingClientRect().right <= rowRight` 判定"文字有没有被省略" ——
  元素被 `overflow: hidden` 裁到合适宽度后，**盒子的右边界永远落在行内**，同样恒为真。
- 断言 `.names` 有 `nowrap`，但没断言 `text-overflow` 在**哪个元素**上 ——
  写在容器上（无效）和写在 item 上（有效）都会让断言通过。

**教训：写完断言必须验证它会失败。** 做法是给每条断言同时喂「正确样本」和「回归样本」，
确认它分别命中/不命中。

这也是为什么值得为布局单独建一条真浏览器通道 ——
`scrollWidth` / `clientWidth` / flex 收缩这类行为**只有真浏览器能验证**，
jsdom 不算布局，静态语法检查更是完全看不见。

### 20. 右键菜单的参数约定是反直觉的

`explorer/context` 触发时（实测）：

| 情况 | 第 1 参 | 第 2 参 |
|---|---|---|
| 单选 1 项 | 该 uri | `[该 uri]` |
| 多选 N 项 | **被右键的那一个** uri | `[全部 N 个 uri]` |
| 命令面板 / 快捷键 | `undefined` | `undefined` |

所以**必须优先用第 2 参**（它才是完整选区），抽成了 `collectResources()`。

### 21. `activationEvents` 不要写 `onStartupFinished`

写它意味着**每个装了这扩展的用户，每次启动 VSCode 都会被加载一遍**，哪怕从没用过。
对发布版这是明确的反模式。正确做法是只声明真正需要的入口：

```jsonc
"activationEvents": [
  "onView:searchRename.panel",
  "onCommand:searchRename.quickRename",
  "onCommand:searchRename.openPanel"
]
```

（VSCode ≥1.74 会为 `contributes.commands` / `contributes.views` 自动生成激活事件，
显式写出来只是为了让意图可见。）

### 22. ⚠️ 同一个替换串，不能有两条不同的展开实现

`replaceSubject` 一开始是这么写的：

```ts
if (!preserveCase) {
  return subject.replace(regex, replacement);      // ← 走原生
}
return subject.replace(regex, (m, ...g) => {       // ← 走自写的展开器
  return applyPreserveCase(m, expandReplacement(replacement, m, g));
});
```

看着合理（只有需要逐匹配处理大小写时才自己展开），但两条路径的**语义并不等价**：
原生支持 `$1`~`$99`、`$&`、`` $` ``、`$'`、`$$`、`$<name>`，
而一开始手写的展开器只认 `$$` / `$&` / **单位数** `$1`~`$9`。

实测结果（脚本跑出来的）：

| 替换串 | 保留大小写**关** | 保留大小写**开** |
|---|---|---|
| `$10`（有 10 组） | `[j]` 第 10 组 | `[a0]` 第 1 组 + 字面 `0` |
| `$<x>` | `[a]` 命名组 | `[$<x>]` 原样输出 |
| `` $` `` | `a[a]c` | ``a[$`]c`` |
| `$'` | `a[c]c` | `a[$']c` |

**勾一下「保留大小写」就静默改了替换的含义，进而生成错误的文件名。**
对一个"批量改名"工具来说这是最糟的一类 bug：不报错、预览里也看得出来（如果盯着看），
但用户很容易直接回车。

修法是**结构性地消灭分歧**：只保留一条路径（始终走回调），
并把 `expandReplacement` 按 ECMAScript 的 `GetSubstitution` 规范补全
（两位数字优先且需真有那么多组、`$<name>`、`` $` ``、`$'`、`$0` 原样保留……）。

⚠️ 顺带一个回调签名细节：`replace(re, cb)` 的参数是
`[p1…pn, offset, input, groups?]`，其中 **`groups` 只在正则含命名捕获组时出现**。
所以要从**尾部**判断：最后一个参数是对象 → 是 `groups`；否则它是 `input`。
按位置硬取会在"有/无命名组"两种正则下错位。

**测试怎么写**：与其逐个断言展开结果，不如断言**不变量** ——
「替换串里全小写、匹配也全小写时，`preserveCase` 开关必须给出相同结果」。
这条不变量一次覆盖所有 `$` 写法，而且正是当年被破坏的那条。

### 23. 有争议的展示偏好，做成开关；不要替用户选默认之外的那一个

「名字太长时到底该折行还是该省略」是个**没有唯一正确答案**的取舍：

- 折行 → 信息完整，但行高不固定、一屏能看的条目少；
- 省略 → 行高统一、便于扫视，但有信息看不见。

本项目最后做成**列表头的一个「换行」开关，默认关**。三条理由：

1. **开关是超集。** 想要"永远折行"的人打开一次即可（状态会持久化），
   体验上等同于永远折行；而如果直接做成"只有折行"，就回不到紧凑模式了。
   凡是"A 能覆盖 B 的场景，B 覆盖不了 A 的场景"，就该让 A 是默认实现 + 一个开关。
2. **默认值应该选"丢失最少"的那个。** 紧凑模式下**新名已经永远完整**
   （被省略的只有旧名，且悬停有完整路径），所以默认紧凑不会丢关键信息；
   反过来，默认折行却会让所有人付出"行高不统一"的代价。
3. **它必须只是展示层。** 实现上只切一个 class（`.list.wrap`），
   不参与预览计算、不影响执行结果 —— 所以开关坏了也最多是显示难看，不会改错文件名。

⚠️ 别忘了**持久化**。一个"记不住状态"的开关会让用户下次打开以为界面坏了。
本项目复用了已有的 `persist()` / `vscode.setState` 机制。

冒烟测试里钉住了：规则存在、确实放开了截断、状态被持久化、**默认必须是 false**。

---

## 已知边界

- **不跟随符号链接**：避免环与越界；`seen` 集合按 URI 去重兜底。
- **大小写不敏感的文件系统上的「仅大小写改名」**：允许执行，但提示「git 可能不识别」
  （建议用 `git mv`）。
- **虚拟 / 只读文件系统**：执行前用 `workspace.fs.isWritableFileSystem` 守卫。
- **超大仓库**：达 `maxEntries` 上限会中止并提示缩小范围。
