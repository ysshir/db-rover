import * as vscode from 'vscode';
import type { StatementKind } from '../drivers/statementKind.js';
import type { ConnectionManager } from '../connections/manager.js';
import {
  buildApprovalPrompt,
  decideApproval,
  type ApprovalDecision,
  type ApprovalPromptInput,
  type WriteMode,
} from './approvalPolicy.js';

/**
 * AI からの書き込み・破壊的な文の承認を管理する。
 *
 * 判定そのものは approvalPolicy.ts（純粋関数）に委ね、ここでは
 * - `dbRover.ai.writes` 設定の読み取り
 * - `showWarningMessage({ modal: true })` によるモーダル表示
 * - 接続単位の「以後確認しない」の記憶（ウィンドウの生存期間のみ。workspaceState には残さない）
 * を担う。
 *
 * 承認スコープは connectionId 単位のみ。SQL 本文をキーにしても AI は毎回違う文を出すので
 * 意味が無い。
 */
export class ApprovalGate implements vscode.Disposable {
  private readonly remembered = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(manager: ConnectionManager) {
    // 切断された接続の記憶は落とす。
    this.disposables.push(
      manager.onDidChangeConnections(() => {
        for (const id of Array.from(this.remembered)) {
          if (!manager.isConnected(id)) {
            this.remembered.delete(id);
          }
        }
      }),
    );
  }

  /** 実行前に確認が必要かどうかを判定する（モーダルは出さない）。 */
  decide(connectionId: string, kinds: readonly StatementKind[]): ApprovalDecision {
    return decideApproval(kinds, this.remembered.has(connectionId), this.writeMode());
  }

  /**
   * `decide()` が `'ask'` のときに呼ぶ。モーダルを表示し、ユーザーが実行を選んだら true を返す。
   * `destructive` なときは記憶ボタンを出さない（取り消せない文は毎回必ず確認する）。
   */
  async confirm(input: ApprovalPromptInput & { connectionId: string }): Promise<boolean> {
    const prompt = buildApprovalPrompt(input);
    const rememberable = !prompt.destructive;
    const runLabel = prompt.destructive ? '実行する（取り消せません）' : '実行する';
    const buttons = rememberable ? [runLabel, REMEMBER_LABEL] : [runLabel];

    const choice = await vscode.window.showWarningMessage(
      prompt.title,
      { modal: true, detail: prompt.detail },
      ...buttons,
    );

    if (choice === undefined) {
      return false;
    }
    if (choice === REMEMBER_LABEL) {
      this.remembered.add(input.connectionId);
    }
    return true;
  }

  /** 記憶をクリアする。`connectionId` 省略時は全件（トークン回転・コマンドから呼ぶ）。 */
  clear(connectionId?: string): void {
    if (connectionId === undefined) {
      this.remembered.clear();
      return;
    }
    this.remembered.delete(connectionId);
  }

  private writeMode(): WriteMode {
    return vscode.workspace.getConfiguration('dbRover').get<WriteMode>('ai.writes', 'ask');
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}

const REMEMBER_LABEL = 'この接続では以後確認しない';
