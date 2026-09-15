import * as vscode from 'vscode';
import { ConnectionManager } from './connections/manager.js';
import {
  deletePassword,
  getConnectionById,
  getConnections,
  removeConnectionConfig,
} from './connections/store.js';
import { ConnectionEditorPanel } from './connections/editor.js';
import { DbRoverTreeProvider } from './tree/provider.js';
import { ConnectionNode, TableNode } from './tree/nodes.js';
import type { DbRoverNode } from './tree/nodes.js';
import { QueryResultView } from './query/resultView.js';
import { SqlCompletionProvider } from './query/completion.js';
import { QueryBindingStore } from './query/binding.js';
import { HEAD_LINE_LIMIT, formatConnectionComment } from './query/connectionComment.js';
import { QueryExecutor } from './query/execute.js';
import { SqlCodeLensProvider } from './query/codeLens.js';
import { StatementFocus } from './query/statementFocus.js';
import { TableViewManager } from './table/tableView.js';
import type { ConnectionConfig } from './types.js';
import type { RunScope } from './query/execute.js';

let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('DB Rover');
  context.subscriptions.push(outputChannel);

  const manager = new ConnectionManager(context.secrets, outputChannel);
  context.subscriptions.push(manager);

  const treeProvider = new DbRoverTreeProvider(manager, outputChannel, context.extensionUri);
  context.subscriptions.push(treeProvider);
  const treeView = vscode.window.createTreeView('dbRover.connections', { treeDataProvider: treeProvider });
  context.subscriptions.push(treeView);

  const tableViewManager = new TableViewManager(context.extensionUri, manager, context.workspaceState, outputChannel);
  context.subscriptions.push(tableViewManager);

  const connectionEditor = new ConnectionEditorPanel(
    context.extensionUri,
    context.secrets,
    outputChannel,
    (saved) => {
      // 接続中の設定を書き換えた場合は、次回接続時に新しい設定が使われるよう一度切断する。
      if (manager.isConnected(saved.id)) {
        void manager.disconnect(saved.id).then(() => treeProvider.refresh());
        void vscode.window.showInformationMessage(
          `DB Rover: 設定変更のため接続「${saved.name}」を切断しました。再度接続してください。`,
        );
        return;
      }
      treeProvider.refresh();
    },
  );
  context.subscriptions.push(connectionEditor);

  // SQL エディタごとの接続先の束縛。実行も補完もまずこれを見る。
  const bindings = new QueryBindingStore(context.workspaceState);
  context.subscriptions.push(bindings);

  // クエリ結果は下部パネル（ターミナルや出力と同じ場所）に出す。
  const resultView = new QueryResultView(context.extensionUri);
  context.subscriptions.push(resultView);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(QueryResultView.viewId, resultView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Cmd/Ctrl+Enter で実行対象をハイライトし、Enter で実行するための状態。
  const statementFocus = new StatementFocus();
  context.subscriptions.push(statementFocus);

  const executor = new QueryExecutor(manager, bindings, resultView, outputChannel);

  // SQL エディタの補完。束縛中の接続のスキーマ・テーブル・列を出す。
  const completionProvider = new SqlCompletionProvider(manager, bindings);
  context.subscriptions.push(completionProvider);
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider({ language: 'sql' }, completionProvider, '.'),
  );

  // 文ごとの実行ボタン（CodeLens）。
  const codeLensProvider = new SqlCodeLensProvider(manager, bindings);
  context.subscriptions.push(codeLensProvider);
  context.subscriptions.push(vscode.languages.registerCodeLensProvider({ language: 'sql' }, codeLensProvider));

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'dbRover.selectActiveConnection';
  context.subscriptions.push(statusBarItem);
  context.subscriptions.push(manager.onDidChangeActive(() => updateStatusBar(manager, bindings)));
  context.subscriptions.push(bindings.onDidChange(() => updateStatusBar(manager, bindings)));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => updateStatusBar(manager, bindings)));
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      // 先頭コメントの実行先を手で書き換えたときも、ステータスバーを追従させる。
      if (event.document !== vscode.window.activeTextEditor?.document) return;
      if (event.document.languageId !== 'sql') return;
      if (!event.contentChanges.some((change) => change.range.start.line < HEAD_LINE_LIMIT)) return;
      updateStatusBar(manager, bindings);
    }),
  );
  updateStatusBar(manager, bindings);
  statusBarItem.show();

  registerCommands(
    context,
    manager,
    treeProvider,
    tableViewManager,
    connectionEditor,
    outputChannel,
    bindings,
    executor,
    statementFocus,
  );

  if (vscode.workspace.getConfiguration('dbRover').get<boolean>('autoConnectOnStartup', false)) {
    void autoConnectAll(manager, outputChannel);
  }
}

export function deactivate(): Thenable<void> | undefined {
  return undefined;
}

/**
 * SQL エディタを見ているときは、そのエディタの実行先（束縛）を出す。
 * 未設定なら警告色にして、クリック先も接続先の選択に切り替える。
 */
function updateStatusBar(manager: ConnectionManager, bindings: QueryBindingStore): void {
  const editor = vscode.window.activeTextEditor;
  if (editor?.document.languageId === 'sql') {
    const boundId = bindings.get(editor.document);
    const config = boundId ? getConnectionById(boundId) : undefined;
    statusBarItem.command = 'dbRover.selectDocumentConnection';
    if (config) {
      statusBarItem.text = `$(database) ${config.name}`;
      statusBarItem.tooltip = `DB Rover: この SQL の実行先は「${config.name}」(${config.kind}) です。クリックで変更できます。`;
      statusBarItem.backgroundColor = undefined;
    } else {
      statusBarItem.text = '$(warning) 実行先 未設定';
      statusBarItem.tooltip = 'DB Rover: この SQL の実行先が未設定です。クリックして選択してください。';
      statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    return;
  }

  statusBarItem.command = 'dbRover.selectActiveConnection';
  statusBarItem.backgroundColor = undefined;
  const id = manager.activeConnectionId;
  if (!id) {
    statusBarItem.text = '$(database) DB 未選択';
    statusBarItem.tooltip = 'DB Rover: アクティブ接続を選択';
    return;
  }
  const config = getConnectionById(id);
  statusBarItem.text = `$(database) ${config ? config.name : id}`;
  statusBarItem.tooltip = 'DB Rover: アクティブ接続を選択';
}

/** uri が指すエディタ（省略時はアクティブエディタ）を返す。SQL 以外は対象外。 */
async function editorFor(uri?: vscode.Uri): Promise<vscode.TextEditor | undefined> {
  if (!uri) {
    return vscode.window.activeTextEditor;
  }
  const key = uri.toString();
  const visible = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === key);
  if (visible) {
    return visible;
  }
  const document = await vscode.workspace.openTextDocument(uri);
  return vscode.window.showTextDocument(document, { preserveFocus: true });
}

async function runInEditor(
  executor: QueryExecutor,
  outputChannel: vscode.OutputChannel,
  scope: RunScope,
  uri?: vscode.Uri,
  offset?: number,
): Promise<void> {
  const editor = await editorFor(uri);
  if (!editor) return;
  try {
    await executor.run(editor, scope, offset);
  } catch (error) {
    showError(outputChannel, error, 'クエリの実行に失敗しました');
  }
}

async function autoConnectAll(manager: ConnectionManager, outputChannel: vscode.OutputChannel): Promise<void> {
  for (const config of getConnections()) {
    try {
      await manager.connect(config);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outputChannel.appendLine(`自動接続に失敗しました (${config.name}): ${message}`);
    }
  }
}

function showError(outputChannel: vscode.OutputChannel, error: unknown, prefix: string): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? (error.stack ?? error.message) : String(error);
  outputChannel.appendLine(`${prefix}: ${stack}`);
  void vscode.window.showErrorMessage(`DB Rover: ${prefix}: ${message}`);
}

async function pickConnection(placeHolder: string): Promise<ConnectionConfig | undefined> {
  const connections = getConnections();
  if (connections.length === 0) {
    void vscode.window.showInformationMessage('DB Rover: 接続が登録されていません。まず「接続を追加」を実行してください。');
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    connections.map((config) => ({ label: config.name, description: config.kind, config })),
    { placeHolder },
  );
  return picked?.config;
}

function registerCommands(
  context: vscode.ExtensionContext,
  manager: ConnectionManager,
  treeProvider: DbRoverTreeProvider,
  tableViewManager: TableViewManager,
  connectionEditor: ConnectionEditorPanel,
  outputChannel: vscode.OutputChannel,
  bindings: QueryBindingStore,
  executor: QueryExecutor,
  statementFocus: StatementFocus,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('dbRover.refresh', () => {
      treeProvider.refresh();
    }),

    vscode.commands.registerCommand('dbRover.addConnection', async () => {
      try {
        await connectionEditor.open();
      } catch (error) {
        showError(outputChannel, error, '接続の追加に失敗しました');
      }
    }),

    vscode.commands.registerCommand('dbRover.editConnection', async (node?: ConnectionNode) => {
      const config = node?.config ?? (await pickConnection('編集する接続を選択してください'));
      if (!config) return;
      try {
        await connectionEditor.open(config);
      } catch (error) {
        showError(outputChannel, error, '接続の編集に失敗しました');
      }
    }),

    vscode.commands.registerCommand('dbRover.removeConnection', async (node?: ConnectionNode) => {
      const config = node?.config ?? (await pickConnection('削除する接続を選択してください'));
      if (!config) return;
      const confirmed = await vscode.window.showWarningMessage(
        `接続「${config.name}」を削除しますか？（保存されたパスワードも削除されます）`,
        { modal: true },
        '削除',
      );
      if (confirmed !== '削除') return;
      try {
        await manager.disconnect(config.id);
        await removeConnectionConfig(config.id);
        await deletePassword(context.secrets, config.id);
        bindings.clearConnection(config.id);
        treeProvider.refresh();
      } catch (error) {
        showError(outputChannel, error, '接続の削除に失敗しました');
      }
    }),

    vscode.commands.registerCommand('dbRover.connect', async (node?: ConnectionNode) => {
      const config = node?.config ?? (await pickConnection('接続する接続を選択してください'));
      if (!config) return;
      try {
        await manager.connect(config);
        treeProvider.refresh();
      } catch (error) {
        showError(outputChannel, error, '接続に失敗しました');
      }
    }),

    vscode.commands.registerCommand('dbRover.disconnect', async (node?: ConnectionNode) => {
      const config = node?.config ?? (await pickConnection('切断する接続を選択してください'));
      if (!config) return;
      await manager.disconnect(config.id);
      treeProvider.refresh();
    }),

    vscode.commands.registerCommand('dbRover.selectActiveConnection', async () => {
      const config = await pickConnection('アクティブにする接続を選択してください');
      if (!config) return;
      try {
        await manager.ensureConnected(config);
        manager.setActiveConnection(config.id);
        treeProvider.refresh();
      } catch (error) {
        showError(outputChannel, error, '接続に失敗しました');
      }
    }),

    // ようこそ画面の「はじめに」。使い方はドキュメントに書かず、こちらに集約している。
    vscode.commands.registerCommand('dbRover.openWalkthrough', async () => {
      await vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        'leptosystem.db-rover#dbRover.gettingStarted',
        false,
      );
    }),

    vscode.commands.registerCommand('dbRover.newQuery', async (node?: ConnectionNode) => {
      // ツリーの接続から開いた場合は、その接続につないでから開いたエディタに束縛する。
      // 以後この SQL エディタは、アクティブ接続が変わっても必ずこの接続へ実行する。
      const config = node?.config ?? (await pickConnection('SQL の実行先にする接続を選択してください'));
      if (config) {
        try {
          await manager.ensureConnected(config);
          manager.setActiveConnection(config.id);
          treeProvider.refresh();
        } catch (error) {
          showError(outputChannel, error, '接続に失敗しました');
          return;
        }
      }
      // ウィンドウを再読み込みすると untitled の束縛は失われるので、実行先は先頭コメントに残す。
      const header = config ? `${formatConnectionComment(config)}\n\n` : '';
      const doc = await vscode.workspace.openTextDocument({ language: 'sql', content: header });
      if (config) {
        bindings.set(doc.uri, config.id);
      }
      const shown = await vscode.window.showTextDocument(doc);
      shown.selection = new vscode.Selection(doc.lineCount - 1, 0, doc.lineCount - 1, 0);
    }),

    // Cmd/Ctrl+Enter。1 回目で一番近い文をハイライトし、2 回目（または Enter）で実行する。
    // 何が走るのかを実行前に確認できるようにするための 2 段階。
    vscode.commands.registerCommand('dbRover.focusOrRunStatement', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      // 範囲選択中はユーザーが対象を明示しているので、ハイライトを挟まずそのまま実行する。
      if (!editor.selection.isEmpty) {
        statementFocus.clear();
        await runInEditor(executor, outputChannel, 'statement');
        return;
      }

      const focused = statementFocus.get(editor);
      if (focused) {
        statementFocus.clear();
        await runInEditor(executor, outputChannel, 'statement', editor.document.uri, focused.start);
        return;
      }

      const statement = executor.nearestStatement(editor);
      if (!statement) {
        void vscode.window.showInformationMessage('DB Rover: 実行できる SQL がありません。');
        return;
      }
      statementFocus.set(editor, statement);
    }),

    // ハイライト中の Enter。when 節で横取りしているので、ここに来る時点で対象はある。
    vscode.commands.registerCommand('dbRover.runFocusedStatement', async () => {
      const editor = vscode.window.activeTextEditor;
      const focused = editor ? statementFocus.get(editor) : undefined;
      if (!editor || !focused) {
        statementFocus.clear();
        return;
      }
      statementFocus.clear();
      await runInEditor(executor, outputChannel, 'statement', editor.document.uri, focused.start);
    }),

    vscode.commands.registerCommand('dbRover.clearStatementFocus', () => {
      statementFocus.clear();
    }),

    // CodeLens / キーバインド / メニューから呼ばれる実行コマンド群。
    // 引数が無いときはアクティブエディタのカーソル位置を対象にする。
    vscode.commands.registerCommand('dbRover.runStatement', async (uri?: vscode.Uri, offset?: number) => {
      await runInEditor(executor, outputChannel, 'statement', uri, offset);
    }),

    vscode.commands.registerCommand('dbRover.runStatementsFrom', async (uri?: vscode.Uri, offset?: number) => {
      await runInEditor(executor, outputChannel, 'from', uri, offset);
    }),

    vscode.commands.registerCommand('dbRover.runAllStatements', async (uri?: vscode.Uri) => {
      await runInEditor(executor, outputChannel, 'all', uri);
    }),

    vscode.commands.registerCommand('dbRover.selectDocumentConnection', async (uri?: vscode.Uri) => {
      const editor = await editorFor(uri);
      if (!editor) return;
      await executor.pickConnection(editor.document);
    }),

    // 旧コマンド。カーソル位置の 1 文を実行する dbRover.runStatement と同じ挙動にしている。
    vscode.commands.registerCommand('dbRover.runQuery', async () => {
      await runInEditor(executor, outputChannel, 'statement');
    }),

    vscode.commands.registerCommand('dbRover.openTable', async (node?: TableNode) => {
      if (!node) return;
      try {
        const config = getConnectionById(node.connectionId);
        if (!config) {
          throw new Error('接続設定が見つかりません。');
        }
        await manager.ensureConnected(config);
        tableViewManager.open({
          connectionId: node.connectionId,
          connectionName: node.connectionName,
          schema: node.table.schema ?? 'main',
          table: node.table.name,
          tableType: node.table.type,
        });
      } catch (error) {
        showError(outputChannel, error, 'テーブルを開けませんでした');
      }
    }),

    vscode.commands.registerCommand('dbRover.previewTableData', async (node?: TableNode) => {
      await vscode.commands.executeCommand('dbRover.openTable', node);
    }),

    // Cmd/Ctrl+S。実際の確認ダイアログと SQL 生成は webview 側が行う。
    vscode.commands.registerCommand('dbRover.saveTableEdits', () => {
      tableViewManager.requestSaveOnActivePanel();
    }),

    vscode.commands.registerCommand('dbRover.copyName', async (node?: DbRoverNode) => {
      if (!node) return;
      const name = nameOf(node);
      if (name) {
        await vscode.env.clipboard.writeText(name);
      }
    }),
  );
}

function nameOf(node: DbRoverNode): string | undefined {
  switch (node.kind) {
    case 'connection':
      return node.config.name;
    case 'schema':
      return node.schema;
    case 'table':
      return node.table.name;
    case 'column':
      return node.column.name;
    case 'index':
      return node.index.name;
    default:
      return undefined;
  }
}
