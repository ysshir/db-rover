import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Database } from 'node-sqlite3-wasm';
import type { BindValues } from 'node-sqlite3-wasm';
import type {
  BrowseRequest,
  BrowseResult,
  ConnectionConfig,
  ColumnMeta,
  FilterSpec,
  IndexMeta,
  PreparedStatement,
  QueryResult,
  RowMutation,
  TableMeta,
} from '../types.js';
import type { DbDriver } from './driver.js';
import { normalizeRow } from '../util/normalize.js';
import { buildBrowseQuery, buildCountQuery, buildMutationStatements, type Dialect } from './sqlBuilder.js';

// SELECT / PRAGMA / EXPLAIN / WITH(CTE) は行を返しうる文とみなす。
// それ以外（INSERT/UPDATE/DELETE/CREATE 等）はコマンド実行として扱う。
const DATA_RETURNING_PATTERN = /^\s*(select|pragma|explain|with)\b/i;

function resolveSqliteFile(file: string): string {
  if (!file) {
    throw new Error('SQLite の接続には file（データベースファイルのパス）が必要です。');
  }
  let resolved = file;
  if (resolved.startsWith('~')) {
    resolved = path.join(os.homedir(), resolved.slice(1));
  }
  if (!path.isAbsolute(resolved)) {
    const folders = vscode.workspace.workspaceFolders;
    const base = folders && folders.length > 0 ? folders[0].uri.fsPath : process.cwd();
    resolved = path.join(base, resolved);
  }
  return resolved;
}

interface TableRow {
  name: string;
  type: string;
}

interface TableInfoRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface IndexListRow {
  name: string;
  unique: number;
  origin: string;
}

interface IndexInfoRow {
  seqno: number;
  cid: number;
  name: string;
}

export class SqliteDriver implements DbDriver {
  readonly kind = 'sqlite' as const;
  private db: Database | undefined;

  constructor(private readonly config: ConnectionConfig) {}

  async connect(): Promise<void> {
    const filePath = resolveSqliteFile(this.config.file ?? '');
    this.db = new Database(filePath);
  }

  async dispose(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = undefined;
    }
  }

  private getDb(): Database {
    if (!this.db) {
      throw new Error('SQLite に接続されていません。');
    }
    return this.db;
  }

  async listSchemas(): Promise<string[]> {
    return ['main'];
  }

  async listTables(_schema: string): Promise<TableMeta[]> {
    const rows = this.getDb().all(
      `SELECT name, type FROM sqlite_master
       WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    ) as unknown as TableRow[];
    return rows.map((row) => ({
      name: row.name,
      type: row.type === 'view' ? 'view' : 'table',
    }));
  }

  async listColumns(_schema: string, table: string): Promise<ColumnMeta[]> {
    // PRAGMA はバインドパラメータをサポートしないため、識別子は quoteIdent でエスケープして埋め込む。
    const rows = this.getDb().all(`PRAGMA table_info(${this.quoteIdent(table)})`) as unknown as TableInfoRow[];
    return rows.map((row) => ({
      name: row.name,
      dataType: row.type,
      nullable: row.notnull === 0,
      defaultValue: row.dflt_value,
      isPrimaryKey: row.pk > 0,
    }));
  }

  async listIndexes(_schema: string, table: string): Promise<IndexMeta[]> {
    const indexList = this.getDb().all(`PRAGMA index_list(${this.quoteIdent(table)})`) as unknown as IndexListRow[];
    const indexes: IndexMeta[] = [];
    for (const index of indexList) {
      const infoRows = this.getDb().all(`PRAGMA index_info(${this.quoteIdent(index.name)})`) as unknown as IndexInfoRow[];
      const columns = infoRows
        .slice()
        .sort((a, b) => a.seqno - b.seqno)
        .map((row) => row.name);
      indexes.push({
        name: index.name,
        columns,
        unique: index.unique === 1,
        primary: index.origin === 'pk',
      });
    }
    return indexes;
  }

  async query(sql: string, limit: number): Promise<QueryResult> {
    const db = this.getDb();
    const start = Date.now();

    if (!DATA_RETURNING_PATTERN.test(sql)) {
      const result = db.run(sql);
      const durationMs = Date.now() - start;
      return {
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        durationMs,
        command: `影響を受けた行数: ${result.changes}`,
      };
    }

    const rawRows = db.all(sql) as unknown as Array<Record<string, unknown>>;
    const durationMs = Date.now() - start;
    const columns = rawRows.length > 0 ? Object.keys(rawRows[0]) : [];
    const allRows = rawRows.map((row) => columns.map((column) => row[column]));
    const truncated = allRows.length > limit;
    const rows = (truncated ? allRows.slice(0, limit) : allRows).map(normalizeRow);
    return {
      columns,
      rows,
      rowCount: rows.length,
      truncated,
      durationMs,
    };
  }

  quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }


  private dialect(): Dialect {
    return {
      quoteIdent: (name) => this.quoteIdent(name),
      placeholderStyle: 'question',
      // sqlite は schema 概念を持たない（listSchemas は常に ['main']）ため table 名のみ使う。
      qualifyTable: (_schema, table) => this.quoteIdent(table),
    };
  }

  async browse(req: BrowseRequest): Promise<BrowseResult> {
    const columns = await this.listColumns(req.schema, req.table);
    const built = buildBrowseQuery(req, columns, this.dialect());
    const start = Date.now();
    const rawRows = this.getDb().all(built.sql, built.params as unknown as BindValues) as unknown as Array<
      Record<string, unknown>
    >;
    const durationMs = Date.now() - start;
    const totalCount = await this.countRows(req.schema, req.table, req.filters ?? [], req.where);
    const rows = rawRows.map((row) => normalizeRow(columns.map((column) => row[column.name])));
    return { columns, rows, offset: req.offset, totalCount, durationMs };
  }

  async countRows(schema: string, table: string, filters: FilterSpec[], where?: string): Promise<number | null> {
    const enabled = vscode.workspace.getConfiguration('dbRover').get<boolean>('countRows', true);
    if (!enabled) {
      return null;
    }
    try {
      const columns = await this.listColumns(schema, table);
      const built = buildCountQuery(schema, table, filters, columns, this.dialect(), where);
      const row = this.getDb().get(built.sql, built.params as unknown as BindValues) as Record<string, unknown> | null;
      const raw = row ? row['cnt'] : null;
      const count = typeof raw === 'bigint' ? Number(raw) : Number(raw);
      return Number.isFinite(count) ? count : null;
    } catch {
      return null;
    }
  }

  buildMutations(
    schema: string,
    table: string,
    muts: RowMutation[],
    columns: ColumnMeta[],
  ): PreparedStatement[] {
    return buildMutationStatements(schema, table, muts, columns, this.dialect());
  }

  async applyMutations(statements: PreparedStatement[]): Promise<number> {
    const db = this.getDb();
    let affected = 0;
    db.exec('BEGIN');
    try {
      for (const statement of statements) {
        const result = db.run(statement.sql, statement.params as unknown as BindValues);
        affected += result.changes;
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return affected;
  }
}
