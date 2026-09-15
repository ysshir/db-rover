import * as vscode from 'vscode';
import type { ConnectionConfig } from '../types.js';
import type { DbDriver } from '../drivers/driver.js';
import { createDriver } from '../drivers/index.js';
import { getPassword, setPassword } from './store.js';

/** 生きているドライバの保持・接続/切断・アクティブ接続の管理を行う。 */
export class ConnectionManager implements vscode.Disposable {
  private readonly drivers = new Map<string, DbDriver>();
  private activeId: string | undefined;

  private readonly onDidChangeActiveEmitter = new vscode.EventEmitter<string | undefined>();
  readonly onDidChangeActive = this.onDidChangeActiveEmitter.event;

  private readonly onDidChangeConnectionsEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeConnections = this.onDidChangeConnectionsEmitter.event;

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly outputChannel: vscode.OutputChannel,
  ) {}

  isConnected(id: string): boolean {
    return this.drivers.has(id);
  }

  getDriver(id: string): DbDriver | undefined {
    return this.drivers.get(id);
  }

  get activeConnectionId(): string | undefined {
    return this.activeId;
  }

  setActiveConnection(id: string | undefined): void {
    this.activeId = id;
    this.onDidChangeActiveEmitter.fire(id);
  }

  /** 未接続なら接続してからドライバを返す（ツリーの遅延接続に使う）。 */
  async ensureConnected(config: ConnectionConfig): Promise<DbDriver> {
    const existing = this.drivers.get(config.id);
    if (existing) {
      return existing;
    }
    return this.connect(config);
  }

  async connect(config: ConnectionConfig): Promise<DbDriver> {
    let password: string | undefined;
    if (config.kind !== 'sqlite') {
      password = await getPassword(this.secrets, config.id);
      if (password === undefined) {
        const input = await vscode.window.showInputBox({
          prompt: `${config.name} のパスワードを入力してください（空のままで OK を押すとパスワード無しで接続します）`,
          password: true,
          ignoreFocusOut: true,
        });
        if (input) {
          password = input;
          const shouldSave = await vscode.window.showQuickPick(['はい', 'いいえ'], {
            placeHolder: 'このパスワードを保存しますか？（SecretStorage に保存され、設定ファイルには書き込まれません）',
          });
          if (shouldSave === 'はい') {
            await setPassword(this.secrets, config.id, input);
          }
        }
      }
    }

    const driver = createDriver(config, password);
    try {
      await driver.connect();
    } catch (error) {
      this.logError(error, `接続に失敗しました: ${config.name}`);
      throw error;
    }
    this.drivers.set(config.id, driver);
    if (!this.activeId) {
      this.setActiveConnection(config.id);
    }
    this.onDidChangeConnectionsEmitter.fire();
    return driver;
  }

  async disconnect(id: string): Promise<void> {
    const driver = this.drivers.get(id);
    if (driver) {
      await driver.dispose().catch((error: unknown) => this.logError(error, `切断中にエラーが発生しました: ${id}`));
      this.drivers.delete(id);
    }
    if (this.activeId === id) {
      this.setActiveConnection(undefined);
    }
    this.onDidChangeConnectionsEmitter.fire();
  }

  async disconnectAll(): Promise<void> {
    await Promise.all(Array.from(this.drivers.keys()).map((id) => this.disconnect(id)));
  }

  private logError(error: unknown, message: string): void {
    const stack = error instanceof Error ? (error.stack ?? error.message) : String(error);
    this.outputChannel.appendLine(`${message}\n${stack}`);
  }

  dispose(): void {
    void this.disconnectAll();
    this.onDidChangeActiveEmitter.dispose();
    this.onDidChangeConnectionsEmitter.dispose();
  }
}
