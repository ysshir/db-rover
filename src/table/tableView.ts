import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { ConnectionManager } from '../connections/manager.js';
import { getConnectionById } from '../connections/store.js';
import { getGridLayout, saveGridLayout } from './state.js';
import type {
  BrowseRequest,
  ExtensionToTableViewMessage,
  GridKeymapOverrides,
  RowMutation,
  TableViewInitPayload,
  TableViewToExtensionMessage,
} from '../types.js';

export interface OpenTableArgs {
  connectionId: string;
  connectionName: string;
  schema: string;
  table: string;
  tableType: 'table' | 'view';
}

/** テーブルビュー（閲覧・編集）の WebviewPanel 管理とメッセージハンドリング。 */
export class TableViewManager implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  /** Cmd/Ctrl+S の送り先。表示中のテーブルビューを追いかける。 */
  private activePanel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: ConnectionManager,
    private readonly workspaceState: vscode.Memento,
    private readonly outputChannel: vscode.OutputChannel,
  ) {}

  open(args: OpenTableArgs): void {
    const key = `${args.connectionId}:${args.schema}.${args.table}`;
    const existing = this.panels.get(key);
    if (existing) {
      existing.reveal(vscode.ViewColumn.Active);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'dbRover.tableView',
      `${args.table} (${args.connectionName})`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
      },
    );
    this.panels.set(key, panel);
    this.activePanel = panel;
    panel.onDidDispose(() => {
      this.panels.delete(key);
      if (this.activePanel === panel) {
        this.activePanel = undefined;
      }
    });
    panel.onDidChangeViewState(() => {
      if (panel.active) {
        this.activePanel = panel;
      }
    });
    panel.webview.html = this.getHtml(panel.webview);
    panel.webview.onDidReceiveMessage((message: TableViewToExtensionMessage) => {
      void this.handleMessage(panel, args, message);
    });
  }

  /** 表示中のテーブルビューに保存を促す。実際の確認と実行は webview 側から applyEdits で戻ってくる。 */
  requestSaveOnActivePanel(): void {
    this.activePanel?.webview.postMessage({ type: 'requestSave' } satisfies ExtensionToTableViewMessage);
  }

  dispose(): void {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
    this.activePanel = undefined;
  }

  private async handleMessage(
    panel: vscode.WebviewPanel,
    args: OpenTableArgs,
    message: TableViewToExtensionMessage,
  ): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          await this.sendInit(panel, args);
          break;
        case 'browse': {
          const request: BrowseRequest = {
            schema: args.schema,
            table: args.table,
            sort: message.sort,
            where: message.where,
            offset: message.offset,
            limit: message.limit,
          };
          await this.sendData(panel, args, request);
          break;
        }
        case 'saveLayout':
          await saveGridLayout(this.workspaceState, args.connectionId, args.schema, args.table, message.layout);
          break;
        case 'applyEdits':
          await this.applyEdits(panel, args, message.mutations);
          break;
        case 'copyValue':
          await vscode.env.clipboard.writeText(message.value);
          break;
        default: {
          const exhaustiveCheck: never = message;
          this.outputChannel.appendLine(`DB Rover: 未知のメッセージを無視しました: ${JSON.stringify(exhaustiveCheck)}`);
        }
      }
    } catch (error) {
      this.reportError(panel, error);
    }
  }

  private async sendInit(panel: vscode.WebviewPanel, args: OpenTableArgs): Promise<void> {
    const config = this.requireConfig(args.connectionId);
    const driver = await this.manager.ensureConnected(config);
    const columns = await driver.listColumns(args.schema, args.table);
    const editable = args.tableType === 'table' && columns.some((column) => column.isPrimaryKey);
    const settings = vscode.workspace.getConfiguration('dbRover');
    const pageSize = settings.get<number>('pageSize', 200);
    const keymap = settings.get<GridKeymapOverrides>('keybindings', {});
    const savedLayout = getGridLayout(this.workspaceState, args.connectionId, args.schema, args.table);

    const payload: TableViewInitPayload = {
      schema: args.schema,
      table: args.table,
      connectionName: args.connectionName,
      dbKind: config.kind,
      columns,
      editable,
      editableReason: editable ? undefined : '主キーが無いため編集できません',
      savedLayout,
      pageSize,
      keymap,
    };
    this.post(panel, { type: 'init', payload });
  }

  private async sendData(panel: vscode.WebviewPanel, args: OpenTableArgs, request: BrowseRequest): Promise<void> {
    const config = this.requireConfig(args.connectionId);
    const driver = await this.manager.ensureConnected(config);
    const result = await driver.browse(request);
    this.post(panel, { type: 'data', result });
  }

  private async applyEdits(panel: vscode.WebviewPanel, args: OpenTableArgs, mutations: RowMutation[]): Promise<void> {
    const config = this.requireConfig(args.connectionId);
    const driver = await this.manager.ensureConnected(config);
    const columns = await driver.listColumns(args.schema, args.table);
    const statements = driver.buildMutations(args.schema, args.table, mutations, columns);
    const affected = await driver.applyMutations(statements);
    this.post(panel, { type: 'applied', affectedRows: affected });
  }

  private requireConfig(connectionId: string) {
    const config = getConnectionById(connectionId);
    if (!config) {
      throw new Error('接続設定が見つかりません。設定が削除された可能性があります。');
    }
    return config;
  }

  private post(panel: vscode.WebviewPanel, message: ExtensionToTableViewMessage): void {
    void panel.webview.postMessage(message);
  }

  private reportError(panel: vscode.WebviewPanel, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? (error.stack ?? error.message) : String(error);
    this.outputChannel.appendLine(stack);
    this.post(panel, { type: 'error', message });
    void vscode.window.showErrorMessage(`DB Rover: ${message}`);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const gridCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'grid.css'));
    const gridJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'grid.js'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'table-view.js'));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <link rel="stylesheet" href="${gridCssUri}" />
  <title>DB Rover: テーブル</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${gridJsUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
