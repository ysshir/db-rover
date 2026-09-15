// SQL を `;` 区切りで文に分割する純粋関数。
// vscode に依存させないこと（scripts/check-statements.mjs から単体ビルドして検証するため）。

import type { DbKind } from '../types.js';

export interface SqlStatement {
  /** 実行する SQL 本体。前後の空白と末尾の `;` は含まない。 */
  sql: string;
  /** 元テキスト内での開始オフセット。先頭の空白とコメントは飛ばした位置。 */
  start: number;
  /** 元テキスト内での終了オフセット（sql の最後の文字の次）。 */
  end: number;
}

/**
 * `;` で文に分割する。文字列リテラル・引用識別子・コメントの中の `;` は区切りとみなさない。
 * 閉じられていないリテラルやコメントは、テキスト末尾までをその範囲として扱う。
 */
export function splitSqlStatements(text: string, kind: DbKind): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let start = -1; // 現在の文の開始位置。-1 は「まだ本体が始まっていない」
  let i = 0;

  const flush = (endExclusive: number): void => {
    if (start < 0) return;
    const sql = text.slice(start, endExclusive).replace(/\s+$/, '');
    if (sql.length > 0) {
      statements.push({ sql, start, end: start + sql.length });
    }
    start = -1;
  };

  while (i < text.length) {
    const ch = text[i];

    // -- 行コメント
    if (ch === '-' && text[i + 1] === '-') {
      const newline = text.indexOf('\n', i);
      i = newline < 0 ? text.length : newline + 1;
      continue;
    }

    // /* ブロックコメント */（PostgreSQL は入れ子を許す）
    if (ch === '/' && text[i + 1] === '*') {
      i = skipBlockComment(text, i, kind === 'postgres');
      continue;
    }

    // 文の本体が始まる前の空白は、文の開始位置に含めない。
    if (isSpace(ch)) {
      i += 1;
      continue;
    }

    if (start < 0) {
      start = i;
    }

    if (ch === ';') {
      flush(i);
      i += 1;
      continue;
    }

    if (ch === "'") {
      // PostgreSQL の E'...' だけはバックスラッシュがエスケープとして効く。
      const escaping = kind === 'mysql' || (kind === 'postgres' && isEscapeStringPrefix(text, i));
      i = skipQuoted(text, i, "'", escaping);
      continue;
    }

    if (ch === '"') {
      i = skipQuoted(text, i, '"', kind === 'mysql');
      continue;
    }

    if (ch === '`') {
      i = skipQuoted(text, i, '`', false);
      continue;
    }

    // SQLite は [識別子] を許す。エスケープの概念は無い。
    if (ch === '[' && kind === 'sqlite') {
      const close = text.indexOf(']', i + 1);
      i = close < 0 ? text.length : close + 1;
      continue;
    }

    // PostgreSQL のドル引用符 $$...$$ / $tag$...$tag$
    if (ch === '$' && kind === 'postgres') {
      i = skipDollarQuoted(text, i);
      continue;
    }

    i += 1;
  }

  flush(text.length);
  return statements;
}

/** オフセットを含む文を返す。境界上（文の直後の空白など）は直前の文に寄せる。 */
export function statementAtOffset(statements: SqlStatement[], offset: number): SqlStatement | undefined {
  let candidate: SqlStatement | undefined;
  for (const statement of statements) {
    if (statement.start > offset) break;
    candidate = statement;
  }
  return candidate;
}

/**
 * オフセットに最も近い文を返す。文の内側ならその文、文と文の間なら
 * 直前の文の末尾と次の文の先頭のうち近いほう（等距離なら次の文）。
 */
export function nearestStatement(statements: SqlStatement[], offset: number): SqlStatement | undefined {
  let previous: SqlStatement | undefined;
  for (const statement of statements) {
    if (offset < statement.start) {
      if (!previous) return statement;
      return offset - previous.end < statement.start - offset ? previous : statement;
    }
    if (offset <= statement.end) return statement;
    previous = statement;
  }
  return previous;
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v';
}

/** 直前が単語境界の E / e なら、この文字列リテラルはエスケープ付き（E'...'）。 */
function isEscapeStringPrefix(text: string, quoteIndex: number): boolean {
  const prev = text[quoteIndex - 1];
  if (prev !== 'E' && prev !== 'e') return false;
  const before = text[quoteIndex - 2];
  return before === undefined || !/[\w$]/.test(before);
}

function skipBlockComment(text: string, start: number, nested: boolean): number {
  let i = start + 2;
  let depth = 1;
  while (i < text.length) {
    if (nested && text[i] === '/' && text[i + 1] === '*') {
      depth += 1;
      i += 2;
      continue;
    }
    if (text[i] === '*' && text[i + 1] === '/') {
      depth -= 1;
      i += 2;
      if (depth === 0) return i;
      continue;
    }
    i += 1;
  }
  return text.length;
}

function skipQuoted(text: string, start: number, quote: string, backslashEscapes: boolean): number {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (backslashEscapes && ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) {
      // 同じ引用符 2 つ並びは、リテラル中の引用符そのもの。
      if (text[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return text.length;
}

function skipDollarQuoted(text: string, start: number): number {
  const match = /^\$[A-Za-z_]\w*\$|^\$\$/.exec(text.slice(start));
  if (!match) return start + 1; // ただの $（パラメータ記号など）
  const tag = match[0];
  const close = text.indexOf(tag, start + tag.length);
  return close < 0 ? text.length : close + tag.length;
}
