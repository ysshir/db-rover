/**
 * AI へ返す結果のサイズを制限するための純粋関数。
 *
 * 外部 AI（MCP）や Copilot のコンテキストを圧迫しないよう、行数・セル・ペイロード全体の
 * 3 段階で切り詰める。切り詰めたときは必ず `truncated: true` と `note` の両方で明示する
 * （モデルが「これが全件だ」と誤解しないように）。
 *
 * `AiRunSqlPayload` / `AiStatementPayload` は他の AI 関連の共有型と同じく src/types.ts に
 * 集約している（QueryResult / StatementOutcome と同じ置き場所）。
 *
 * vscode に依存させないこと。scripts/check-ai-limits.mjs が単体ビルドして検証する。
 */

import type { AiRunSqlPayload, AiStatementPayload, StatementOutcome } from '../types.js';

/** maxRows のハード上限。設定でこれより大きい値を指定しても超えない。 */
export const HARD_MAX_ROWS = 1000;
/** 1 セルあたりの最大文字数。 */
export const MAX_CELL_CHARS = 1000;
/** ペイロード全体（JSON 文字列）の最大文字数。 */
export const MAX_PAYLOAD_CHARS = 20000;

/**
 * 要求された maxRows を `[1, HARD_MAX_ROWS]` にクランプする。
 * 未指定・不正な値のときは configuredDefault（設定 `dbRover.ai.maxRows`）を使う。
 */
export function clampMaxRows(requested: number | undefined, configuredDefault: number): number {
  const base =
    typeof requested === 'number' && Number.isFinite(requested) ? requested : configuredDefault;
  const truncated = Math.trunc(base);
  return Math.min(HARD_MAX_ROWS, Math.max(1, truncated));
}

/** セルの値を最大文字数で切り詰める。文字列以外の値はそのまま返す。 */
export function truncateCell(value: unknown, maxChars: number = MAX_CELL_CHARS): unknown {
  if (typeof value !== 'string' || value.length <= maxChars) {
    return value;
  }
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}…（残り${omitted}文字省略）`;
}

/** `StatementOutcome[]` を AI へ返す JSON 化可能なペイロードに変換する（セルの切り詰めのみ行う）。 */
export function buildRunSqlPayload(
  outcomes: readonly StatementOutcome[],
  maxCellChars: number = MAX_CELL_CHARS,
): AiRunSqlPayload {
  const statements: AiStatementPayload[] = outcomes.map((outcome) => {
    if (outcome.status !== 'ok' || !outcome.result) {
      return {
        index: outcome.index,
        sql: outcome.sql,
        status: outcome.status,
        message: outcome.message,
      };
    }
    const { result } = outcome;
    return {
      index: outcome.index,
      sql: outcome.sql,
      status: outcome.status,
      columns: result.columns,
      rows: result.rows.map((row) => row.map((cell) => truncateCell(cell, maxCellChars))),
      rowCount: result.rowCount,
      truncated: result.truncated,
      durationMs: result.durationMs,
      command: result.command,
    };
  });
  return { statements };
}

/**
 * ペイロードを JSON 化する。全体が `maxChars` を超える場合は、末尾の文から・行の末尾から
 * 順に行を落として上限内に収め、落としたことを `truncated: true`（該当する文）と
 * `note`（ペイロード全体）の両方に記録する。
 */
export function serializePayload(payload: AiRunSqlPayload, maxChars: number = MAX_PAYLOAD_CHARS): string {
  const initial = JSON.stringify(payload);
  if (initial.length <= maxChars) {
    return initial;
  }

  const shrunk: AiRunSqlPayload = {
    statements: payload.statements.map((statement) => ({
      ...statement,
      rows: statement.rows ? [...statement.rows] : statement.rows,
    })),
  };

  let anyDropped = false;
  for (let si = shrunk.statements.length - 1; si >= 0; si -= 1) {
    const statement = shrunk.statements[si];
    while (statement.rows && statement.rows.length > 0 && JSON.stringify(shrunk).length > maxChars) {
      statement.rows.pop();
      statement.truncated = true;
      anyDropped = true;
    }
    if (JSON.stringify(shrunk).length <= maxChars) {
      break;
    }
  }

  if (anyDropped) {
    const remainingRows = shrunk.statements.reduce((sum, statement) => sum + (statement.rows?.length ?? 0), 0);
    shrunk.note = `文字数の上限により ${remainingRows} 行のみ返しました`;
  }

  return JSON.stringify(shrunk);
}
