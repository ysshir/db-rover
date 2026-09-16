import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type {
  ExportFormat,
  ExtensionToQueryPanelMessage,
  GridKeymapOverrides,
  QueryPanelToExtensionMessage,
  StatementOutcome,
} from '../types.js';
import { EXPORT_LABELS, normalizeExportFormat, toDelimitedText } from '../util/delimited.js';

/**
 * クエリ結果を表示するビュー。ターミナルや出力と同じ下部パネルに常駐させる。
 *
 * エディタの Webview パネル（右側に開く）ではなく WebviewView にしているのは、
 * 結果を必ず下半分に出したいため。位置やサイズの調整は VS Code 標準の操作に任せられる。
 */
export class QueryResultView implements vscode.WebviewViewProvider, vscode.Disposable {
  /** package.json の contributes.views と合わせること。 */
  static readonly viewId = 'dbRover.queryResult';

  private view: vscode.WebviewView | undefined;
  private lastConnectionName: string | undefined;
  private lastOutcomes: StatementOutcome[] | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.onDidDispose(
      () => {
        if (this.view === view) {
          this.view = undefined;
        }
      },
      null,
      this.disposables,
    );
    view.webview.onDidReceiveMessage(
      (message: QueryPanelToExtensionMessage) => {
        void this.handleMessage(message);
      },
      null,
      this.disposables,
    );
    vscode.workspace.onDidChangeConfiguration(
      (event) => {
        // ボタンの tooltip に形式を出しているので、設定が変わったら送り直す。
        if (event.affectsConfiguration('dbRover.exportFormat') || event.affectsConfiguration('dbRover.keybindings')) {
          this.postConfig();
        }
      },
      null,
      this.disposables,
    );
    if (this.lastConnectionName !== undefined) {
      view.description = this.lastConnectionName;
    }
    view.webview.html = this.getHtml(view.webview);
  }

  /**
   * 結果を表示する。ビューがまだ作られていなければ下部パネルごと開かせる。
   * 実行後もカーソルは SQL エディタに残したいので、フォーカスは奪わない。
   */
  async show(connectionName: string, outcomes: StatementOutcome[]): Promise<void> {
    this.lastConnectionName = connectionName;
    this.lastOutcomes = outcomes;

    if (!this.view) {
      // 未生成のときは focus コマンドでしか開けない。preserveFocus でフォーカスは戻す。
      await vscode.commands.executeCommand(`${QueryResultView.viewId}.focus`, { preserveFocus: true });
    } else if (!this.view.visible) {
      this.view.show(true);
    }

    if (!this.view) {
      return;
    }
    this.view.description = connectionName;
    // 生成直後は webview の ready がまだ来ていないことがある。その場合は ready 側で送り直す。
    this.postMessage({ type: 'results', connectionName, outcomes });
  }

  private postMessage(message: ExtensionToQueryPanelMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private async handleMessage(message: QueryPanelToExtensionMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.postConfig();
        if (this.lastOutcomes && this.lastConnectionName !== undefined) {
          // webview がリロードされた場合に備えて再送する。
          this.postMessage({ type: 'results', connectionName: this.lastConnectionName, outcomes: this.lastOutcomes });
        }
        break;
      case 'copyValue':
        await vscode.env.clipboard.writeText(message.value);
        break;
      case 'export':
        await this.exportResult(message.mode, message.index);
        break;
      default: {
        const exhaustiveCheck: never = message;
        console.warn(`DB Rover: 未知のメッセージを無視しました: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  }

  private postConfig(): void {
    this.postMessage({
      type: 'config',
      keymap: vscode.workspace.getConfiguration('dbRover').get<GridKeymapOverrides>('keybindings', {}),
      exportFormat: this.exportFormat(),
    });
  }

  private exportFormat(): ExportFormat {
    return normalizeExportFormat(vscode.workspace.getConfiguration('dbRover').get('exportFormat'));
  }

  /** 結果をクリップボードへ、またはファイルへ書き出す。形式は設定に従う。 */
  private async exportResult(mode: 'copy' | 'save', index: number): Promise<void> {
    const result = this.lastOutcomes?.[index]?.result;
    if (!result) {
      return;
    }
    // ボタンを押した時点の設定を読む（webview に渡した表示用の形式とずれても実害が無いように）。
    const format = this.exportFormat();
    const label = EXPORT_LABELS[format];
    const text = toDelimitedText(result, format);
    if (mode === 'copy') {
      await vscode.env.clipboard.writeText(text);
      void vscode.window.showInformationMessage(`DB Rover: ${label} としてクリップボードにコピーしました。`);
      return;
    }
    const uri = await vscode.window.showSaveDialog({ filters: { [label]: [format] } });
    if (!uri) {
      return;
    }
    try {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
      void vscode.window.showInformationMessage(`DB Rover: ${label} を保存しました: ${uri.fsPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`DB Rover: ${label} の保存に失敗しました: ${message}`);
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const gridCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'grid.css'));
    const gridJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'grid.js'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'query-result.js'));
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
  <title>DB Rover: クエリ結果</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${gridJsUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
