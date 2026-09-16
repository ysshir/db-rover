/**
 * SQL 文の判定（接続断からの再送可否・書き込み種別の分類）の邪魔になる
 * コメントと文字列リテラルを取り除くための共通ヘルパー。
 *
 * vscode に依存させないこと。scripts/check-recovery.mjs / scripts/check-statement-kind.mjs が
 * それぞれ単体ビルドして検証する。
 */

/** 判定の邪魔になるコメントと文字列リテラルを空白に潰す。 */
export function stripSqlNoise(sql: string): string {
  let result = '';
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (char === '-' && next === '-') {
      while (index < sql.length && sql[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      index += 2;
      while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) index += 1;
      index += 2;
      result += ' ';
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      const quote = char;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === '\\' && quote === '\'') {
          index += 2;
          continue;
        }
        if (sql[index] === quote) {
          // '' / "" / `` によるエスケープ
          if (sql[index + 1] === quote) {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      result += ' ';
      continue;
    }
    result += char;
    index += 1;
  }
  return result;
}
