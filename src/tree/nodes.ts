import * as vscode from 'vscode';
import type { ColumnMeta, ConnectionConfig, DbKind, IndexMeta, TableMeta } from '../types.js';

export type GroupKind = 'tables' | 'views' | 'columns' | 'indexes';

export class ConnectionNode extends vscode.TreeItem {
  readonly kind = 'connection' as const;

  constructor(
    public readonly config: ConnectionConfig,
    connected: boolean,
    extensionUri: vscode.Uri,
  ) {
    super(config.name, connected ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = connected ? 'connection.connected' : 'connection.disconnected';
    // DB の種類ごとに専用アイコンを出す。未接続はグレー版に差し替える。
    this.iconPath = ConnectionNode.iconFor(config.kind, connected, extensionUri);
    this.description = `${config.kind}${connected ? '' : ' (未接続)'}`;
    this.tooltip = `${config.name} (${config.kind})`;
  }

  private static iconFor(kind: DbKind, connected: boolean, extensionUri: vscode.Uri): vscode.Uri {
    const file = `${kind}${connected ? '' : '-off'}.svg`;
    return vscode.Uri.joinPath(extensionUri, 'media', 'icons', file);
  }
}

export class SchemaNode extends vscode.TreeItem {
  readonly kind = 'schema' as const;

  constructor(
    public readonly connectionId: string,
    public readonly schema: string,
  ) {
    super(schema, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'schema';
    this.iconPath = new vscode.ThemeIcon('symbol-namespace');
  }
}

export class GroupNode extends vscode.TreeItem {
  readonly kind = 'group' as const;

  constructor(
    public readonly connectionId: string,
    public readonly schema: string,
    public readonly groupKind: GroupKind,
    public readonly table?: string,
  ) {
    super(GroupNode.labelFor(groupKind), vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = 'group';
    this.iconPath = new vscode.ThemeIcon(GroupNode.iconFor(groupKind));
  }

  private static labelFor(groupKind: GroupKind): string {
    switch (groupKind) {
      case 'tables':
        return 'テーブル';
      case 'views':
        return 'ビュー';
      case 'columns':
        return 'カラム';
      case 'indexes':
        return 'インデックス';
    }
  }

  private static iconFor(groupKind: GroupKind): string {
    switch (groupKind) {
      case 'tables':
        return 'table';
      case 'views':
        return 'eye';
      case 'columns':
        return 'symbol-field';
      case 'indexes':
        return 'list-tree';
    }
  }
}

export class TableNode extends vscode.TreeItem {
  readonly kind = 'table' as const;

  constructor(
    public readonly connectionId: string,
    public readonly connectionName: string,
    public readonly table: TableMeta,
  ) {
    super(table.name, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = table.type === 'view' ? 'view' : 'table';
    this.iconPath = new vscode.ThemeIcon(table.type === 'view' ? 'eye' : 'table');
    this.command = {
      command: 'dbRover.openTable',
      title: 'テーブルを開く',
      arguments: [this],
    };
  }
}

export class ColumnNode extends vscode.TreeItem {
  readonly kind = 'column' as const;

  constructor(public readonly column: ColumnMeta) {
    super(column.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'column';
    this.description = `${column.dataType} / ${column.nullable ? 'NULL 可' : 'NOT NULL'}${column.isPrimaryKey ? ' / PK' : ''}`;
    this.iconPath = new vscode.ThemeIcon(column.isPrimaryKey ? 'key' : 'symbol-field');
  }
}

export class IndexNode extends vscode.TreeItem {
  readonly kind = 'index' as const;

  constructor(public readonly index: IndexMeta) {
    super(index.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = 'index';
    this.description = `${index.columns.join(', ')}${index.unique ? ' / UNIQUE' : ''}${index.primary ? ' / PK' : ''}`;
    this.iconPath = new vscode.ThemeIcon('list-tree');
  }
}

export type DbRoverNode = ConnectionNode | SchemaNode | GroupNode | TableNode | ColumnNode | IndexNode;
