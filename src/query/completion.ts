import * as vscode from 'vscode';
import type { ConnectionManager } from '../connections/manager.js';
import { getConnectionById } from '../connections/store.js';
import type { DbDriver } from '../drivers/driver.js';
import type { ColumnMeta, ConnectionConfig, TableMeta } from '../types.js';
import type { QueryBindingStore } from './binding.js';

const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY', 'LIMIT', 'OFFSET',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'JOIN', 'LEFT JOIN',
  'RIGHT JOIN', 'INNER JOIN', 'FULL JOIN', 'CROSS JOIN', 'ON', 'AS', 'AND', 'OR',
  'NOT', 'IN', 'EXISTS', 'BETWEEN', 'LIKE', 'IS NULL', 'IS NOT NULL', 'DISTINCT',
  'COUNT(', 'SUM(', 'AVG(', 'MIN(', 'MAX(', 'COALESCE(', 'CASE', 'WHEN', 'THEN',
  'ELSE', 'END', 'UNION', 'UNION ALL', 'WITH', 'CREATE TABLE', 'ALTER TABLE',
  'DROP TABLE', 'CREATE INDEX', 'TRUNCATE', 'BEGIN', 'COMMIT', 'ROLLBACK',
  'ASC', 'DESC', 'NULL', 'TRUE', 'FALSE',
];

/** FROM / JOIN の直後をテーブル名、その次の語をエイリアスとして拾う。 */
const TABLE_REF = /\b(?:from|join|update|into)\s+([`"[\]\w$.]+)(?:\s+(?:as\s+)?([a-z_][\w$]*))?/gi;

/** エイリアスと誤認しやすい予約語。FROM t WHERE ... の WHERE を別名扱いしないため。 */
const NOT_AN_ALIAS = new Set([
  'where', 'join', 'inner', 'left', 'right', 'full', 'cross', 'outer', 'on',
  'group', 'order', 'having', 'limit', 'offset', 'union', 'set', 'values',
  'select', 'using', 'and', 'or', 'as', 'natural', 'straight_join',
]);

interface TableRef {
  schema: string;
  table: string;
}

/** 接続ごとに引いたメタデータの入れ物。接続が変わったら丸ごと捨てる。 */
interface ConnectionMetadata {
  schemas?: string[];
  tables: Map<string, TableMeta[]>; // schema -> テーブル/ビュー
  columns: Map<string, ColumnMeta[]>; // "schema.table" -> 列
}

export class SqlCompletionProvider implements vscode.CompletionItemProvider, vscode.Disposable {
  private readonly cache = new Map<string, ConnectionMetadata>();
  private readonly listener: vscode.Disposable;

  constructor(
    private readonly manager: ConnectionManager,
    private readonly bindings: QueryBindingStore,
  ) {
    // 接続・切断・設定変更でメタデータが古くなるため、そのつど捨てて引き直す。
    this.listener = manager.onDidChangeConnections(() => this.cache.clear());
  }

  dispose(): void {
    this.listener.dispose();
  }

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<vscode.CompletionItem[]> {
    // 実行先と補完先がずれると混乱するので、実行と同じくドキュメントの束縛を優先する。
    const connectionId = this.bindings.get(document) ?? this.manager.activeConnectionId;
    const driver = connectionId ? this.manager.getDriver(connectionId) : undefined;
    const config = connectionId ? getConnectionById(connectionId) : undefined;
    // 未接続のときに接続しに行くとタイプ中にパスワード入力が出るので、キーワードだけ返す。
    if (!connectionId || !driver || !config) {
      return keywordItems();
    }

    try {
      const meta = this.metadataFor(connectionId);
      const schemas = await this.schemas(driver, meta);
      const defaultSchema = pickDefaultSchema(config, schemas);
      const refs = parseTableRefs(document.getText(), defaultSchema);
      const qualifier = matchQualifier(document.getText(new vscode.Range(position.with(undefined, 0), position)));

      if (qualifier) {
        return await this.qualifiedItems(driver, meta, qualifier, refs, schemas, defaultSchema);
      }
      return await this.unqualifiedItems(driver, meta, refs, schemas, defaultSchema);
    } catch {
      // 補完はタイプのたびに走るので、失敗してもエラーは出さずキーワードだけに落とす。
      return keywordItems();
    }
  }

  /** `alias.` / `table.` / `schema.` の直後。 */
  private async qualifiedItems(
    driver: DbDriver,
    meta: ConnectionMetadata,
    qualifier: string,
    refs: Map<string, TableRef>,
    schemas: string[],
    defaultSchema: string,
  ): Promise<vscode.CompletionItem[]> {
    const key = qualifier.toLowerCase();

    const ref = refs.get(key);
    if (ref) {
      return (await this.columns(driver, meta, ref)).map((column) => columnItem(column, ref.table));
    }

    const schema = schemas.find((s) => s.toLowerCase() === key);
    if (schema) {
      return (await this.tables(driver, meta, schema)).map(tableItem);
    }

    // FROM に書く前でも `テーブル名.` で列を出せるようにする。
    const table = (await this.tables(driver, meta, defaultSchema)).find((t) => t.name.toLowerCase() === key);
    if (table) {
      const target = { schema: defaultSchema, table: table.name };
      return (await this.columns(driver, meta, target)).map((column) => columnItem(column, table.name));
    }
    return [];
  }

  private async unqualifiedItems(
    driver: DbDriver,
    meta: ConnectionMetadata,
    refs: Map<string, TableRef>,
    schemas: string[],
    defaultSchema: string,
  ): Promise<vscode.CompletionItem[]> {
    const items: vscode.CompletionItem[] = [];

    // 文中で参照しているテーブルの列を最優先で出す。
    const seen = new Set<string>();
    for (const ref of refs.values()) {
      const key = `${ref.schema}.${ref.table}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const column of await this.columns(driver, meta, ref)) {
        items.push(columnItem(column, ref.table, '0'));
      }
    }

    for (const table of await this.tables(driver, meta, defaultSchema)) {
      items.push(tableItem(table));
    }
    for (const schema of schemas) {
      if (schema === defaultSchema) continue;
      const item = new vscode.CompletionItem(schema, vscode.CompletionItemKind.Module);
      item.detail = 'スキーマ';
      item.sortText = '3';
      items.push(item);
    }
    items.push(...keywordItems());
    return items;
  }

  private metadataFor(connectionId: string): ConnectionMetadata {
    let meta = this.cache.get(connectionId);
    if (!meta) {
      meta = { tables: new Map(), columns: new Map() };
      this.cache.set(connectionId, meta);
    }
    return meta;
  }

  private async schemas(driver: DbDriver, meta: ConnectionMetadata): Promise<string[]> {
    meta.schemas ??= await driver.listSchemas();
    return meta.schemas;
  }

  private async tables(driver: DbDriver, meta: ConnectionMetadata, schema: string): Promise<TableMeta[]> {
    let tables = meta.tables.get(schema);
    if (!tables) {
      tables = await driver.listTables(schema);
      meta.tables.set(schema, tables);
    }
    return tables;
  }

  private async columns(driver: DbDriver, meta: ConnectionMetadata, ref: TableRef): Promise<ColumnMeta[]> {
    const key = `${ref.schema}.${ref.table}`;
    let columns = meta.columns.get(key);
    if (!columns) {
      columns = await driver.listColumns(ref.schema, ref.table);
      meta.columns.set(key, columns);
    }
    return columns;
  }
}

function keywordItems(): vscode.CompletionItem[] {
  return KEYWORDS.map((keyword) => {
    const item = new vscode.CompletionItem(keyword, vscode.CompletionItemKind.Keyword);
    item.sortText = `9${keyword}`;
    return item;
  });
}

function tableItem(table: TableMeta): vscode.CompletionItem {
  const item = new vscode.CompletionItem(
    table.name,
    table.type === 'view' ? vscode.CompletionItemKind.Interface : vscode.CompletionItemKind.Struct,
  );
  item.detail = table.type === 'view' ? 'ビュー' : 'テーブル';
  item.sortText = `1${table.name}`;
  return item;
}

function columnItem(column: ColumnMeta, table: string, sortPrefix = '2'): vscode.CompletionItem {
  const item = new vscode.CompletionItem(column.name, vscode.CompletionItemKind.Field);
  const flags = [column.dataType, column.nullable ? 'NULL 可' : 'NOT NULL'];
  if (column.isPrimaryKey) flags.push('PK');
  item.detail = flags.join(' / ');
  item.documentation = `${table} の列`;
  item.sortText = `${sortPrefix}${column.name}`;
  return item;
}

/** 行頭からカーソルまでを見て、直前が `なにか.` ならその識別子を返す。 */
function matchQualifier(linePrefix: string): string | undefined {
  const match = /(?:^|[^\w$.])([`"\w$]+)\.\s*[\w$]*$/.exec(linePrefix);
  return match ? stripQuotes(match[1]) : undefined;
}

function stripQuotes(name: string): string {
  return name.replace(/^["`[]/, '').replace(/["`\]]$/, '');
}

/** SQL 全文から FROM / JOIN のテーブルとエイリアスを拾い、どちらの名前でも引けるようにする。 */
function parseTableRefs(sql: string, defaultSchema: string): Map<string, TableRef> {
  const refs = new Map<string, TableRef>();
  TABLE_REF.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TABLE_REF.exec(sql)) !== null) {
    const parts = match[1].split('.').map(stripQuotes).filter(Boolean);
    if (parts.length === 0) continue;
    const ref: TableRef =
      parts.length >= 2
        ? { schema: parts[parts.length - 2], table: parts[parts.length - 1] }
        : { schema: defaultSchema, table: parts[0] };
    refs.set(ref.table.toLowerCase(), ref);
    const alias = match[2];
    if (alias && !NOT_AN_ALIAS.has(alias.toLowerCase())) {
      refs.set(alias.toLowerCase(), ref);
    }
  }
  return refs;
}

function pickDefaultSchema(config: ConnectionConfig, schemas: string[]): string {
  if (config.kind === 'sqlite') return 'main';
  if (config.kind === 'mysql') return config.database ?? schemas[0] ?? '';
  return schemas.includes('public') ? 'public' : (schemas[0] ?? 'public');
}
