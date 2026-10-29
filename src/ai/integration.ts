import * as vscode from 'vscode';
import type { ConnectionManager } from '../connections/manager.js';
import type { QueryResultView } from '../query/resultView.js';
import { ApprovalGate } from './approval.js';
import { AuditLog } from './audit.js';
import { registerLmTools } from './lmTools.js';
import { AiToolCore } from './toolCore.js';

const CONFIG_SECTION = 'dbRover';

/**
 * AI 連携（Language Model Tools）のファサード。
 *
 * 設定 `dbRover.ai.languageModelTools.enabled` に追随したツールの登録・解除と、
 * コマンドの登録をここに集約する。
 */
export class AiIntegration implements vscode.Disposable {
  private readonly approvalGate: ApprovalGate;
  private readonly toolCore: AiToolCore;
  private readonly disposables: vscode.Disposable[] = [];

  private lmToolsDisposables: vscode.Disposable[] = [];

  constructor(manager: ConnectionManager, outputChannel: vscode.OutputChannel, resultView: QueryResultView) {
    const auditLog = new AuditLog(outputChannel);

    this.approvalGate = new ApprovalGate(manager);
    this.disposables.push(this.approvalGate);

    this.toolCore = new AiToolCore(manager, this.approvalGate, auditLog, resultView);

    this.disposables.push(
      vscode.commands.registerCommand('dbRover.ai.resetApprovals', () => this.resetApprovals()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('dbRover.ai')) {
          this.applyConfig();
        }
      }),
    );

    this.applyConfig();
  }

  /** 設定 `dbRover.ai.languageModelTools.enabled` の現在値を LM ツールの登録状態に反映する。 */
  private applyConfig(): void {
    const lmEnabled = vscode.workspace
      .getConfiguration(CONFIG_SECTION)
      .get<boolean>('ai.languageModelTools.enabled', true);
    if (lmEnabled && this.lmToolsDisposables.length === 0) {
      this.lmToolsDisposables = registerLmTools(this.toolCore);
    } else if (!lmEnabled && this.lmToolsDisposables.length > 0) {
      this.disposeLmTools();
    }
  }

  private disposeLmTools(): void {
    for (const disposable of this.lmToolsDisposables) {
      disposable.dispose();
    }
    this.lmToolsDisposables = [];
  }

  private resetApprovals(): void {
    this.approvalGate.clear();
    void vscode.window.showInformationMessage('DB Rover: AI からの書き込み許可の記憶をリセットしました。');
  }

  dispose(): void {
    this.disposeLmTools();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}
