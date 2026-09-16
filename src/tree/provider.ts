import * as vscode from 'vscode';
import type { ConnectionManager } from '../connections/manager.js';
import { getConnections } from '../connections/store.js';
import { ColumnNode, ConnectionNode, GroupNode, IndexNode, SchemaNode, TableNode } from './nodes.js';
import type { DbRoverNode } from './nodes.js';
import { matchesFilter, normalizeFilter } from './filter.js';

export class DbRoverTreeProvider implements vscode.TreeDataProvider<DbRoverNode>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<DbRoverNode | undefined | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private readonly connectionsListener: vscode.Disposable;
  /** 接続ごとのテーブル／ビュー名の絞り込み。ウィンドウを閉じるまでの一時的な状態なので保存しない。 */
  private readonly filters = new Map<string, string>();
  /**
   * 接続ごとの「ツリーを開いた状態で出す」印。絞り込みを始めるたびに増やす。
   * 解除しても減らさないので、絞り込みをやめても広げたツリーはそのまま残る。
   */
  private readonly expandKeys = new Map<string, number>();

  constructor(
    private readonly manager: ConnectionManager,
    private readonly outputChannel: vscode.OutputChannel,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.connectionsListener = this.manager.onDidChangeConnections(() => this.refresh());
  }

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  /** 接続に設定されている絞り込み文字列。未設定なら undefined。 */
  getFilter(connectionId: string): string | undefined {
    return this.filters.get(connectionId);
  }

  /** 絞り込みを設定する。空文字・空白のみ・undefined は解除として扱う。 */
  setFilter(connectionId: string, filter: string | undefined): void {
    const normalized = normalizeFilter(filter);
    if (normalized) {
      // 絞り込みを「始めた」ときだけ印を新しくして、畳まれたままのツリーを開き直させる。
      // 入力中（すでに絞り込み中）は据え置き。1 文字ごとに開き直すと選択位置ごと飛ぶ。
      if (!this.filters.has(connectionId)) {
        this.expandKeys.set(connectionId, (this.expandKeys.get(connectionId) ?? 0) + 1);
      }
      this.filters.set(connectionId, normalized);
    } else {
      this.filters.delete(connectionId);
    }
    this.refresh();
  }

  dispose(): void {
    this.connectionsListener.dispose();
    this.onDidChangeTreeDataEmitter.dispose();
  }

  getTreeItem(element: DbRoverNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: DbRoverNode): Promise<DbRoverNode[]> {
    try {
      if (!element) {
        return getConnections().map(
          (config) =>
            new ConnectionNode(
              config,
              this.manager.isConnected(config.id),
              this.extensionUri,
              this.filters.get(config.id),
            ),
        );
      }

      switch (element.kind) {
        case 'connection': {
          const driver = await this.manager.ensureConnected(element.config);
          const expandKey = this.expandKeys.get(element.config.id);
          if (element.config.kind === 'sqlite') {
            return [
              new GroupNode(element.config.id, 'main', 'tables', undefined, expandKey),
              new GroupNode(element.config.id, 'main', 'views', undefined, expandKey),
            ];
          }
          const schemas = await driver.listSchemas();
          return schemas.map((schema) => new SchemaNode(element.config.id, schema, expandKey));
        }
        case 'schema': {
          const expandKey = this.expandKeys.get(element.connectionId);
          return [
            new GroupNode(element.connectionId, element.schema, 'tables', undefined, expandKey),
            new GroupNode(element.connectionId, element.schema, 'views', undefined, expandKey),
          ];
        }
        case 'group': {
          const driver = this.manager.getDriver(element.connectionId);
          if (!driver) {
            return [];
          }
          if (element.groupKind === 'tables' || element.groupKind === 'views') {
            const tables = await driver.listTables(element.schema);
            const wanted = element.groupKind === 'tables' ? 'table' : 'view';
            const connectionName = getConnections().find((c) => c.id === element.connectionId)?.name ?? '';
            // 絞り込みはテーブル／ビュー名だけに効かせる。カラムやインデックスまで隠すと、
            // 開いたテーブルの列が虫食いになって何が起きたのか分からなくなる。
            const filter = this.filters.get(element.connectionId);
            return tables
              .filter((table) => table.type === wanted && matchesFilter(table.name, filter))
              .map((table) => new TableNode(element.connectionId, connectionName, { ...table, schema: element.schema }));
          }
          if (!element.table) {
            return [];
          }
          if (element.groupKind === 'columns') {
            const columns = await driver.listColumns(element.schema, element.table);
            return columns.map((column) => new ColumnNode(column));
          }
          const indexes = await driver.listIndexes(element.schema, element.table);
          return indexes.map((index) => new IndexNode(index));
        }
        case 'table':
          return [
            new GroupNode(element.connectionId, element.table.schema ?? 'main', 'columns', element.table.name),
            new GroupNode(element.connectionId, element.table.schema ?? 'main', 'indexes', element.table.name),
          ];
        default:
          return [];
      }
    } catch (error) {
      this.reportError(error);
      return [];
    }
  }

  private reportError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? (error.stack ?? error.message) : String(error);
    this.outputChannel.appendLine(stack);
    void vscode.window.showErrorMessage(`DB Rover: ${message}`);
  }
}
