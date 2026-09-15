import * as vscode from 'vscode';
import type { ConnectionManager } from '../connections/manager.js';
import { getConnectionById } from '../connections/store.js';
import type { QueryBindingStore } from './binding.js';
import { splitSqlStatements } from './splitStatements.js';

/**
 * SQL の文ごとに実行用の CodeLens を出す。
 *
 * VS Code には行番号の横（gutter）にクリックできるアイコンを置く API が無いため、
 * 文の直上に出す CodeLens で代替している。
 */
export class SqlCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.onDidChangeEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly manager: ConnectionManager,
    private readonly bindings: QueryBindingStore,
  ) {
    // 接続先の表示を持つため、束縛・接続状態・設定の変化で出し直す。
    this.disposables.push(
      this.bindings.onDidChange(() => this.onDidChangeEmitter.fire()),
      this.manager.onDidChangeConnections(() => this.onDidChangeEmitter.fire()),
      this.manager.onDidChangeActive(() => this.onDidChangeEmitter.fire()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('dbRover.showStatementCodeLens')) {
          this.onDidChangeEmitter.fire();
        }
      }),
    );
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.onDidChangeEmitter.dispose();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration('dbRover').get<boolean>('showStatementCodeLens', true)) {
      return [];
    }

    const lenses: vscode.CodeLens[] = [];
    const boundId = this.bindings.get(document);
    const config = boundId ? getConnectionById(boundId) : undefined;

    // 先頭に接続先を出す。どの DB に向けて実行するのかを一目で分かるようにするため。
    const headerRange = new vscode.Range(0, 0, 0, 0);
    lenses.push(
      new vscode.CodeLens(headerRange, {
        title: config
          ? `$(database) 接続先: ${config.name}（${config.kind}）${this.manager.isConnected(config.id) ? '' : ' — 未接続'}`
          : '$(warning) 接続先が未設定です — クリックして選択',
        command: 'dbRover.selectDocumentConnection',
        arguments: [document.uri],
      }),
    );

    const statements = splitSqlStatements(document.getText(), config?.kind ?? 'postgres');
    statements.forEach((statement, index) => {
      const position = document.positionAt(statement.start);
      const range = new vscode.Range(position, position);
      lenses.push(
        new vscode.CodeLens(range, {
          title: '$(play) 実行',
          command: 'dbRover.runStatement',
          arguments: [document.uri, statement.start],
        }),
      );
      // 最後の文に「ここから下」を出しても 1 文の実行と同じなので、2 文以上残っているときだけ。
      if (index < statements.length - 1) {
        lenses.push(
          new vscode.CodeLens(range, {
            title: `$(run-below) ここから下を実行（${statements.length - index} 文）`,
            command: 'dbRover.runStatementsFrom',
            arguments: [document.uri, statement.start],
          }),
        );
      }
    });

    return lenses;
  }
}
