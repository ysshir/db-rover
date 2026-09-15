import * as vscode from 'vscode';
import type { ConnectionManager } from '../connections/manager.js';
import { getConnections } from '../connections/store.js';
import { ColumnNode, ConnectionNode, GroupNode, IndexNode, SchemaNode, TableNode } from './nodes.js';
import type { DbRoverNode } from './nodes.js';

export class DbRoverTreeProvider implements vscode.TreeDataProvider<DbRoverNode>, vscode.Disposable {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<DbRoverNode | undefined | void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
  private readonly connectionsListener: vscode.Disposable;

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
          (config) => new ConnectionNode(config, this.manager.isConnected(config.id), this.extensionUri),
        );
      }

      switch (element.kind) {
        case 'connection': {
          const driver = await this.manager.ensureConnected(element.config);
          if (element.config.kind === 'sqlite') {
            return [
              new GroupNode(element.config.id, 'main', 'tables'),
              new GroupNode(element.config.id, 'main', 'views'),
            ];
          }
          const schemas = await driver.listSchemas();
          return schemas.map((schema) => new SchemaNode(element.config.id, schema));
        }
        case 'schema':
          return [
            new GroupNode(element.connectionId, element.schema, 'tables'),
            new GroupNode(element.connectionId, element.schema, 'views'),
          ];
        case 'group': {
          const driver = this.manager.getDriver(element.connectionId);
          if (!driver) {
            return [];
          }
          if (element.groupKind === 'tables' || element.groupKind === 'views') {
            const tables = await driver.listTables(element.schema);
            const wanted = element.groupKind === 'tables' ? 'table' : 'view';
            const connectionName = getConnections().find((c) => c.id === element.connectionId)?.name ?? '';
            return tables
              .filter((table) => table.type === wanted)
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
