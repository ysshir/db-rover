import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { createDriver } from '../drivers/index.js';
import type {
  ConnectionConfig,
  ConnectionDraft,
  ConnectionEditorToExtensionMessage,
  ExtensionToConnectionEditorMessage,
} from '../types.js';
import { addConnection, deletePassword, getPassword, setPassword, updateConnection } from './store.js';

/** 接続情報を入力・編集するシングルトンの Webview パネル。 */
export class ConnectionEditorPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private target: ConnectionConfig | undefined; // 編集時のみ。未設定なら新規追加
  private hasStoredPassword = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly secrets: vscode.SecretStorage,
    private readonly outputChannel: vscode.OutputChannel,
    private readonly onSaved: (config: ConnectionConfig) => void,
  ) {}

  /** existing を渡すと編集、省略すると新規追加のフォームを開く。 */
  async open(existing?: ConnectionConfig): Promise<void> {
    this.target = existing;
    this.hasStoredPassword = existing
      ? existing.kind !== 'sqlite' && (await getPassword(this.secrets, existing.id)) !== undefined
      : false;

    const title = existing ? `DB Rover: 接続を編集 (${existing.name})` : 'DB Rover: 接続を追加';
    if (this.panel) {
      this.panel.title = title;
      this.panel.reveal(vscode.ViewColumn.Active, false);
      this.sendInit();
      return;
    }

    const panel = vscode.window.createWebviewPanel('dbRover.connectionEditor', title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    });
    this.panel = panel;
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.target = undefined;
    });
    panel.webview.onDidReceiveMessage((message: ConnectionEditorToExtensionMessage) => {
      void this.handleMessage(message);
    });
    panel.webview.html = this.getHtml(panel.webview);
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  private async handleMessage(message: ConnectionEditorToExtensionMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          this.sendInit();
          break;
        case 'browseFile':
          await this.browseSqliteFile();
          break;
        case 'test':
          await this.testConnection(message.connection, message.password, message.useStoredPassword);
          break;
        case 'save':
          await this.save(message.connection, message.password, message.clearPassword);
          break;
        case 'cancel':
          this.panel?.dispose();
          break;
        default: {
          const exhaustiveCheck: never = message;
          this.outputChannel.appendLine(`DB Rover: 未知のメッセージを無視しました: ${JSON.stringify(exhaustiveCheck)}`);
        }
      }
    } catch (error) {
      this.post({ type: 'busy', busy: false });
      this.post({ type: 'status', level: 'error', message: errorMessage(error) });
      this.outputChannel.appendLine(errorStack(error));
    }
  }

  private sendInit(): void {
    const connection: ConnectionDraft = this.target
      ? { ...this.target }
      : { name: '', kind: 'postgres', host: 'localhost', port: 5432, ssl: false };
    this.post({
      type: 'init',
      payload: {
        mode: this.target ? 'edit' : 'create',
        connection,
        hasStoredPassword: this.hasStoredPassword,
      },
    });
  }

  private async browseSqliteFile(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: 'SQLite ファイルを選択',
      filters: { SQLite: ['db', 'sqlite', 'sqlite3'], 'すべてのファイル': ['*'] },
    });
    if (!uris || uris.length === 0) {
      return;
    }
    this.post({ type: 'file', path: uris[0].fsPath });
  }

  private async testConnection(
    draft: ConnectionDraft,
    password: string | undefined,
    useStoredPassword: boolean,
  ): Promise<void> {
    const config = this.validate(draft);
    let effectivePassword = password;
    if (config.kind !== 'sqlite' && useStoredPassword && this.target) {
      effectivePassword = await getPassword(this.secrets, this.target.id);
    }

    this.post({ type: 'busy', busy: true });
    // 検証用に一時的な id を割り当てる（このドライバは保持せず、必ず破棄する）。
    const driver = createDriver({ ...config, id: this.target?.id ?? 'dbRover.connectionEditor.test' }, effectivePassword);
    const startedAt = Date.now();
    try {
      await driver.connect();
      await driver.listSchemas();
      this.post({ type: 'status', level: 'info', message: `接続に成功しました（${Date.now() - startedAt} ms）。` });
    } catch (error) {
      this.outputChannel.appendLine(`接続テストに失敗しました (${config.name || '無題'}): ${errorStack(error)}`);
      this.post({ type: 'status', level: 'error', message: `接続に失敗しました: ${errorMessage(error)}` });
    } finally {
      await driver.dispose().catch(() => undefined);
      this.post({ type: 'busy', busy: false });
    }
  }

  private async save(draft: ConnectionDraft, password: string | undefined, clearPassword: boolean): Promise<void> {
    const config = this.validate(draft);
    this.post({ type: 'busy', busy: true });
    try {
      const saved = this.target ? await updateConnection(this.target.id, config) : await addConnection(config);

      if (config.kind === 'sqlite' || clearPassword) {
        await deletePassword(this.secrets, saved.id);
      } else if (password) {
        await setPassword(this.secrets, saved.id, password);
      }

      this.onSaved(saved);
      void vscode.window.showInformationMessage(
        this.target ? `DB Rover: 接続「${saved.name}」を更新しました。` : `DB Rover: 接続「${saved.name}」を追加しました。`,
      );
      this.panel?.dispose();
    } finally {
      this.post({ type: 'busy', busy: false });
    }
  }

  /** フォーム値を検証し、保存用の接続定義（不要なキーを落としたもの）に正規化する。 */
  private validate(draft: ConnectionDraft): Omit<ConnectionConfig, 'id'> {
    const name = draft.name?.trim() ?? '';
    if (!name) {
      throw new Error('表示名を入力してください。');
    }
    if (draft.kind === 'sqlite') {
      const file = draft.file?.trim() ?? '';
      if (!file) {
        throw new Error('SQLite のデータベースファイルを指定してください。');
      }
      return { name, kind: 'sqlite', file };
    }

    const host = draft.host?.trim() ?? '';
    if (!host) {
      throw new Error('ホスト名を入力してください。');
    }
    if (draft.port !== undefined && (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65535)) {
      throw new Error('ポート番号は 1〜65535 の整数で入力してください。');
    }

    return {
      name,
      kind: draft.kind,
      host,
      port: draft.port,
      database: draft.database?.trim() || undefined,
      user: draft.user?.trim() || undefined,
      ssl: draft.ssl === true,
    };
  }

  private post(message: ExtensionToConnectionEditorMessage): void {
    void this.panel?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const gridCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'grid.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'connection-editor.js'));
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
  <title>DB Rover: 接続</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorStack(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}
