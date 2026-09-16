/**
 * AI からの SQL 実行を承認するかどうかの判定と、承認モーダル・確認 UI に出す文言の生成。
 *
 * MCP 経路（showWarningMessage の modal）と LM ツール経路（prepareInvocation の
 * confirmationMessages）の両方が、ここの `decideApproval` / `buildApprovalPrompt` を
 * 同じ引数で呼ぶことで、判定と文言を完全に一致させる。
 *
 * vscode に依存させないこと。scripts/check-approval.mjs が単体ビルドして検証する。
 */

import type { StatementKind } from '../drivers/statementKind.js';

export type ApprovalDecision = 'allow' | 'ask' | 'deny';

/** 設定 `dbRover.ai.writes` の値。 */
export type WriteMode = 'ask' | 'never' | 'session';

/**
 * 実行しようとしている全文の分類（`kinds`）から、承認が必要かどうかを判定する。
 *
 * - すべて `read` なら常に `allow`。
 * - `destructive` を 1 つでも含むなら、記憶していても必ず `ask`（`mode==='never'` なら `deny`）。
 * - それ以外で `write` を含むなら、`mode==='session'` かつ記憶済みのときだけ `allow`、
 *   `mode==='never'` なら `deny`、それ以外は `ask`。
 * - `kinds` が空（文が 1 つも分類できない）ときはフェイルクローズで `ask` にする。
 */
export function decideApproval(
  kinds: readonly StatementKind[],
  remembered: boolean,
  mode: WriteMode,
): ApprovalDecision {
  if (kinds.length === 0) {
    return 'ask';
  }

  const hasDestructive = kinds.includes('destructive');
  if (hasDestructive) {
    return mode === 'never' ? 'deny' : 'ask';
  }

  const hasWrite = kinds.includes('write');
  if (hasWrite) {
    if (mode === 'never') {
      return 'deny';
    }
    if (mode === 'session' && remembered) {
      return 'allow';
    }
    return 'ask';
  }

  return 'allow';
}

export interface ApprovalPromptInput {
  connectionName: string;
  kinds: readonly StatementKind[];
  sql: string;
  caller: 'mcp' | 'lm';
}

export interface ApprovalPrompt {
  title: string;
  detail: string;
  destructive: boolean;
}

const CALLER_LABELS: Record<ApprovalPromptInput['caller'], string> = {
  mcp: 'MCP（外部 AI）',
  lm: 'Copilot（LM ツール）',
};

/**
 * 承認モーダル / 確認 UI に出す title・detail を組み立てる。
 * `destructive` のときは detail の先頭行に警告を置く。
 */
export function buildApprovalPrompt(input: ApprovalPromptInput): ApprovalPrompt {
  const destructive = input.kinds.includes('destructive');
  const callerLabel = CALLER_LABELS[input.caller];

  const lines: string[] = [];
  if (destructive) {
    lines.push('注意: この操作は取り消せません。');
  }
  lines.push(`呼び出し元: ${callerLabel}`);
  lines.push(`接続: ${input.connectionName}`);
  lines.push('');
  lines.push(input.sql);

  const title = destructive
    ? `取り消せない SQL を実行しようとしています（${input.connectionName}）`
    : `SQL の実行を承認しますか？（${input.connectionName}）`;

  return { title, detail: lines.join('\n'), destructive };
}
