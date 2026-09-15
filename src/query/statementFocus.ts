import * as vscode from 'vscode';
import type { SqlStatement } from './splitStatements.js';

/** Enter の横取りを when 節で切り替えるためのコンテキストキー。 */
const CONTEXT_KEY = 'dbRover.statementFocused';

/**
 * 「次に実行する文」を先にハイライトしておく状態。
 *
 * Cmd/Ctrl+Enter でカーソルに一番近い文をハイライトし、その状態で Enter を押すと実行する。
 * 何が走るのかを実行前に目で確認できるようにするための 2 段階。
 * ハイライト中だけ Enter を奪いたいので、コンテキストキーで when 節を切り替えている。
 */
export class StatementFocus implements vscode.Disposable {
  // 行全体の塗り + 左のアクセントバー。色は package.json の contributes.colors で
  // 定義しているので、テーマごとの濃さを settings.json から調整できる。
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('dbRover.statementFocusBackground'),
    borderWidth: '0 0 0 3px',
    borderStyle: 'solid',
    borderColor: new vscode.ThemeColor('dbRover.statementFocusBorder'),
    overviewRulerLane: vscode.OverviewRulerLane.Full,
    overviewRulerColor: new vscode.ThemeColor('dbRover.statementFocusBorder'),
  });

  // 文の末尾に出すバッジ。ハイライトの範囲が一目で分かるうえ、
  // 「次に Enter を押せば走る」という 2 段階そのものの説明にもなる。
  private readonly hint = vscode.window.createTextEditorDecorationType({
    after: {
      contentText: ' ⏎ Enter で実行 ',
      backgroundColor: new vscode.ThemeColor('dbRover.statementFocusBorder'),
      color: new vscode.ThemeColor('dbRover.statementFocusHintForeground'),
      margin: '0 0 0 1.5rem',
    },
  });

  private current: { uri: vscode.Uri; statement: SqlStatement } | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      // 別のエディタへ移ったらハイライトは無効。Enter を奪ったままにしない。
      vscode.window.onDidChangeActiveTextEditor(() => this.clear()),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (this.isCurrent(event.document.uri)) {
          // 編集されるとオフセットがずれるので、ハイライトを信用しない。
          this.clear();
        }
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (!this.current) return;
        if (!this.isCurrent(event.textEditor.document.uri)) {
          this.clear();
          return;
        }
        const selection = event.selections[0];
        if (!selection || !selection.isEmpty) {
          this.clear();
          return;
        }
        // ハイライトの外へカーソルが出たら解除する。文の中での移動は保つ。
        const offset = event.textEditor.document.offsetAt(selection.active);
        if (offset < this.current.statement.start || offset > this.current.statement.end) {
          this.clear();
        }
      }),
    );
  }

  dispose(): void {
    this.clear();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.decoration.dispose();
    this.hint.dispose();
  }

  /** そのエディタで今ハイライト中の文を返す。無ければ undefined。 */
  get(editor: vscode.TextEditor): SqlStatement | undefined {
    return this.isCurrent(editor.document.uri) ? this.current?.statement : undefined;
  }

  /** 文をハイライトして、Enter で実行できる状態にする。 */
  set(editor: vscode.TextEditor, statement: SqlStatement): void {
    this.current = { uri: editor.document.uri, statement };
    const range = new vscode.Range(
      editor.document.positionAt(statement.start),
      editor.document.positionAt(statement.end),
    );
    editor.setDecorations(this.decoration, [range]);
    editor.setDecorations(this.hint, [new vscode.Range(range.end, range.end)]);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    void vscode.commands.executeCommand('setContext', CONTEXT_KEY, true);
  }

  /** ハイライトを消して、Enter を通常どおり改行に戻す。 */
  clear(): void {
    const target = this.current;
    this.current = undefined;
    void vscode.commands.executeCommand('setContext', CONTEXT_KEY, false);
    if (!target) return;
    const key = target.uri.toString();
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === key) {
        editor.setDecorations(this.decoration, []);
        editor.setDecorations(this.hint, []);
      }
    }
  }

  private isCurrent(uri: vscode.Uri): boolean {
    return this.current !== undefined && this.current.uri.toString() === uri.toString();
  }
}
