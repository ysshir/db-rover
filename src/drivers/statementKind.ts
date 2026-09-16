/**
 * SQL 文を「読み取り / 書き込み / 破壊的」に分類する純粋関数。
 *
 * `'read'` は recovery.ts の `isRetryableStatement` と同じ意味（接続断からの再送可否）を兼ねる。
 * AI 連携（src/ai）の承認判定はここに一本化する。
 *
 * vscode に依存させないこと。scripts/check-statement-kind.mjs が単体ビルドして検証する。
 */

import { stripSqlNoise } from './sqlText.js';

export type StatementKind = 'read' | 'write' | 'destructive';

/** 行を返すだけで副作用が無いとみなせる文の先頭キーワード。 */
const READ_ONLY_HEAD = /^(select|with|show|explain|describe|desc|pragma|values|table)\b/i;

/** 読み取り専用に見えても、実際には書き込む構文。 */
const WRITE_INSIDE = /\b(insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|call|do)\b/i;

/** 取り返しのつかない文の先頭キーワード。 */
const DESTRUCTIVE_HEAD = /^(drop|truncate)\b/i;

const DELETE_HEAD = /^delete\b/i;
const UPDATE_HEAD = /^update\b/i;
const WHERE_CLAUSE = /\bwhere\b/i;

/** ALTER TABLE ... DROP COLUMN のように、先頭キーワードだけでは拾えない破壊的な構文。 */
const DESTRUCTIVE_DROP_INSIDE = /\bdrop\s+(table|database|schema|index|column)\b/i;

/**
 * SQL 文を分類する。判定は必ず `stripSqlNoise()` を通した文字列に対して行い、
 * コメントや文字列リテラルの中身に惑わされないようにする。
 *
 * フェイルクローズ: 空文・解釈不能なもの、読み取りと確信できないものは
 * すべて `'write'` 以上（少なくとも承認を要する側）に倒す。
 */
export function classifyStatement(sql: string): StatementKind {
  const normalized = stripSqlNoise(sql).trim();
  if (normalized === '') {
    return 'write';
  }

  if (DESTRUCTIVE_HEAD.test(normalized)) {
    return 'destructive';
  }
  if (DELETE_HEAD.test(normalized) && !WHERE_CLAUSE.test(normalized)) {
    return 'destructive';
  }
  if (UPDATE_HEAD.test(normalized) && !WHERE_CLAUSE.test(normalized)) {
    return 'destructive';
  }
  if (DESTRUCTIVE_DROP_INSIDE.test(normalized)) {
    return 'destructive';
  }

  if (READ_ONLY_HEAD.test(normalized) && !WRITE_INSIDE.test(normalized)) {
    return 'read';
  }

  return 'write';
}
