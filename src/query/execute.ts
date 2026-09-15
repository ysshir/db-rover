import * as vscode from 'vscode';
import type { ConnectionManager } from '../connections/manager.js';
import { getConnectionById, getConnections } from '../connections/store.js';
import type { ConnectionConfig, StatementOutcome } from '../types.js';
import type { QueryBindingStore } from './binding.js';
import { QueryResultView } from './resultView.js';
import { runStatements } from './runner.js';
import { nearestStatement, splitSqlStatements, statementAtOffset } from './splitStatements.js';
import type { SqlStatement } from './splitStatements.js';

/** どの範囲の文を実行するか。 */
export type RunScope = 'statement' | 'from' | 'all';

/** 解決した実行先と、先頭コメントの書き込みでずれたオフセットの補正量。 */
export interface ResolvedConnection {
  config: ConnectionConfig;
  offsetDelta: number;
}

export class QueryExecutor {
  constructor(
    private readonly manager: ConnectionManager,
    private readonly bindings: QueryBindingStore,
    private readonly resultView: QueryResultView,
    private readonly outputChannel: vscode.OutputChannel,
  ) {}

  /**
   * ドキュメントの実行先接続を決める。束縛が無ければアクティブ接続に昇格させ、
   * それも無ければ選ばせる。どの経路でも決まった時点でドキュメントに束縛する
   * （先頭コメントにも書き出すので、再読み込みしても実行先が残る）。
   */
  async resolveConnection(document: vscode.TextDocument): Promise<ResolvedConnection | undefined> {
    const bound = this.bindings.get(document);
    const boundConfig = bound ? getConnectionById(bound) : undefined;
    if (boundConfig) {
      return { config: boundConfig, offsetDelta: 0 };
    }

    const active = this.manager.activeConnectionId;
    const activeConfig = active ? getConnectionById(active) : undefined;
    if (activeConfig) {
      // 一度決まったらぶれないよう、暗黙採用でも束縛しておく。
      const offsetDelta = await this.bindings.bindDocument(document, activeConfig.id);
      return { config: activeConfig, offsetDelta };
    }

    return this.pickConnection(document);
  }

  /** 接続先をユーザーに選ばせて束縛する。 */
  async pickConnection(document: vscode.TextDocument): Promise<ResolvedConnection | undefined> {
    const configs = getConnections();
    if (configs.length === 0) {
      void vscode.window.showWarningMessage('DB Rover: 接続が登録されていません。サイドバーから接続を追加してください。');
      return undefined;
    }
    const current = this.bindings.get(document);
    const picked = await vscode.window.showQuickPick(
      configs.map((config) => ({
        label: config.name,
        description: `${config.kind}${this.manager.isConnected(config.id) ? '' : '（未接続）'}`,
        detail: config.id === current ? '現在の接続先' : undefined,
        config,
      })),
      { placeHolder: 'この SQL エディタの接続先を選択' },
    );
    if (!picked) {
      return undefined;
    }
    const offsetDelta = await this.bindings.bindDocument(document, picked.config.id);
    return { config: picked.config, offsetDelta };
  }

  /** ドキュメントを `;` で分割する。方言は束縛中の接続に合わせる。 */
  splitDocument(document: vscode.TextDocument, config: ConnectionConfig | undefined): SqlStatement[] {
    const bound = this.bindings.get(document);
    const kind = config?.kind ?? (bound ? getConnectionById(bound)?.kind : undefined) ?? 'postgres';
    return splitSqlStatements(document.getText(), kind);
  }

  /**
   * カーソルに一番近い文を返す。ハイライト用なので接続は解決しない
   * （未設定でも QuickPick を出さない）。方言は束縛中の接続に合わせる。
   */
  nearestStatement(editor: vscode.TextEditor): SqlStatement | undefined {
    const statements = this.splitDocument(editor.document, undefined);
    return nearestStatement(statements, editor.document.offsetAt(editor.selection.active));
  }

  /**
   * 実行の入口。選択範囲があればそれを 1 文として扱い、無ければ scope に従って
   * カーソル位置の文／それ以降／全文を実行する。
   */
  async run(editor: vscode.TextEditor, scope: RunScope, offset?: number): Promise<void> {
    const document = editor.document;
    const resolved = await this.resolveConnection(document);
    if (!resolved) {
      return;
    }
    const config = resolved.config;
    // 先頭コメントを書き足した場合は、CodeLens などから渡ってきたオフセットがその分ずれる。
    const at = offset === undefined ? undefined : offset + resolved.offsetDelta;

    const targets = this.collectTargets(editor, scope, at, config);
    if (targets.length === 0) {
      void vscode.window.showInformationMessage('DB Rover: 実行できる SQL がありません。');
      return;
    }

    try {
      await this.manager.ensureConnected(config);
    } catch (error) {
      this.reportError(error, '接続に失敗しました');
      return;
    }

    const limit = vscode.workspace.getConfiguration('dbRover').get<number>('queryRowLimit', 500);
    const stopOnError = vscode.workspace.getConfiguration('dbRover').get<boolean>('stopOnError', true);
    const outcomes = await runStatements(this.manager, config.id, targets, limit, stopOnError);

    await this.resultView.show(config.name, outcomes);
    this.revealFirstError(editor, outcomes);
  }

  private collectTargets(
    editor: vscode.TextEditor,
    scope: RunScope,
    offset: number | undefined,
    config: ConnectionConfig,
  ): SqlStatement[] {
    const document = editor.document;

    // 選択範囲が優先。ユーザーが範囲を選んでいるなら、その中を分割して実行する。
    if (!editor.selection.isEmpty && scope !== 'all') {
      const selected = document.getText(editor.selection);
      const base = document.offsetAt(editor.selection.start);
      return splitSqlStatements(selected, config.kind).map((statement) => ({
        ...statement,
        start: statement.start + base,
        end: statement.end + base,
      }));
    }

    const statements = this.splitDocument(document, config);
    if (scope === 'all') {
      return statements;
    }

    const at = offset ?? document.offsetAt(editor.selection.active);
    const current = statementAtOffset(statements, at);
    if (!current) {
      // カーソルより前に文が無い（先頭のコメント上など）ときは、以降の最初の文を対象にする。
      const next = statements.find((statement) => statement.start >= at);
      if (!next) return [];
      return scope === 'from' ? statements.slice(statements.indexOf(next)) : [next];
    }
    const index = statements.indexOf(current);
    return scope === 'from' ? statements.slice(index) : [current];
  }

  /** 失敗した文をエディタ上で選択して見せる。どこで落ちたか分かるようにするため。 */
  private revealFirstError(editor: vscode.TextEditor, outcomes: StatementOutcome[]): void {
    const failed = outcomes.find((outcome) => outcome.status === 'error');
    if (!failed) {
      return;
    }
    const start = editor.document.positionAt(failed.startOffset);
    const end = editor.document.positionAt(failed.startOffset + failed.sql.length);
    editor.selection = new vscode.Selection(start, end);
    editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    void vscode.window.showErrorMessage(`DB Rover: ${failed.message ?? 'クエリの実行に失敗しました'}`);
  }

  private reportError(error: unknown, message: string): void {
    const detail = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? (error.stack ?? error.message) : String(error);
    this.outputChannel.appendLine(`${message}\n${stack}`);
    void vscode.window.showErrorMessage(`DB Rover: ${message}: ${detail}`);
  }
}
