/**
 * 批量执行重命名 + 撤销日志。
 *
 * 核心决策：用 WorkspaceEdit.renameFile + workspace.applyEdit，而不是 workspace.fs.rename。
 *  理由：可整体 Undo、打开中的编辑器自动跟随、脏缓冲区保留。
 *
 * 失败策略：整批 applyEdit 返回 false 时，退化为逐项重试以定位失败项，
 *          并**停止后续批次**，避免继续制造不一致状态。
 */

import * as vscode from 'vscode';
import type { ExecuteResult, FailedItem, RenamePair } from '../types';

const BATCH_SIZE = 50;
const UNDO_LOG_KEY = 'searchRename.undoLog';
const UNDO_LOG_LIMIT = 20;

export interface UndoRecord {
  pairs: Array<{ from: string; to: string }>;
  at: number;
}

export class RenameExecutor {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  async execute(
    pairs: RenamePair[],
    token: vscode.CancellationToken,
    progress: vscode.Progress<{ message?: string; increment?: number }>
  ): Promise<ExecuteResult> {
    const failed: FailedItem[] = [];
    const applied: Array<{ from: string; to: string }> = [];
    let done = 0;
    let cancelled = false;

    const batches = chunk(pairs, BATCH_SIZE);
    for (let bi = 0; bi < batches.length; bi++) {
      if (token.isCancellationRequested) {
        cancelled = true;
        break;
      }
      const batch = batches[bi];

      const edit = new vscode.WorkspaceEdit();
      for (const p of batch) {
        edit.renameFile(toUri(p.fromUri), toUri(p.toUri), { overwrite: false });
      }

      let ok = false;
      try {
        ok = await vscode.workspace.applyEdit(edit);
      } catch (err) {
        ok = false;
        void err;
      }

      if (ok) {
        done += batch.length;
        for (const p of batch) {
          applied.push({ from: p.fromUri, to: p.toUri });
        }
      } else {
        // 整批失败 → 逐项重试定位
        let anyFailed = false;
        for (const p of batch) {
          if (token.isCancellationRequested) {
            cancelled = true;
            break;
          }
          const single = new vscode.WorkspaceEdit();
          single.renameFile(toUri(p.fromUri), toUri(p.toUri), { overwrite: false });
          let oneOk = false;
          try {
            oneOk = await vscode.workspace.applyEdit(single);
          } catch {
            oneOk = false;
          }
          if (oneOk) {
            done++;
            applied.push({ from: p.fromUri, to: p.toUri });
          } else {
            anyFailed = true;
            failed.push({
              fsPath: p.fromPath,
              reason: '目标已存在、被占用或不可写',
            });
          }
        }
        if (anyFailed) {
          // 停止后续批次，避免继续制造不一致
          break;
        }
      }

      progress.report({
        message: `${done}/${pairs.length}`,
        increment: (batch.length / Math.max(1, pairs.length)) * 100,
      });
    }

    if (applied.length > 0) {
      await this.pushUndoRecord({ pairs: applied, at: Date.now() });
    }

    return { done, failed, cancelled };
  }

  async pushUndoRecord(record: UndoRecord): Promise<void> {
    const log = this.ctx.workspaceState.get<UndoRecord[]>(UNDO_LOG_KEY, []);
    log.push(record);
    while (log.length > UNDO_LOG_LIMIT) {
      log.shift();
    }
    await this.ctx.workspaceState.update(UNDO_LOG_KEY, log);
  }

  hasUndo(): boolean {
    const log = this.ctx.workspaceState.get<UndoRecord[]>(UNDO_LOG_KEY, []);
    return log.length > 0;
  }

  /**
   * 撤销上次批量重命名。
   *
   * ⚠️ 顺序：执行时是"先深后浅"，日志里父目录排在后面。
   *    因此撤销**不能**朴素地 reverse()，而要重新按"深→浅"排序后取反，
   *    也就是：先撤销最深的后代，最后撤销浅层的父目录。
   */
  async undoLast(): Promise<ExecuteResult> {
    const log = this.ctx.workspaceState.get<UndoRecord[]>(UNDO_LOG_KEY, []);
    const record = log.pop();
    await this.ctx.workspaceState.update(UNDO_LOG_KEY, log);
    if (!record) {
      return { done: 0, failed: [], cancelled: false };
    }

    const reversed = [...record.pairs].reverse().map((p) => ({
      fromUri: p.to,
      toUri: p.from,
      fromPath: uriToPath(p.to),
    }));
    // 撤销时同样要"先深后浅"（按待撤销路径的深度降序）
    reversed.sort((a, b) => depth(b.fromPath) - depth(a.fromPath));

    const failed: FailedItem[] = [];
    let done = 0;
    for (const p of reversed) {
      const edit = new vscode.WorkspaceEdit();
      edit.renameFile(toUri(p.fromUri), toUri(p.toUri), { overwrite: false });
      let ok = false;
      try {
        ok = await vscode.workspace.applyEdit(edit);
      } catch {
        ok = false;
      }
      if (ok) {
        done++;
      } else {
        failed.push({ fsPath: p.fromPath, reason: '撤销失败：目标被占用或已不存在' });
      }
    }
    return { done, failed, cancelled: false };
  }
}

/* --------------------------- helpers --------------------------- */

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function toUri(s: string): vscode.Uri {
  return vscode.Uri.parse(s);
}

function uriToPath(s: string): string {
  try {
    return vscode.Uri.parse(s).fsPath.replace(/\\/g, '/');
  } catch {
    return s;
  }
}

function depth(p: string): number {
  return p.replace(/\/+$/, '').split('/').length;
}
