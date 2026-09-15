import * as vscode from 'vscode';
import { getConnectionById, getConnections } from '../connections/store.js';
import {
  HEAD_LINE_LIMIT,
  findConnectionComment,
  formatConnectionComment,
  planConnectionComment,
  resolveConnectionRef,
} from './connectionComment.js';

const STORAGE_KEY = 'dbRover.sqlDocumentConnections';

/**
 * SQL ドキュメントごとの接続先の束縛を持つ。
 *
 * 真に見るのはドキュメント先頭の `-- db-rover: ...` コメント。ウィンドウを再読み込み
 * すると untitled の URI は別の文書に振り直されるので、メモリ上の束縛だけでは実行先が
 * 失われるため。コメントが無いドキュメントのために、URI ごとの束縛も併せて持つ
 * （保存済みファイルだけ workspaceState に永続化する。untitled の URI は再利用される）。
 */
export class QueryBindingStore implements vscode.Disposable {
  private readonly bindings = new Map<string, string>();
  private readonly disposables: vscode.Disposable[] = [];

  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri | undefined>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(private readonly memento: vscode.Memento) {
    const stored = this.memento.get<Record<string, string>>(STORAGE_KEY, {});
    // 削除済みの接続を指したままの束縛は捨てる。
    const alive = new Set(getConnections().map((config) => config.id));
    for (const [uri, connectionId] of Object.entries(stored)) {
      if (alive.has(connectionId)) {
        this.bindings.set(uri, connectionId);
      }
    }
    void this.persist();

    this.disposables.push(
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (document.uri.scheme !== 'file') {
          this.bindings.delete(document.uri.toString());
        }
      }),
    );
  }

  /**
   * ドキュメントの実行先の接続 id。先頭コメントが最優先で、無ければ URI ごとの束縛。
   * コメントはユーザーが目で見て書き換えられるので、そちらを常に正とする。
   */
  get(document: vscode.TextDocument): string | undefined {
    const fromComment = this.fromComment(document);
    if (fromComment) {
      return fromComment;
    }
    return this.bindings.get(document.uri.toString());
  }

  /** 先頭コメントだけから実行先を読む。書かれていない・解決できないときは undefined。 */
  private fromComment(document: vscode.TextDocument): string | undefined {
    const found = findConnectionComment(headText(document));
    if (!found) {
      return undefined;
    }
    return resolveConnectionRef(found.ref, getConnections())?.id;
  }

  /**
   * ドキュメントの実行先を確定し、先頭コメントにも書き出す。
   * 戻り値は編集で先頭がずれた文字数。呼び出し側が持っているオフセットの補正に使う。
   */
  async bindDocument(document: vscode.TextDocument, connectionId: string): Promise<number> {
    this.set(document.uri, connectionId);
    const config = getConnectionById(connectionId);
    if (!config) {
      return 0;
    }
    const plan = planConnectionComment(headText(document), formatConnectionComment(config));
    if (!plan) {
      return 0;
    }
    const edit = new vscode.WorkspaceEdit();
    const range = new vscode.Range(document.positionAt(plan.start), document.positionAt(plan.end));
    edit.replace(document.uri, range, plan.insert);
    const applied = await vscode.workspace.applyEdit(edit);
    return applied ? plan.delta : 0;
  }

  set(uri: vscode.Uri, connectionId: string): void {
    this.bindings.set(uri.toString(), connectionId);
    void this.persist();
    this.onDidChangeEmitter.fire(uri);
  }

  clear(uri: vscode.Uri): void {
    this.bindings.delete(uri.toString());
    void this.persist();
    this.onDidChangeEmitter.fire(uri);
  }

  /** 接続を削除したときに、その接続を指す束縛をまとめて捨てる。 */
  clearConnection(connectionId: string): void {
    let changed = false;
    for (const [uri, id] of this.bindings) {
      if (id === connectionId) {
        this.bindings.delete(uri);
        changed = true;
      }
    }
    if (changed) {
      void this.persist();
      this.onDidChangeEmitter.fire(undefined);
    }
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.onDidChangeEmitter.dispose();
  }

  private async persist(): Promise<void> {
    const persistable: Record<string, string> = {};
    for (const [uri, connectionId] of this.bindings) {
      if (uri.startsWith('file:')) {
        persistable[uri] = connectionId;
      }
    }
    await this.memento.update(STORAGE_KEY, persistable);
  }
}

/** 先頭コメントの走査に必要な範囲だけを読む。巨大な SQL で全文を取らないため。 */
function headText(document: vscode.TextDocument): string {
  const end = Math.min(document.lineCount, HEAD_LINE_LIMIT);
  return document.getText(new vscode.Range(0, 0, end, 0));
}
