import * as vscode from 'vscode';
import type { AiCaller } from '../types.js';

/**
 * AI（MCP / Language Model Tool）からの操作を記録する監査ログ。
 *
 * 既存の出力チャンネル「DB Rover」を使い回す（新しいチャンネルは作らない）。
 * 1 行 = 1 イベント、先頭に ISO 時刻と呼び出し元タグを付ける。
 *
 * 記録するのは「要求 → 承認の可否 → 結果/エラー」の 3 点セット。
 * トークン・パスワード・結果の値そのものは絶対に書かない（行数と所要時間だけ）。
 */
export class AuditLog {
  constructor(private readonly outputChannel: vscode.OutputChannel) {}

  /**
   * ツール呼び出しの要求を記録する。`dbrover_run_sql` は SQL 全文（切り詰めない）を
   * 続けて記録する。
   */
  request(caller: AiCaller, toolName: string, detail: string, sql?: string): void {
    this.write(caller, `${toolName} ${detail}`);
    if (sql !== undefined) {
      this.writeRaw(`  SQL: ${sql}`);
    }
  }

  /** 承認待ち・承認・却下を記録する。 */
  approval(caller: AiCaller, toolName: string, detail: string): void {
    this.write(caller, `${toolName} ${detail}`);
  }

  /** 成功結果を記録する（行数・所要時間のみ。値そのものは書かない）。 */
  success(caller: AiCaller, toolName: string, detail: string): void {
    this.write(caller, `${toolName} 完了 ${detail}`);
  }

  /** 失敗・エラーを記録する。 */
  failure(caller: AiCaller, toolName: string, detail: string): void {
    this.write(caller, `${toolName} 失敗: ${detail}`);
  }

  private write(caller: AiCaller, message: string): void {
    this.writeRaw(`[${CALLER_TAGS[caller]}] ${message}`);
  }

  private writeRaw(message: string): void {
    this.outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
  }
}

const CALLER_TAGS: Record<AiCaller, string> = {
  mcp: 'AI/MCP',
  lm: 'AI/Copilot',
};
