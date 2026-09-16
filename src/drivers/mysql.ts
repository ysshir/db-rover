import { createConnection } from 'mysql2/promise';
import type { Connection, FieldPacket, ResultSetHeader } from 'mysql2/promise';
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

const EXCLUDED_SCHEMAS = ['mysql', 'information_schema', 'performance_schema', 'sys'];

interface SchemaRow {
  SCHEMA_NAME: string;
}

interface TableRow {
  TABLE_NAME: string;
  TABLE_TYPE: string;
}

interface ColumnRow {
  COLUMN_NAME: string;
  DATA_TYPE: string;
  IS_NULLABLE: string;
  COLUMN_DEFAULT: string | null;
  COLUMN_KEY: string;
}

interface StatisticsRow {
  INDEX_NAME: string;
  NON_UNIQUE: number;
  COLUMN_NAME: string;
  SEQ_IN_INDEX: number;
}

export class MysqlDriver implements DbDriver {
  readonly kind = 'mysql' as const;
  private connection: Connection | undefined;
  // 張り直し（dispose → connect）をまたいで生き残る必要があるので dispose() では捨てない。
  private readonly connectionLostEmitter = new vscode.EventEmitter<unknown>();
  readonly onConnectionLost = this.connectionLostEmitter.event;

  constructor(
    private readonly config: ConnectionConfig,
    private readonly password: string | undefined,
  ) {}

  async connect(): Promise<void> {
    const connection = await createConnection({
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user,
      password: this.password,
      ssl: this.config.ssl ? {} : undefined,
    });
    // クエリを待っていないときにソケットが死ぬと 'error' が飛ぶ。listener が無いと
    // Node の既定動作で拡張機能ホストごと落ちるため、必ず受け取って上位に知らせる。
    connection.on('error', (error: unknown) => {
      if (this.connection !== connection) {
        return; // 既に張り直した後の、古い接続からの通知
      }
      this.connection = undefined;
      this.connectionLostEmitter.fire(error);
    });
    this.connection = connection;
  }

  async dispose(): Promise<void> {
    if (this.connection) {
      const connection = this.connection;
      this.connection = undefined;
      // 既に死んでいる接続の end() は同期的に投げることがある
      await Promise.resolve()
        .then(() => connection.end())
        .catch(() => undefined);
    }
  }

  private getConnection(): Connection {
    if (!this.connection) {
      throw new Error('MySQL に接続されていません。');
    }
    return this.connection;
  }

  async listSchemas(): Promise<string[]> {
    const [rows] = await this.getConnection().query(
      `SELECT SCHEMA_NAME FROM information_schema.SCHEMATA
       WHERE SCHEMA_NAME NOT IN (?)
       ORDER BY SCHEMA_NAME`,
      [EXCLUDED_SCHEMAS],
    );
    return (rows as unknown as SchemaRow[]).map((row) => row.SCHEMA_NAME);
  }

  async listTables(schema: string): Promise<TableMeta[]> {
    const [rows] = await this.getConnection().query(
      `SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME`,
      [schema],
    );
    return (rows as unknown as TableRow[]).map((row) => ({
      schema,
      name: row.TABLE_NAME,
      type: row.TABLE_TYPE === 'VIEW' ? 'view' : 'table',
    }));
  }

  async listColumns(schema: string, table: string): Promise<ColumnMeta[]> {
    const [rows] = await this.getConnection().query(
      `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [schema, table],
    );
    return (rows as unknown as ColumnRow[]).map((row) => ({
      name: row.COLUMN_NAME,
      dataType: row.DATA_TYPE,
      nullable: row.IS_NULLABLE === 'YES',
      defaultValue: row.COLUMN_DEFAULT,
      isPrimaryKey: row.COLUMN_KEY === 'PRI',
    }));
  }

  async listIndexes(schema: string, table: string): Promise<IndexMeta[]> {
    const [rows] = await this.getConnection().query(
      `SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX
       FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      [schema, table],
    );
    const byName = new Map<string, IndexMeta>();
    for (const row of rows as unknown as StatisticsRow[]) {
      let index = byName.get(row.INDEX_NAME);
      if (!index) {
        index = {
          name: row.INDEX_NAME,
          columns: [],
          unique: row.NON_UNIQUE === 0,
          primary: row.INDEX_NAME === 'PRIMARY',
        };
        byName.set(row.INDEX_NAME, index);
      }
      index.columns.push(row.COLUMN_NAME);
    }
    return Array.from(byName.values());
  }

  async query(sql: string, limit: number): Promise<QueryResult> {
    const start = Date.now();
    const [result, fields] = await this.getConnection().query({ sql, rowsAsArray: true });
    const durationMs = Date.now() - start;

    if (!Array.isArray(result)) {
      const header = result as ResultSetHeader;
      return {
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        durationMs,
        command: `影響を受けた行数: ${header.affectedRows ?? 0}`,
      };
    }

    const columns = (fields as FieldPacket[]).map((field) => field.name);
    const allRows = result as unknown as unknown[][];
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
    return `\`${name.replace(/`/g, '``')}\``;
  }


  private dialect(): Dialect {
    return {
      quoteIdent: (name) => this.quoteIdent(name),
      placeholderStyle: 'question',
      qualifyTable: (schema, table) => `${this.quoteIdent(schema)}.${this.quoteIdent(table)}`,
    };
  }

  async browse(req: BrowseRequest): Promise<BrowseResult> {
    const columns = await this.listColumns(req.schema, req.table);
    const built = buildBrowseQuery(req, columns, this.dialect());
    const start = Date.now();
    const [result, fields] = await this.getConnection().query({
      sql: built.sql,
      values: built.params,
      rowsAsArray: true,
    });
    void fields;
    const durationMs = Date.now() - start;
    const totalCount = await this.countRows(req.schema, req.table, req.filters ?? [], req.where);
    const rows = (result as unknown as unknown[][]).map(normalizeRow);
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
      const [result] = await this.getConnection().query({
        sql: built.sql,
        values: built.params,
        rowsAsArray: true,
      });
      const row = (result as unknown as unknown[][])[0];
      const raw = row?.[0];
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
    const connection = this.getConnection();
    let affected = 0;
    await connection.beginTransaction();
    try {
      for (const statement of statements) {
        const [result] = await connection.query({ sql: statement.sql, values: statement.params });
        const header = result as ResultSetHeader;
        affected += header.affectedRows ?? 0;
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    }
    return affected;
  }
}
