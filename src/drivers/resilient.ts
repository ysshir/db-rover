import type {
  BrowseRequest,
  BrowseResult,
  ColumnMeta,
  DbKind,
  FilterSpec,
  IndexMeta,
  PreparedStatement,
  QueryResult,
  RowMutation,
  TableMeta,
} from '../types.js';
import type { ConnectionLostEvent, DbDriver } from './driver.js';
import { describeError, isConnectionLostError, isRetryableStatement } from './recovery.js';

/** 再接続の試行回数と、その間隔（回を追うごとに延ばす）。 */
const RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 300;

export interface ResilientDriverOptions {
  /** 出力チャンネルへの記録。 */
  log(message: string): void;
  /** 再接続に成功した。 */
  onReconnected?(): void;
  /** 再接続に失敗し、接続を諦めた。 */
  onGaveUp?(error: unknown): void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 接続断（`read EADDRNOTAVAIL` など）からの復帰を受け持つ DbDriver のラッパ。
 *
 * 復帰は 2 段構えになっている。
 *
 * 1. 操作を始める前: ソケットが既に死んでいると分かっていれば張り直してから流す。
 *    スリープ復帰や VPN の張り直しで待機中に切れた、という一番よくある形はここで吸収され、
 *    利用者からは何も起きていないように見える。
 * 2. 操作の最中に切れた: 張り直したうえで、読み取り専用と確信できるものだけやり直す。
 *    書き込みは、サーバに届いて実行されたのかどうかが分からないため自動では再送しない
 *    （黙って再送すると二重適用になる）。接続だけ直してエラーを返し、判断を利用者に委ねる。
 */
export class ResilientDriver implements DbDriver {
  private lost = false;
  /** 明示的に閉じた。以後は何があっても張り直さない。 */
  private closed = false;
  private reconnecting: Promise<void> | undefined;
  private readonly lostListener: { dispose(): void };

  constructor(
    private readonly inner: DbDriver,
    private readonly options: ResilientDriverOptions,
  ) {
    this.lostListener = inner.onConnectionLost((error) => {
      this.lost = true;
      this.options.log(`接続が切れました（待機中）: ${describeError(error)}`);
    });
  }

  get kind(): DbKind {
    return this.inner.kind;
  }

  get onConnectionLost(): ConnectionLostEvent {
    return this.inner.onConnectionLost;
  }

  async connect(): Promise<void> {
    await this.inner.connect();
    this.lost = false;
  }

  /**
   * 明示的に閉じる（「切断」・クエリのキャンセル・設定変更）。
   *
   * 閉じたことを先に立てておくのが肝心。実行中の操作は、閉じたことでソケットが死んで
   * 接続断のエラーとして飛んでくる。これを自動復帰と区別しないと、利用者が切ったそばから
   * 張り直してしまい、ツリーは未接続なのにサーバ側のセッションだけ生き続ける。
   */
  async dispose(): Promise<void> {
    this.closed = true;
    this.lostListener.dispose();
    await this.inner.dispose();
  }

  quoteIdent(name: string): string {
    return this.inner.quoteIdent(name);
  }

  buildMutations(
    schema: string,
    table: string,
    muts: RowMutation[],
    columns: ColumnMeta[],
  ): PreparedStatement[] {
    return this.inner.buildMutations(schema, table, muts, columns);
  }

  listSchemas(): Promise<string[]> {
    return this.run('スキーマ一覧の取得', true, () => this.inner.listSchemas());
  }

  listTables(schema: string): Promise<TableMeta[]> {
    return this.run('テーブル一覧の取得', true, () => this.inner.listTables(schema));
  }

  listColumns(schema: string, table: string): Promise<ColumnMeta[]> {
    return this.run('カラム一覧の取得', true, () => this.inner.listColumns(schema, table));
  }

  listIndexes(schema: string, table: string): Promise<IndexMeta[]> {
    return this.run('インデックス一覧の取得', true, () => this.inner.listIndexes(schema, table));
  }

  browse(req: BrowseRequest): Promise<BrowseResult> {
    return this.run('テーブルの読み込み', true, () => this.inner.browse(req));
  }

  countRows(schema: string, table: string, filters: FilterSpec[], where?: string): Promise<number | null> {
    return this.run('行数の取得', true, () => this.inner.countRows(schema, table, filters, where));
  }

  query(sql: string, limit: number): Promise<QueryResult> {
    return this.run('クエリの実行', isRetryableStatement(sql), () => this.inner.query(sql, limit));
  }

  applyMutations(statements: PreparedStatement[]): Promise<number> {
    return this.run('変更の保存', false, () => this.inner.applyMutations(statements));
  }

  /**
   * 接続を確かめてから操作を流す。途中で切れた場合、`retryable` なら 1 度だけやり直す。
   */
  private async run<T>(label: string, retryable: boolean, operation: () => Promise<T>): Promise<T> {
    this.throwIfClosed();
    await this.ensureUsable(label);
    try {
      return await operation();
    } catch (error) {
      if (!isConnectionLostError(error) || this.closed) {
        // 閉じたあとの接続断は、こちらが切った結果なので張り直さずそのまま返す。
        throw error;
      }
      this.lost = true;
      this.options.log(`${label}中に接続が切れました: ${describeError(error)}`);

      if (retryable) {
        await this.reconnect(label);
        return operation();
      }

      // 再接続は済ませておく（次の操作はそのまま通る）が、この操作はやり直さない。
      await this.reconnect(label).catch(() => undefined);
      throw new Error(
        `${describeError(error)}\n接続が切れたため再接続しました。` +
          '反映されたかどうかは分からないため、結果を確かめてから実行し直してください。',
        { cause: error },
      );
    }
  }

  /** 死んでいると分かっている接続を、操作の前に張り直しておく。 */
  private async ensureUsable(label: string): Promise<void> {
    if (this.reconnecting) {
      await this.reconnecting;
    }
    this.throwIfClosed();
    if (this.lost) {
      await this.reconnect(label);
    }
  }

  private throwIfClosed(): void {
    if (this.closed) {
      throw new Error('この接続は切断されています。ツリーから接続し直してください。');
    }
  }

  /** 同時に走る操作が揃って張り直しにいかないよう、1 本にまとめる。 */
  private reconnect(label: string): Promise<void> {
    if (!this.reconnecting) {
      this.reconnecting = this.doReconnect(label).finally(() => {
        this.reconnecting = undefined;
      });
    }
    return this.reconnecting;
  }

  private async doReconnect(label: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS; attempt += 1) {
      this.throwIfClosed();
      await this.inner.dispose().catch(() => undefined);
      try {
        await this.inner.connect();
        // 張り直している最中に切断されたら、開いたばかりの接続をその場で閉じる。
        // 放っておくとツリーからは見えないまま、サーバ側のセッションだけが残る。
        if (this.closed) {
          await this.inner.dispose().catch(() => undefined);
          this.throwIfClosed();
        }
        this.lost = false;
        this.options.log(
          `再接続しました（${label} / ${attempt} 回目）。` +
            'トランザクションや一時テーブルなどのセッション状態は失われています。',
        );
        this.options.onReconnected?.();
        return;
      } catch (error) {
        lastError = error;
        this.options.log(`再接続に失敗しました（${attempt}/${RECONNECT_ATTEMPTS}）: ${describeError(error)}`);
        if (attempt < RECONNECT_ATTEMPTS) {
          await delay(RECONNECT_BASE_DELAY_MS * attempt);
        }
      }
    }
    this.options.onGaveUp?.(lastError);
    throw new Error(`再接続できませんでした: ${describeError(lastError)}`, { cause: lastError });
  }
}
