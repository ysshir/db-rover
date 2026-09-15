import * as vscode from 'vscode';
import type { ConnectionManager } from '../connections/manager.js';
import type { QueryResult, StatementOutcome } from '../types.js';

/**
 * クエリを実行する。実行中はキャンセル可能な進捗通知を表示し、
 * キャンセルされた場合は接続を破棄して実行を打ち切る。
 */
export async function runQuery(
  manager: ConnectionManager,
  connectionId: string,
  sql: string,
  limit: number,
): Promise<QueryResult> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'DB Rover: クエリを実行しています…',
      cancellable: true,
    },
    async (_progress, token) => {
      const driver = manager.getDriver(connectionId);
      if (!driver) {
        throw new Error('接続されていません。ツリーから接続してください。');
      }
      const cancelListener = token.onCancellationRequested(() => {
        void manager.disconnect(connectionId);
      });
      try {
        return await driver.query(sql, limit);
      } finally {
        cancelListener.dispose();
      }
    },
  );
}

/**
 * 複数の文を先頭から 1 つずつ実行する。
 *
 * ドライバはいずれも複数文の同時実行に対応していない（mysql2 は multipleStatements を
 * 有効にしておらず、pg は最後の結果しか返さず、sqlite は先頭 1 文しか実行しない）ため、
 * 必ず分割してから 1 文ずつ渡す。トランザクションでは包まない（DDL が混ざりうるため、
 * 必要なら利用者が明示的に BEGIN; を書く）。
 */
export async function runStatements(
  manager: ConnectionManager,
  connectionId: string,
  statements: { sql: string; start: number }[],
  limit: number,
  stopOnError: boolean,
): Promise<StatementOutcome[]> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'DB Rover: SQL を実行しています…',
      cancellable: true,
    },
    async (progress, token) => {
      const outcomes: StatementOutcome[] = statements.map((statement, index) => ({
        index,
        sql: statement.sql,
        status: 'skipped',
        startOffset: statement.start,
      }));

      const cancelListener = token.onCancellationRequested(() => {
        void manager.disconnect(connectionId);
      });

      try {
        for (let index = 0; index < statements.length; index += 1) {
          if (token.isCancellationRequested) {
            break;
          }
          if (statements.length > 1) {
            progress.report({ message: `${index + 1}/${statements.length} 文目` });
          }

          const driver = manager.getDriver(connectionId);
          if (!driver) {
            outcomes[index] = {
              ...outcomes[index],
              status: 'error',
              message: '接続されていません。ツリーから接続してください。',
            };
            break;
          }

          try {
            const result = await driver.query(statements[index].sql, limit);
            outcomes[index] = { ...outcomes[index], status: 'ok', result };
          } catch (error) {
            outcomes[index] = {
              ...outcomes[index],
              status: 'error',
              message: error instanceof Error ? error.message : String(error),
            };
            if (stopOnError) {
              break;
            }
          }
        }
      } finally {
        cancelListener.dispose();
      }

      return outcomes;
    },
  );
}
