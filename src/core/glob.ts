/**
 * 纯函数 glob → RegExp。
 * 单独成文件，避免 walk.ts 牵连 vscode 依赖，方便 node 单测。
 *
 * 只支持 ** / * / ? 三种通配，必要时再扩展。
 */

export function globToRegExp(glob: string): RegExp | undefined {
  if (!glob) {
    return undefined;
  }
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        const next = glob[i + 2];
        if (next === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  try {
    return new RegExp(`(^|/)${re}$`);
  } catch {
    return undefined;
  }
}

/** 把用户写的 glob 归一化成统一形态，便于 globToRegExp 处理 */
export function normalizeGlob(glob: string): string {
  const g = glob.replace(/\\/g, '/').replace(/^\//, '');
  if (g.startsWith('**/')) {
    return g;
  }
  return `**/${g}`;
}
