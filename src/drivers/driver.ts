import type {
  BrowseRequest,
  BrowseResult,
  ColumnMeta,
  DbKind,
  FilterSpec,
  IndexMeta,
  PreparedStatement,
  QueryResult,
  RowMutation,
  TableMeta,
} from '../types.js';

/**
 * 接続が非同期に切れたことを知らせるリスナ登録関数（`vscode.Event` と同じ形）。
 * driver.ts を vscode 非依存に保つため、必要な形だけをここで宣言する。
 */
export type ConnectionLostEvent = (listener: (error: unknown) => void) => { dispose(): void };

export interface DbDriver {
  readonly kind: DbKind;
  /**
   * クエリの外側（待機中のソケットなど）で接続が切れたときに発火する。
   * 発火した時点でドライバは使用不能で、次の操作の前に張り直す必要がある。
   */
  readonly onConnectionLost: ConnectionLostEvent;
  connect(): Promise<void>;
  dispose(): Promise<void>;
  listSchemas(): Promise<string[]>; // sqlite は ['main'] 固定
  listTables(schema: string): Promise<TableMeta[]>;
  listColumns(schema: string, table: string): Promise<ColumnMeta[]>;
  listIndexes(schema: string, table: string): Promise<IndexMeta[]>;
  query(sql: string, limit: number): Promise<QueryResult>;
  quoteIdent(name: string): string; // pg/sqlite は "..."、mysql は `...`


  // テーブルビュー（閲覧・編集）用
  browse(req: BrowseRequest): Promise<BrowseResult>;
  countRows(schema: string, table: string, filters: FilterSpec[], where?: string): Promise<number | null>;
  buildMutations(
    schema: string,
    table: string,
    muts: RowMutation[],
    columns: ColumnMeta[],
  ): PreparedStatement[];
  applyMutations(statements: PreparedStatement[]): Promise<number>; // トランザクション内で実行し、影響行数の合計を返す
}
