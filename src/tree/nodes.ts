import * as vscode from 'vscode';
import type { ColumnMeta, ConnectionConfig, DbKind, IndexMeta, TableMeta } from '../types.js';

export type GroupKind = 'tables' | 'views' | 'columns' | 'indexes';

export class ConnectionNode extends vscode.TreeItem {
  readonly kind = 'connection' as const;

  constructor(
    public readonly config: ConnectionConfig,
    connected: boolean,
    extensionUri: vscode.Uri,
    public readonly filter?: string,
  ) {
    super(config.name, connected ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    // 接続状態を id に混ぜて、切断したら「別の要素」として扱わせる。
    // 同じ id のままだと VS Code は開いた状態を覚えていて、切断直後の再描画で
    // 子の取得（= 遅延接続）が走り、切ったそばから接続し直してしまう。
    this.id = `connection:${config.id}:${connected ? 'on' : 'off'}`;
    // 絞り込み中は contextValue の末尾に .filtered を足し、解除アイコンだけを出し分ける。
    // menus 側は viewItem =~ /^connection\./ で受けているので、接尾辞を足しても他の項目は消えない。
    const base = connected ? 'connection.connected' : 'connection.disconnected';
    this.contextValue = filter ? `${base}.filtered` : base;
    // DB の種類ごとに専用アイコンを出す。未接続はグレー版に差し替える。
    // 接続状態はこのアイコンと、右に出る接続/切断アイコンで分かるので、説明には書かない。
    this.iconPath = ConnectionNode.iconFor(config.kind, connected, extensionUri);
    this.description = filter ? `${config.kind} — 絞り込み: ${filter}` : config.kind;
    this.tooltip = `${config.name} (${config.kind}) — ${connected ? '接続中' : '未接続'}${
      filter ? `\nテーブル／ビューを「${filter}」で絞り込み中` : ''
    }`;
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
    expandKey = 0,
  ) {
    // 絞り込みを始めたら開いた状態で出す。クリックして辿らないと結果が見えないのでは絞り込む意味がない。
    super(schema, expandKey > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    // expandKey を id に混ぜて「別の要素」として扱わせる。同じ id のままだと VS Code は
    // ユーザーが閉じた状態を覚えていて、上の Expanded を無視する。
    // 逆に絞り込みの文字列そのものは混ぜない。1 文字打つたびに別要素になって畳み直されるし、
    // 解除したときにも畳まれてしまう（一度広げたツリーが勝手に閉じると探し直しになる）。
    this.id = `schema:${connectionId}:${schema}:${expandKey}`;
    this.contextValue = 'schema';
    // symbol-namespace（{}）はコードの名前空間に見えるので、DB らしい database を使う。
    this.iconPath = new vscode.ThemeIcon('database');
  }
}

export class GroupNode extends vscode.TreeItem {
  readonly kind = 'group' as const;

  constructor(
    public readonly connectionId: string,
    public readonly schema: string,
    public readonly groupKind: GroupKind,
    public readonly table?: string,
    expandKey = 0,
  ) {
    // 絞り込みを始めたら開いた状態で出す。閉じたままだと、絞り込んだ結果が見えない。
    const expand = expandKey > 0 && (groupKind === 'tables' || groupKind === 'views');
    super(
      GroupNode.labelFor(groupKind),
      expand ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed,
    );
    // SchemaNode と同じ理由で expandKey を id に混ぜ、閉じた状態の記憶を捨てさせる。
    this.id = `group:${connectionId}:${schema}:${groupKind}:${table ?? ''}:${expand ? expandKey : 0}`;
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
