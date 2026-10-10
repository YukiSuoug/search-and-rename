/**
 * 扩展内共享类型定义。
 *
 * 设计约定：core/ 下的模块**不依赖 vscode 之外的运行时**，
 * 其中 regex.ts / plan.ts / conflict.ts 是纯函数（可在 node 里直接单测）；
 * walk.ts / execute.ts 需要 vscode API。
 */

export type MatchTarget = 'both' | 'filesOnly' | 'foldersOnly';

/** 名称匹配的选项（对应 UI 上的 4 个 toggle + 范围） */
export interface MatchOptions {
  find: string;
  replace: string;
  isRegex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
  preserveCase: boolean;
  /** 文件名是否保留扩展名（文件夹名此选项无效） */
  preserveExtension: boolean;
  matchTarget: MatchTarget;
}

/** 扫描得到的一个条目 */
export interface Entry {
  /** 绝对路径（posix 风格，用于稳定排序与去重） */
  fsPath: string;
  /** 绝对 URI 字符串 */
  uri: string;
  /** 文件/文件夹名（文件含扩展名） */
  name: string;
  isDirectory: boolean;
  /** 相对工作区根目录的展示路径 */
  relPath: string;
}

export type ConflictKind =
  | 'targetExists'
  | 'duplicateTarget'
  | 'caseOnly'
  | 'invalidName';

export interface Conflict {
  fsPath: string;
  kind: ConflictKind;
  message: string;
}

/** 一条重命名计划 */
export interface RenamePair {
  fromPath: string;
  toPath: string;
  fromUri: string;
  toUri: string;
  /** 展示用：旧名 */
  oldName: string;
  /** 展示用：新名 */
  newName: string;
  /** 展示用：相对路径 */
  relPath: string;
  isDirectory: boolean;
}

/** 预览结果回传 Webview 的条目 */
export interface PreviewItem {
  key: string;
  fsPath: string;
  relPath: string;
  oldName: string;
  newName: string;
  isDirectory: boolean;
  /** 未处理的原始名称diff：旧名中与查找匹配的片段 */
  oldDiff: DiffSegment[];
  newDiff: DiffSegment[];
  conflict?: ConflictKind;
  conflictMessage?: string;
}

export interface DiffSegment {
  text: string;
  /** 是否是被替换掉/新增的部分（用于高亮） */
  changed: boolean;
}

export interface PreviewResult {
  items: PreviewItem[];
  /** 树形行（当前预览 UI 用它渲染） */
  rows: TreeRow[];
  total: number;
  conflictCount: number;
  /** 扫描是否因为达到上限而中止 */
  truncated: boolean;
}

/**
 * 树形渲染行。
 *
 * 设计：把匹配结果按「改名后的路径」组织成一棵树。
 *  - 被改名的**文件夹**成为一个可展开的分组头（`isGroup` + `hasChildren`），
 *    其子项缩进显示在下面，用来表达"这一整棵子树都会跟着移动"。
 *  - 未被任何改名文件夹包住的条目直接是叶子行（`depth` 为 0）。
 *  - 祖先路径片段若有改名（`ancestorDiff` 非空），说明该行所在的目录本身也变了，
 *    即使这一行自己的名字没变，也要标出来 —— 这是"父目录改名"的可见化。
 */
export interface TreeRow {
  key: string;
  depth: number;
  /** 这一行是否是「被改名的文件夹」的分组头 */
  isGroup: boolean;
  /** 分组头是否有可见子项（决定要不要画展开箭头；false 时不画） */
  hasChildren: boolean;
  isDirectory: boolean;
  /**
   * 纯分组用的「目录头」——该目录**自身不在**重命名计划里，
   * 只是个视觉分组，让同一目录下的文件不必各自重复一遍目录路径。
   *
   * ⚠️ 它不是可执行条目：`key` 是 `dir::<相对路径>` 这种合成值，不是真实 fsPath。
   * 执行层必须把它排除掉。
   */
  isContainer?: boolean;
  /** 容器头子树内的条目数（仅 isContainer 时有意义） */
  containerCount?: number;
  /**
   * 行内目录前缀（dimmed）。
   *
   * 只用在「只有一个条目的目录」上：为它单独开一行分组头不划算，
   * 于是把目录名降级成文件名前面的一小段灰色前缀 —— 一层目录换一行，省一半高度。
   */
  dirHint?: string;
  /** 叶子行的完整旧名 / 新名 */
  oldName: string;
  newName: string;
  /**
   * 相对路径。
   * - 分组头：相对其父节点的路径（顶层就是完整相对路径）
   * - 叶子：**完整**相对路径（行内不渲染它，只渲染 old → new；用它的地方是 tooltip / QuickPick）
   */
  relPath: string;
  /** 叶子行自己的名字 diff */
  oldDiff: DiffSegment[];
  newDiff: DiffSegment[];
  /**
   * 祖先路径的 diff（可能为空）。
   * 例如文件 `src/Buttom/a.ts`，而 `src/Buttom` 目录会被改名 →
   * 这里给出 "src/" + [Buttom] + "/" 的片段。
   *
   * ⚠️ 必须基于**相对**路径计算。曾用绝对路径（`d:/1/2/下载/.../mod/`），
   * 每行都把整条绝对目录刷出来，一行撑成三行 —— 这是「列表太挤」的根因。
   * 现在它不再用于行内渲染（目录已由分组头给出），只用于 tooltip / QuickPick。
   */
  ancestorDiff: DiffSegment[];
  conflict?: ConflictKind;
  conflictMessage?: string;
  /** 该行（含其子树）内的冲突数量，仅分组头有意义 */
  childConflictCount?: number;
}

export interface FailedItem {
  fsPath: string;
  reason: string;
}

export interface ExecuteResult {
  done: number;
  failed: FailedItem[];
  cancelled: boolean;
}

/* ------------------------- Webview 消息协议 ------------------------- */

export type ToWebviewMessage =
  | { type: 'mode'; mode: ExtensionMode }
  | { type: 'busy'; busy: boolean; message?: string }
  | { type: 'previewResult'; result: PreviewResult }
  | { type: 'options'; options: MatchOptions; config: UiConfig }
  | { type: 'result'; result: ExecuteResult }
  | { type: 'error'; message: string };

export type ExtensionMode = 'content' | 'rename';

export interface UiConfig {
  confirmThreshold: number;
  canUndo: boolean;
}

export type FromWebviewMessage =
  | { type: 'ready' }
  | { type: 'switchMode'; mode: ExtensionMode }
  | { type: 'preview'; options: MatchOptions }
  | { type: 'execute'; keys: string[] }
  | { type: 'undo' }
  | { type: 'openNativeSearch'; find: string }
  /**
   * 焦点进入/离开面板内的文本框。
   *
   * 用途：快捷键 `Ctrl+Alt+R` / `Ctrl+Alt+Shift+R` 的 when 子句要排除"正在输入"
   * 的情况，否则用户在查找框里敲字时按到组合键会误触发。
   * 关键：webview 里的 DOM 焦点**不会**反映到 VSCode 的上下文键上，
   * 必须由前端主动 postMessage 上报。
   */
  | { type: 'inputFocus'; focused: boolean }
  | { type: 'notify'; level: 'info' | 'warn' | 'error'; message: string };
