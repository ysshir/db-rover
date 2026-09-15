import { Client } from 'pg';
import * as vscode from 'vscode';
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

const EXCLUDED_SCHEMAS = ['pg_catalog', 'information_schema'];

export class PostgresDriver implements DbDriver {
  readonly kind = 'postgres' as const;
  private client: Client | undefined;

  constructor(
    private readonly config: ConnectionConfig,
    private readonly password: string | undefined,
  ) {}

  async connect(): Promise<void> {
    const client = new Client({
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user,
      password: this.password,
      ssl: this.config.ssl ? { rejectUnauthorized: false } : undefined,
    });
    await client.connect();
    this.client = client;
  }

  async dispose(): Promise<void> {
    if (this.client) {
      await this.client.end().catch(() => undefined);
      this.client = undefined;
    }
  }

  private getClient(): Client {
    if (!this.client) {
      throw new Error('PostgreSQL に接続されていません。');
    }
    return this.client;
  }

  async listSchemas(): Promise<string[]> {
    const result = await this.getClient().query<{ schema_name: string }>(
      `SELECT schema_name FROM information_schema.schemata
       WHERE schema_name != ALL($1::text[])
       ORDER BY schema_name`,
      [EXCLUDED_SCHEMAS],
    );
    return result.rows.map((row) => row.schema_name);
  }

  async listTables(schema: string): Promise<TableMeta[]> {
    const result = await this.getClient().query<{ table_name: string; table_type: string }>(
      `SELECT table_name, table_type FROM information_schema.tables
       WHERE table_schema = $1
       ORDER BY table_name`,
      [schema],
    );
    return result.rows.map((row) => ({
      schema,
      name: row.table_name,
      type: row.table_type === 'VIEW' ? 'view' : 'table',
    }));
  }

  async listColumns(schema: string, table: string): Promise<ColumnMeta[]> {
    const result = await this.getClient().query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      column_default: string | null;
      is_primary_key: boolean;
    }>(
      `SELECT c.column_name, c.data_type, c.is_nullable, c.column_default,
         EXISTS (
           SELECT 1 FROM information_schema.table_constraints tc
           JOIN information_schema.key_column_usage kcu
             ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
           WHERE tc.constraint_type = 'PRIMARY KEY'
             AND tc.table_schema = $1 AND tc.table_name = $2
             AND kcu.column_name = c.column_name
         ) AS is_primary_key
       FROM information_schema.columns c
       WHERE c.table_schema = $1 AND c.table_name = $2
       ORDER BY c.ordinal_position`,
      [schema, table],
    );
    return result.rows.map((row) => ({
      name: row.column_name,
      dataType: row.data_type,
      nullable: row.is_nullable === 'YES',
      defaultValue: row.column_default,
      isPrimaryKey: row.is_primary_key,
    }));
  }

  async listIndexes(schema: string, table: string): Promise<IndexMeta[]> {
    const result = await this.getClient().query<{
      index_name: string;
      is_unique: boolean;
      is_primary: boolean;
      columns: string[];
    }>(
      `SELECT
         ix.relname AS index_name,
         i.indisunique AS is_unique,
         i.indisprimary AS is_primary,
         array_agg(a.attname ORDER BY x.ord) AS columns
       FROM pg_index i
       JOIN pg_class ix ON ix.oid = i.indexrelid
       JOIN pg_class t ON t.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       JOIN unnest(i.indkey) WITH ORDINALITY AS x(attnum, ord) ON true
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.attnum
       WHERE n.nspname = $1 AND t.relname = $2
       GROUP BY ix.relname, i.indisunique, i.indisprimary
       ORDER BY ix.relname`,
      [schema, table],
    );
    return result.rows.map((row) => ({
      name: row.index_name,
      columns: row.columns,
      unique: row.is_unique,
      primary: row.is_primary,
    }));
  }

  async query(sql: string, limit: number): Promise<QueryResult> {
    const start = Date.now();
    const result = await this.getClient().query({ text: sql, rowMode: 'array' as const });
    const durationMs = Date.now() - start;

    const columns = result.fields.map((field) => field.name);
    if (columns.length === 0) {
      return {
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        durationMs,
        command: `${result.command} ${result.rowCount ?? 0} 行が影響を受けました`,
      };
    }

    const allRows = result.rows as unknown[][];
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
      placeholderStyle: 'dollar',
      qualifyTable: (schema, table) => `${this.quoteIdent(schema)}.${this.quoteIdent(table)}`,
    };
  }

  async browse(req: BrowseRequest): Promise<BrowseResult> {
    const columns = await this.listColumns(req.schema, req.table);
    const built = buildBrowseQuery(req, columns, this.dialect());
    const start = Date.now();
    const result = await this.getClient().query({ text: built.sql, values: built.params, rowMode: 'array' as const });
    const durationMs = Date.now() - start;
    const totalCount = await this.countRows(req.schema, req.table, req.filters ?? [], req.where);
    const rows = (result.rows as unknown[][]).map(normalizeRow);
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
      const result = await this.getClient().query({ text: built.sql, values: built.params, rowMode: 'array' as const });
      const raw = result.rows[0]?.[0];
      const count = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number(raw);
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
    const client = this.getClient();
    let affected = 0;
    await client.query('BEGIN');
    try {
      for (const statement of statements) {
        const result = await client.query({ text: statement.sql, values: statement.params });
        affected += result.rowCount ?? 0;
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
    return affected;
  }
}
