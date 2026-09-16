import * as vscode from 'vscode';
import { getConnectionById } from '../connections/store.js';
import { classifyStatement } from '../drivers/statementKind.js';
import { splitSqlStatements } from '../query/splitStatements.js';
import { buildApprovalPrompt } from './approvalPolicy.js';
import type { AiToolCore } from './toolCore.js';
import { TOOL_DEFS, type AiToolName } from './toolDefs.js';

/**
 * Copilot Chat 向けの Language Model Tool を 4 本登録する薄いラッパ。
 *
 * `invoke()` は `AiToolCore.call({ caller: 'lm' })` を呼ぶだけで、判定・承認は必ずそちら側で
 * やり直す。VS Code の確認 UI には「常に許可」で `prepareInvocation` を素通りできる導線が
 * あるため、ここでの確認表示だけに安全を委ねない。
 *
 * `vscode.lm.registerTool` が無い（フォークで未実装）環境では実行時ガードし、
 * activate を落とさず黙ってスキップする。
 */
export function registerLmTools(core: AiToolCore): vscode.Disposable[] {
  if (typeof vscode.lm?.registerTool !== 'function') {
    return [];
  }
  return TOOL_DEFS.map((def) => vscode.lm.registerTool(def.name, createTool(def.name, core)));
}

function createTool(name: AiToolName, core: AiToolCore): vscode.LanguageModelTool<Record<string, unknown>> {
  return {
    async invoke(options) {
      const result = await core.call({ caller: 'lm', name, args: options.input });
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result.text)]);
    },

    prepareInvocation(options) {
      const input = options.input as Record<string, unknown>;
      const connectionId = typeof input.connectionId === 'string' ? input.connectionId : undefined;
      const config = connectionId ? getConnectionById(connectionId) : undefined;
      const connectionName = config?.name ?? connectionId ?? '(未指定の接続)';

      if (name !== 'dbrover_run_sql') {
        return { invocationMessage: invocationMessageFor(name, connectionName, input) };
      }

      const sql = typeof input.sql === 'string' ? input.sql : '';
      const statements = splitSqlStatements(sql, config?.kind ?? 'postgres');
      const kinds = statements.map((statement) => classifyStatement(statement.sql));
      const invocationMessage = `DB Rover: ${connectionName} に SQL を実行しています`;

      // read のみは MCP 経路と同じく無確認（decideApproval と同じ判定基準）。
      const allRead = kinds.length > 0 && kinds.every((kind) => kind === 'read');
      if (allRead) {
        return { invocationMessage };
      }

      const prompt = buildApprovalPrompt({ connectionName, kinds, sql, caller: 'lm' });
      return {
        invocationMessage,
        confirmationMessages: { title: prompt.title, message: prompt.detail },
      };
    },
  };
}

function invocationMessageFor(name: AiToolName, connectionName: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'dbrover_list_connections':
      return 'DB Rover: 接続中の接続一覧を取得しています';
    case 'dbrover_list_tables':
      return `DB Rover: ${connectionName} のテーブル一覧を取得しています`;
    case 'dbrover_describe_table': {
      const table = typeof input.table === 'string' ? input.table : 'テーブル';
      return `DB Rover: ${connectionName} の ${table} を調べています`;
    }
    default:
      return `DB Rover: ${connectionName} を確認しています`;
  }
}
