export type DbKind = 'postgres' | 'mysql' | 'sqlite';

export interface ConnectionConfig {
  id: string; // 一意。設定に無ければ name から生成
  name: string;
  kind: DbKind;
  // postgres / mysql
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  ssl?: boolean;
  // sqlite
  file?: string; // ワークスペース相対 or 絶対パス。~ 展開もサポート
}

export interface ColumnMeta {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue?: string | null;
  isPrimaryKey: boolean;
}

export interface IndexMeta {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface TableMeta {
  schema?: string;
  name: string;
  type: 'table' | 'view';
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][]; // 必ず配列の配列に正規化する（オブジェクトのままにしない）
  rowCount: number; // 返した行数
  truncated: boolean; // 行数制限で打ち切ったか
  durationMs: number;
  command?: string; // INSERT/UPDATE 等で影響行数のみのとき用のメッセージ
}

// --- テーブルビュー（閲覧・編集）関連 ---

export interface SortSpec {
  column: string;
  direction: 'asc' | 'desc';
}

export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'startsWith'
  | 'endsWith'
  | 'isNull'
  | 'isNotNull';

export interface FilterSpec {
  column: string;
  operator: FilterOperator;
  value?: string;
}

export interface BrowseRequest {
  schema: string;
  table: string;
  sort: SortSpec[];
  filters?: FilterSpec[]; // 現在の UI からは送っていない（WHERE 式に一本化）
  where?: string; // ユーザーが手書きする WHERE 式。列フィルタとは AND で結合する
  offset: number;
  limit: number;
}

export interface BrowseResult {
  columns: ColumnMeta[]; // 型情報つきで返す（グリッドの右寄せ/編集可否判定に使う）
  rows: unknown[][];
  offset: number;
  totalCount: number | null; // COUNT が無効/失敗のときは null
  durationMs: number;
}

export type RowMutation =
  | { type: 'update'; key: Record<string, unknown>; changes: Record<string, unknown> }
  | { type: 'insert'; values: Record<string, unknown> }
  | { type: 'delete'; key: Record<string, unknown> };

export interface PreparedStatement {
  sql: string;
  params: unknown[];
}

export interface GridLayoutState {
  columnWidths: Record<string, number>;
  pinnedCount: number;
  hiddenColumns: string[];
}

// --- webview <-> extension メッセージ ---

/** グリッドのキー割り当て上書き。アクション名 -> "ctrl+n" / ["ctrl+n", "arrowdown"]。 */
export type GridKeymapOverrides = Record<string, string | string[] | null>;

export interface TableViewInitPayload {
  schema: string;
  table: string;
  connectionName: string;
  dbKind: DbKind; // WHERE 入力の列名サジェストで識別子の引用符を選ぶのに使う
  columns: ColumnMeta[];
  editable: boolean;
  editableReason?: string;
  savedLayout?: GridLayoutState;
  pageSize: number;
  keymap: GridKeymapOverrides;
}

export type TableViewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'browse'; sort: SortSpec[]; where?: string; offset: number; limit: number }
  | { type: 'saveLayout'; layout: GridLayoutState }
  | { type: 'applyEdits'; mutations: RowMutation[] }
  | { type: 'copyValue'; value: string };

export type ExtensionToTableViewMessage =
  | { type: 'init'; payload: TableViewInitPayload }
  | { type: 'data'; result: BrowseResult }
  | { type: 'error'; message: string }
  | { type: 'applied'; affectedRows: number }
  // VS Code 側のキーバインド（既定は Cmd/Ctrl+S）から保存を促す
  | { type: 'requestSave' };

/** 1 文ぶんの実行結果。`;` 区切りで複数文を流したとき、まとめて結果パネルへ渡す。 */
export interface StatementOutcome {
  index: number; // 0 始まり。実行順
  sql: string;
  status: 'ok' | 'error' | 'skipped'; // skipped はエラー中断・キャンセルで実行されなかった文
  result?: QueryResult; // status === 'ok' のとき
  message?: string; // status === 'error' のときのメッセージ
  startOffset: number; // 元ドキュメント内での開始オフセット（失敗した文を呼び出し側で反転表示するのに使う）
}

export type QueryPanelToExtensionMessage =
  | { type: 'ready' }
  | { type: 'copyValue'; value: string }
  | { type: 'exportCsv'; mode: 'copy' | 'save'; index: number };

export type ExtensionToQueryPanelMessage =
  | { type: 'config'; keymap: GridKeymapOverrides }
  | { type: 'results'; connectionName: string; outcomes: StatementOutcome[] }
  | { type: 'error'; message: string };

// --- 接続エディタ（入力・編集モーダル） ---

/** 接続エディタのフォーム値。保存前は id を持たないことがある。 */
export interface ConnectionDraft {
  id?: string;
  name: string;
  kind: DbKind;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  ssl?: boolean;
  file?: string;
}

export interface ConnectionEditorInitPayload {
  mode: 'create' | 'edit';
  connection: ConnectionDraft;
  hasStoredPassword: boolean; // 既存接続に SecretStorage のパスワードが保存されているか
}

export type ConnectionEditorToExtensionMessage =
  | { type: 'ready' }
  | { type: 'save'; connection: ConnectionDraft; password?: string; clearPassword: boolean }
  | { type: 'test'; connection: ConnectionDraft; password?: string; useStoredPassword: boolean }
  | { type: 'browseFile' }
  | { type: 'cancel' };

export type ExtensionToConnectionEditorMessage =
  | { type: 'init'; payload: ConnectionEditorInitPayload }
  | { type: 'file'; path: string }
  | { type: 'busy'; busy: boolean }
  | { type: 'status'; level: 'info' | 'error'; message: string };
