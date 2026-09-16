import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { ConnectionManager } from '../connections/manager.js';
import { getConnections } from '../connections/store.js';
import type { QueryResultView } from '../query/resultView.js';
import { ApprovalGate } from './approval.js';
import { AuditLog } from './audit.js';
import { McpHttpServer } from './mcpHttp.js';
import type { RpcHandlers } from './mcpRpc.js';
import { registerMcpProvider } from './mcpProvider.js';
import { registerLmTools } from './lmTools.js';
import { AiToolCore } from './toolCore.js';
import { TOOL_DEFS } from './toolDefs.js';

const TOKEN_SECRET_KEY = 'dbRover.ai.token';
const DEFAULT_PORT = 47600;
const URL_COPY_LABEL = 'URL をコピー';
const CONFIG_SECTION = 'dbRover';

/**
 * AI 連携（MCP サーバ + Language Model Tools）のファサード。
 *
 * トークンの取得/生成/回転、MCP サーバの起動/停止、設定変更の追随、ステータスバー、
 * コンテキストキー `dbRover.ai.serverRunning`、コマンド 7 本の登録をここに集約する。
 *
 * コンストラクタは同期処理のみ行い、SecretStorage からのトークン取得やサーバの起動は
 * `activate()`（非同期）で行う。`dispose()` は `Promise<void>` を返すので、
 * `src/extension.ts` の `deactivate()` から await できる。
 */
export class AiIntegration implements vscode.Disposable {
  private readonly mcpHttpServer: McpHttpServer;
  private readonly approvalGate: ApprovalGate;
  private readonly auditLog: AuditLog;
  private readonly toolCore: AiToolCore;
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly onDidChangeAiStateEmitter = new vscode.EventEmitter<void>();

  private lmToolsDisposables: vscode.Disposable[] = [];
  private token: string | undefined;
  private busy = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: ConnectionManager,
    private readonly outputChannel: vscode.OutputChannel,
    resultView: QueryResultView,
  ) {
    this.auditLog = new AuditLog(outputChannel);

    this.approvalGate = new ApprovalGate(manager);
    this.disposables.push(this.approvalGate);

    this.toolCore = new AiToolCore(manager, this.approvalGate, this.auditLog, resultView);
    this.disposables.push(this.toolCore);
    this.disposables.push(
      this.toolCore.onDidChangeBusy((busy) => {
        this.busy = busy;
        this.updateStatusBar();
      }),
    );

    this.mcpHttpServer = new McpHttpServer({
      outputChannel,
      handlers: this.buildRpcHandlers(),
      getToken: () => this.token,
    });
    this.disposables.push(
      this.mcpHttpServer.onDidChangeState(() => {
        this.updateStatusBar();
        void vscode.commands.executeCommand('setContext', 'dbRover.ai.serverRunning', this.mcpHttpServer.state.running);
        this.onDidChangeAiStateEmitter.fire();
      }),
    );
    this.disposables.push(this.onDidChangeAiStateEmitter);

    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
    this.statusBarItem.command = 'dbRover.ai.showStatus';
    this.disposables.push(this.statusBarItem);

    const mcpProviderDisposable = registerMcpProvider(
      {
        getState: () => this.mcpHttpServer.state,
        getToken: () => this.token,
        onDidChangeState: this.onDidChangeAiStateEmitter.event,
      },
      String(context.extension.packageJSON.version ?? '0.0.0'),
    );
    if (mcpProviderDisposable) {
      this.disposables.push(mcpProviderDisposable);
    }

    this.registerCommands();

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('dbRover.ai')) {
          void this.applyConfig();
        }
      }),
    );

    void vscode.commands.executeCommand('setContext', 'dbRover.ai.serverRunning', false);
  }

  /** SecretStorage からトークンを読み（無ければ生成し）、設定に従ってサーバ・LM ツールを立ち上げる。 */
  async activate(): Promise<void> {
    this.token = await this.ensureToken();
    await this.applyConfig();
  }

  private buildRpcHandlers(): RpcHandlers {
    return {
      listTools: () => TOOL_DEFS.map((def) => ({ name: def.name, description: def.description, inputSchema: def.inputSchema })),
      callTool: (name, args) => this.toolCore.call({ caller: 'mcp', name, args }),
    };
  }

  private async ensureToken(): Promise<string> {
    const existing = await this.context.secrets.get(TOKEN_SECRET_KEY);
    if (existing) {
      return existing;
    }
    const generated = generateToken();
    await this.context.secrets.store(TOKEN_SECRET_KEY, generated);
    return generated;
  }

  private config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(CONFIG_SECTION);
  }

  /** 設定 `dbRover.ai.*` の現在値をサーバ・LM ツールの状態に反映する。 */
  private async applyConfig(): Promise<void> {
    const config = this.config();

    const lmEnabled = config.get<boolean>('ai.languageModelTools.enabled', true);
    if (lmEnabled && this.lmToolsDisposables.length === 0) {
      this.lmToolsDisposables = registerLmTools(this.toolCore);
    } else if (!lmEnabled && this.lmToolsDisposables.length > 0) {
      for (const disposable of this.lmToolsDisposables) {
        disposable.dispose();
      }
      this.lmToolsDisposables = [];
    }

    const mcpEnabled = config.get<boolean>('ai.mcpServer.enabled', false);
    const port = config.get<number>('ai.port', DEFAULT_PORT);
    const state = this.mcpHttpServer.state;
    if (mcpEnabled) {
      if (!state.running) {
        await this.mcpHttpServer.start(port);
      } else if (port !== 0 && state.port !== port) {
        // ポート設定が変わったので張り直す。
        await this.mcpHttpServer.stop();
        await this.mcpHttpServer.start(port);
      }
    } else if (state.running) {
      await this.mcpHttpServer.stop();
    }

    this.updateStatusBar();
  }

  private updateStatusBar(): void {
    const state = this.mcpHttpServer.state;
    if (!state.running) {
      this.statusBarItem.hide();
      return;
    }
    const connectedCount = getConnections().filter((config) => this.manager.isConnected(config.id)).length;
    this.statusBarItem.text = this.busy ? '$(sync~spin) DB Rover AI' : '$(rocket) DB Rover AI';
    this.statusBarItem.tooltip = `DB Rover: AI 連携用 MCP サーバが port ${state.port} で稼働中です（接続中 ${connectedCount} 件）。クリックで状態を表示します。`;
    this.statusBarItem.show();
  }

  private registerCommands(): void {
    this.disposables.push(
      vscode.commands.registerCommand('dbRover.ai.startServer', () => this.setMcpServerEnabled(true)),
      vscode.commands.registerCommand('dbRover.ai.stopServer', () => this.setMcpServerEnabled(false)),
      vscode.commands.registerCommand('dbRover.ai.copyMcpConfig', () => this.copyMcpConfig()),
      vscode.commands.registerCommand('dbRover.ai.writeMcpJson', () => this.writeMcpJson()),
      vscode.commands.registerCommand('dbRover.ai.showStatus', () => this.showStatus()),
      vscode.commands.registerCommand('dbRover.ai.rotateToken', () => this.rotateToken()),
      vscode.commands.registerCommand('dbRover.ai.resetApprovals', () => this.resetApprovals()),
    );
  }

  private async setMcpServerEnabled(enabled: boolean): Promise<void> {
    const port = this.config().get<number>('ai.port', DEFAULT_PORT);
    if (enabled) {
      await this.mcpHttpServer.start(port);
      void vscode.window.showInformationMessage(
        `DB Rover: MCP サーバを起動しました（port ${this.mcpHttpServer.state.port}）。`,
      );
    } else {
      await this.mcpHttpServer.stop();
      void vscode.window.showInformationMessage('DB Rover: MCP サーバを停止しました。');
    }
    // 次回の起動時にも状態を保つため、設定にも書き戻す。
    await this.config().update('ai.mcpServer.enabled', enabled, vscode.ConfigurationTarget.Global);
    this.updateStatusBar();
  }

  private buildMcpServerEntry(): { type: 'http'; url: string } {
    const state = this.mcpHttpServer.state;
    return { type: 'http', url: `http://127.0.0.1:${state.port}/mcp/${this.token ?? ''}` };
  }

  private async copyMcpConfig(): Promise<void> {
    if (!this.mcpHttpServer.state.running || this.mcpHttpServer.state.port === undefined || !this.token) {
      void vscode.window.showWarningMessage(
        'DB Rover: MCP サーバが起動していません。先に「AI 連携: MCP サーバを開始」を実行してください。',
      );
      return;
    }
    const snippet = { mcpServers: { 'db-rover': this.buildMcpServerEntry() } };
    await vscode.env.clipboard.writeText(JSON.stringify(snippet, null, 2));
    void vscode.window.showInformationMessage('DB Rover: .mcp.json に貼り付けられる設定をコピーしました。');
  }

  private async writeMcpJson(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      void vscode.window.showWarningMessage('DB Rover: ワークスペースが開かれていません。');
      return;
    }
    if (!this.mcpHttpServer.state.running || this.mcpHttpServer.state.port === undefined || !this.token) {
      void vscode.window.showWarningMessage(
        'DB Rover: MCP サーバが起動していません。先に「AI 連携: MCP サーバを開始」を実行してください。',
      );
      return;
    }

    const mcpJsonUri = vscode.Uri.joinPath(folder.uri, '.mcp.json');
    let existing: Record<string, unknown> = {};
    try {
      const bytes = await vscode.workspace.fs.readFile(mcpJsonUri);
      existing = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>;
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        void vscode.window.showErrorMessage(`DB Rover: .mcp.json の読み込みに失敗しました: ${errorMessage(error)}`);
        return;
      }
    }

    const servers =
      existing.mcpServers && typeof existing.mcpServers === 'object'
        ? { ...(existing.mcpServers as Record<string, unknown>) }
        : {};
    servers['db-rover'] = this.buildMcpServerEntry();
    const merged = { ...existing, mcpServers: servers };
    const text = `${JSON.stringify(merged, null, 2)}\n`;

    const confirmed = await vscode.window.showWarningMessage(
      '.mcp.json に "db-rover" サーバ定義を書き込みます（トークンが平文で含まれます）。よろしいですか？',
      { modal: true, detail: text },
      '書き込む',
    );
    if (confirmed !== '書き込む') {
      return;
    }

    await vscode.workspace.fs.writeFile(mcpJsonUri, Buffer.from(text, 'utf8'));
    void vscode.window.showInformationMessage('DB Rover: .mcp.json に書き込みました。');

    await this.suggestGitignore(folder);
  }

  private async suggestGitignore(folder: vscode.WorkspaceFolder): Promise<void> {
    const gitignoreUri = vscode.Uri.joinPath(folder.uri, '.gitignore');
    let content = '';
    try {
      const bytes = await vscode.workspace.fs.readFile(gitignoreUri);
      content = Buffer.from(bytes).toString('utf8');
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        return;
      }
    }
    if (content.split(/\r?\n/).some((line) => line.trim() === '.mcp.json')) {
      return;
    }
    const choice = await vscode.window.showInformationMessage(
      'DB Rover: .mcp.json にはトークンが平文で含まれます。.gitignore に追記しますか？',
      '追記する',
    );
    if (choice !== '追記する') {
      return;
    }
    const next = content.length > 0 && !content.endsWith('\n') ? `${content}\n.mcp.json\n` : `${content}.mcp.json\n`;
    await vscode.workspace.fs.writeFile(gitignoreUri, Buffer.from(next, 'utf8'));
  }

  private async showStatus(): Promise<void> {
    const state = this.mcpHttpServer.state;
    const lmEnabled = this.config().get<boolean>('ai.languageModelTools.enabled', true);
    const mcpStatus = state.running ? `稼働中（port ${state.port}）` : '停止中';
    this.outputChannel.appendLine(
      `[${new Date().toISOString()}] [AI] 状態: MCP サーバ=${mcpStatus} / Language Model Tools=${lmEnabled ? '有効' : '無効'}`,
    );
    if (state.running && state.port !== undefined) {
      this.outputChannel.appendLine(`  URL: http://127.0.0.1:${state.port}/mcp/****`);
    }
    this.outputChannel.show(true);

    if (state.running && state.port !== undefined && this.token) {
      const choice = await vscode.window.showInformationMessage(
        `DB Rover: MCP サーバは port ${state.port} で稼働中です。`,
        URL_COPY_LABEL,
      );
      if (choice === URL_COPY_LABEL) {
        await vscode.env.clipboard.writeText(`http://127.0.0.1:${state.port}/mcp/${this.token}`);
        void vscode.window.showInformationMessage('DB Rover: URL をクリップボードにコピーしました。');
      }
      return;
    }
    void vscode.window.showInformationMessage(
      'DB Rover: MCP サーバは停止しています。コマンド「AI 連携: MCP サーバを開始」で起動できます。',
    );
  }

  private async rotateToken(): Promise<void> {
    const token = generateToken();
    this.token = token;
    await this.context.secrets.store(TOKEN_SECRET_KEY, token);
    this.approvalGate.clear();
    this.onDidChangeAiStateEmitter.fire();
    void vscode.window.showInformationMessage(
      'DB Rover: MCP のトークンを再発行しました。既存の .mcp.json 等の登録は無効になります。再登録してください。',
    );
  }

  private resetApprovals(): void {
    this.approvalGate.clear();
    void vscode.window.showInformationMessage('DB Rover: AI からの書き込み許可の記憶をリセットしました。');
  }

  /** `context.subscriptions` から呼ばれても構わないが、実際に HTTP サーバを閉じ切るには
   * この戻り値（Promise）を `deactivate()` から await すること。 */
  async dispose(): Promise<void> {
    for (const disposable of this.lmToolsDisposables) {
      disposable.dispose();
    }
    this.lmToolsDisposables = [];
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    await this.mcpHttpServer.dispose();
  }
}

function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === 'FileNotFound';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
