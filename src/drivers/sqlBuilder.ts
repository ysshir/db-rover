// DB 種別に依存しない、SQL 生成の純粋関数群。
// - 列名は必ず ColumnMeta のホワイトリストと突き合わせて検証する。
// - 値は必ずプレースホルダにし、SQL 文字列へ直接連結しない。
// vscode やドライバの接続オブジェクトに依存しないため、node の素のスクリプトから
// 直接 import してユニット検証できる（scripts/check-mutations.mjs 参照）。

import type {
  BrowseRequest,
  ColumnMeta,
  FilterSpec,
  PreparedStatement,
  RowMutation,
  SortSpec,
} from '../types.js';

export type PlaceholderStyle = 'dollar' | 'question';

export interface Dialect {
  quoteIdent(name: string): string;
  /** pg は '$1' 形式、mysql/sqlite は '?' 形式 */
  placeholderStyle: PlaceholderStyle;
  /** schema.table のような完全修飾テーブル名を組み立てる（sqlite は schema を無視する） */
  qualifyTable(schema: string, table: string): string;
}

class PlaceholderGenerator {
  private count = 0;
  constructor(private readonly style: PlaceholderStyle) {}
  next(): string {
    this.count += 1;
    return this.style === 'dollar' ? `$${this.count}` : '?';
  }
}

function assertKnownColumns(names: string[], columns: ColumnMeta[], context: string): void {
  const known = new Set(columns.map((column) => column.name));
  for (const name of names) {
    if (!known.has(name)) {
      throw new Error(`不明な列名です（${context}）: ${name}`);
    }
  }
}

/** LIKE 内で特殊文字として扱われる % _ \ をエスケープする。ESCAPE '\' との組で使うこと。 */
export function escapeLikeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

const MAX_WHERE_LENGTH = 2000;

/**
 * ユーザーが手書きした WHERE 式を検証する。式そのものは SQL へ連結されるため、
 * 文字列リテラルの外にある「文の区切り（;）」と「コメント（-- # / * ... * /）」を拒否し、
 * 1 つの SELECT の WHERE 句から抜け出せないようにする。
 * バックスラッシュによるエスケープは解釈しない（解釈すると閉じ忘れを見逃す方向に倒れるため）。
 * MySQL の '\'' は '' で書くこと。
 */
export function validateWhereExpression(raw: string | undefined): string {
  const expr = (raw ?? '').trim();
  if (!expr) {
    return '';
  }
  if (expr.length > MAX_WHERE_LENGTH) {
    throw new Error(`WHERE 式が長すぎます（${MAX_WHERE_LENGTH} 文字以内にしてください）。`);
  }
  let quote: string | undefined;
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i];
    if (quote !== undefined) {
      if (ch === quote) {
        if (expr[i + 1] === quote) {
          i += 1; // '' / "" / `` によるエスケープ
          continue;
        }
        quote = undefined;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === ';') {
      throw new Error('WHERE 式にセミコロン（;）は使用できません。');
    }
    if ((ch === '-' && expr[i + 1] === '-') || ch === '#' || (ch === '/' && expr[i + 1] === '*')) {
      throw new Error('WHERE 式にコメント（--、#、/* */）は使用できません。');
    }
  }
  if (quote !== undefined) {
    throw new Error(
      `WHERE 式の引用符（${quote}）が閉じられていません。文字列内の引用符は 2 つ重ねて書いてください（バックスラッシュによるエスケープは未対応です）。`,
    );
  }
  return expr;
}

interface WhereClauseResult {
  clause: string;
  params: unknown[];
}

function buildWhereClause(
  filters: FilterSpec[],
  columns: ColumnMeta[],
  dialect: Dialect,
  ph: PlaceholderGenerator,
  rawWhere?: string,
): WhereClauseResult {
  assertKnownColumns(
    filters.map((filter) => filter.column),
    columns,
    'フィルタ',
  );

  const parts: string[] = [];
  const params: unknown[] = [];

  for (const filter of filters) {
    const col = dialect.quoteIdent(filter.column);
    switch (filter.operator) {
      case 'isNull':
        parts.push(`${col} IS NULL`);
        break;
      case 'isNotNull':
        parts.push(`${col} IS NOT NULL`);
        break;
      case 'eq':
        if (filter.value === undefined) continue;
        parts.push(`${col} = ${ph.next()}`);
        params.push(filter.value);
        break;
      case 'neq':
        if (filter.value === undefined) continue;
        parts.push(`${col} <> ${ph.next()}`);
        params.push(filter.value);
        break;
      case 'gt':
        if (filter.value === undefined) continue;
        parts.push(`${col} > ${ph.next()}`);
        params.push(filter.value);
        break;
      case 'gte':
        if (filter.value === undefined) continue;
        parts.push(`${col} >= ${ph.next()}`);
        params.push(filter.value);
        break;
      case 'lt':
        if (filter.value === undefined) continue;
        parts.push(`${col} < ${ph.next()}`);
        params.push(filter.value);
        break;
      case 'lte':
        if (filter.value === undefined) continue;
        parts.push(`${col} <= ${ph.next()}`);
        params.push(filter.value);
        break;
      case 'contains':
        if (filter.value === undefined) continue;
        parts.push(`${col} LIKE ${ph.next()} ESCAPE '\\'`);
        params.push(`%${escapeLikeValue(filter.value)}%`);
        break;
      case 'startsWith':
        if (filter.value === undefined) continue;
        parts.push(`${col} LIKE ${ph.next()} ESCAPE '\\'`);
        params.push(`${escapeLikeValue(filter.value)}%`);
        break;
      case 'endsWith':
        if (filter.value === undefined) continue;
        parts.push(`${col} LIKE ${ph.next()} ESCAPE '\\'`);
        params.push(`%${escapeLikeValue(filter.value)}`);
        break;
      default: {
        const exhaustiveCheck: never = filter.operator;
        throw new Error(`未対応のフィルタ演算子です: ${String(exhaustiveCheck)}`);
      }
    }
  }

  const expression = validateWhereExpression(rawWhere);
  if (expression) {
    // 列フィルタと混ざっても評価順が変わらないよう括弧で包む。
    parts.push(`(${expression})`);
  }

  return {
    clause: parts.length > 0 ? ` WHERE ${parts.join(' AND ')}` : '',
    params,
  };
}

function buildOrderByClause(sort: SortSpec[], columns: ColumnMeta[], dialect: Dialect): string {
  assertKnownColumns(
    sort.map((s) => s.column),
    columns,
    'ソート',
  );
  // 並び順を指定しない場合でも ORDER BY を必ず付ける。付けないと LIMIT/OFFSET の
  // ページングで行の重複・取りこぼしが起こりうるため。主キーは一意なのでページ境界が
  // 安定する。主キーが無いテーブルは先頭列で代用する（完全な安定は保証できない）。
  const defaultSort: SortSpec[] = (() => {
    const pk = columns.filter((column) => column.isPrimaryKey);
    const base = pk.length > 0 ? pk : columns.slice(0, 1);
    return base.map((column) => ({ column: column.name, direction: 'asc' as const }));
  })();
  const effectiveSort = sort.length > 0 ? sort : defaultSort;
  if (effectiveSort.length === 0) {
    return '';
  }
  const parts = effectiveSort.map(
    (s) => `${dialect.quoteIdent(s.column)} ${s.direction === 'desc' ? 'DESC' : 'ASC'}`,
  );
  return ` ORDER BY ${parts.join(', ')}`;
}

export interface BuiltQuery {
  sql: string;
  params: unknown[];
}

export function buildBrowseQuery(req: BrowseRequest, columns: ColumnMeta[], dialect: Dialect): BuiltQuery {
  if (columns.length === 0) {
    throw new Error('列情報が取得できませんでした。');
  }
  const ph = new PlaceholderGenerator(dialect.placeholderStyle);
  const selectList = columns.map((column) => dialect.quoteIdent(column.name)).join(', ');
  const where = buildWhereClause(req.filters ?? [], columns, dialect, ph, req.where);
  const orderBy = buildOrderByClause(req.sort, columns, dialect);
  const limitPh = ph.next();
  const offsetPh = ph.next();
  const sql = `SELECT ${selectList} FROM ${dialect.qualifyTable(req.schema, req.table)}${where.clause}${orderBy} LIMIT ${limitPh} OFFSET ${offsetPh}`;
  return {
    sql,
    params: [...where.params, req.limit, req.offset],
  };
}

export function buildCountQuery(
  schema: string,
  table: string,
  filters: FilterSpec[],
  columns: ColumnMeta[],
  dialect: Dialect,
  rawWhere?: string,
): BuiltQuery {
  const ph = new PlaceholderGenerator(dialect.placeholderStyle);
  const where = buildWhereClause(filters, columns, dialect, ph, rawWhere);
  const sql = `SELECT COUNT(*) AS cnt FROM ${dialect.qualifyTable(schema, table)}${where.clause}`;
  return { sql, params: where.params };
}

function assertNonEmptyKey(key: Record<string, unknown>, action: string): void {
  if (Object.keys(key).length === 0) {
    throw new Error(`${action} には WHERE 条件となる key が必須です（空の key は許可されません）。`);
  }
}

export function buildMutationStatements(
  schema: string,
  table: string,
  muts: RowMutation[],
  columns: ColumnMeta[],
  dialect: Dialect,
): PreparedStatement[] {
  const tableRef = dialect.qualifyTable(schema, table);
  const statements: PreparedStatement[] = [];

  for (const mut of muts) {
    const ph = new PlaceholderGenerator(dialect.placeholderStyle);
    switch (mut.type) {
      case 'update': {
        assertNonEmptyKey(mut.key, 'UPDATE');
        assertKnownColumns(Object.keys(mut.changes), columns, 'UPDATE の変更対象列');
        assertKnownColumns(Object.keys(mut.key), columns, 'UPDATE の key 列');
        const changeEntries = Object.entries(mut.changes);
        if (changeEntries.length === 0) {
          throw new Error('UPDATE には変更する列が 1 つ以上必要です。');
        }
        const setClause = changeEntries
          .map(([col, value]) => {
            const assignment = `${dialect.quoteIdent(col)} = ${ph.next()}`;
            void value;
            return assignment;
          })
          .join(', ');
        const setParams = changeEntries.map(([, value]) => value);
        const keyEntries = Object.entries(mut.key);
        const whereClause = keyEntries.map(([col]) => `${dialect.quoteIdent(col)} = ${ph.next()}`).join(' AND ');
        const keyParams = keyEntries.map(([, value]) => value);
        statements.push({
          sql: `UPDATE ${tableRef} SET ${setClause} WHERE ${whereClause}`,
          params: [...setParams, ...keyParams],
        });
        break;
      }
      case 'delete': {
        assertNonEmptyKey(mut.key, 'DELETE');
        assertKnownColumns(Object.keys(mut.key), columns, 'DELETE の key 列');
        const keyEntries = Object.entries(mut.key);
        const whereClause = keyEntries.map(([col]) => `${dialect.quoteIdent(col)} = ${ph.next()}`).join(' AND ');
        const keyParams = keyEntries.map(([, value]) => value);
        statements.push({
          sql: `DELETE FROM ${tableRef} WHERE ${whereClause}`,
          params: keyParams,
        });
        break;
      }
      case 'insert': {
        assertKnownColumns(Object.keys(mut.values), columns, 'INSERT の列');
        const entries = Object.entries(mut.values);
        if (entries.length === 0) {
          throw new Error('INSERT には値が 1 つ以上必要です。');
        }
        const columnList = entries.map(([col]) => dialect.quoteIdent(col)).join(', ');
        const valuesList = entries.map(() => ph.next()).join(', ');
        const insertParams = entries.map(([, value]) => value);
        statements.push({
          sql: `INSERT INTO ${tableRef} (${columnList}) VALUES (${valuesList})`,
          params: insertParams,
        });
        break;
      }
      default: {
        const exhaustiveCheck: never = mut;
        throw new Error(`未対応の RowMutation です: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  }

  return statements;
}
