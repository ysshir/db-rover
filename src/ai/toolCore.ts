import * as vscode from 'vscode';
import type { DbDriver } from '../drivers/driver.js';
import { classifyStatement, type StatementKind } from '../drivers/statementKind.js';
import type { ConnectionManager } from '../connections/manager.js';
import { getConnectionById, getConnections } from '../connections/store.js';
import { splitSqlStatements } from '../query/splitStatements.js';
import { runStatements } from '../query/runner.js';
import type { QueryResultView } from '../query/resultView.js';
import type { AiCaller, AiConnectionInfo, ConnectionConfig, StatementOutcome } from '../types.js';
import { ApprovalGate } from './approval.js';
import { AuditLog } from './audit.js';
import { buildRunSqlPayload, clampMaxRows, MAX_CELL_CHARS, serializePayload } from './limits.js';
import { validateInput, type ToolInput } from './toolDefs.js';

export interface AiToolCallInput {
  caller: AiCaller;
  name: string;
  args: unknown;
}

export interface AiToolCallResult {
  isError: boolean;
  text: string;
}

/**
 * AI（MCP / Language Model Tool）に公開する 4 ツールの実体層。
 *
 * driver の取得は `requireDriver()` の 1 箇所に閉じ込め、`ensureConnected` / `connect` /
 * `getPassword` / `showInputBox` は絶対に呼ばない（`manager.getDriver()` のみ使う）。
 *
 * `call()` は必ず try/catch で包み、例外を外へ投げず `{ isError: true, text }` に変換する。
 */
export class AiToolCore implements vscode.Disposable {
  private busyCount = 0;
  private readonly onDidChangeBusyEmitter = new vscode.EventEmitter<boolean>();
  readonly onDidChangeBusy = this.onDidChangeBusyEmitter.event;

  constructor(
    private readonly manager: ConnectionManager,
    private readonly approvalGate: ApprovalGate,
    private readonly audit: AuditLog,
    private readonly resultView: QueryResultView,
  ) {}

  async call(input: AiToolCallInput): Promise<AiToolCallResult> {
    this.setBusy(true);
    try {
      const parsed = validateInput(input.name, input.args);
      const text = await this.dispatch(input.caller, parsed);
      return { isError: false, text };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { isError: true, text: message };
    } finally {
      this.setBusy(false);
    }
  }

  private setBusy(busy: boolean): void {
    if (busy) {
      this.busyCount += 1;
      if (this.busyCount === 1) {
        this.onDidChangeBusyEmitter.fire(true);
      }
      return;
    }
    this.busyCount = Math.max(0, this.busyCount - 1);
    if (this.busyCount === 0) {
      this.onDidChangeBusyEmitter.fire(false);
    }
  }

  private async dispatch(caller: AiCaller, input: ToolInput): Promise<string> {
    switch (input._tag) {
      case 'dbrover_list_connections':
        return JSON.stringify(this.listConnections());
      case 'dbrover_list_tables':
        return JSON.stringify(await this.listTables(input.connectionId, input.schema));
      case 'dbrover_describe_table':
        return JSON.stringify(await this.describeTable(input.connectionId, input.table, input.schema));
      case 'dbrover_run_sql':
        return await this.runSql(caller, input.connectionId, input.sql, input.maxRows);
      default: {
        const exhaustiveCheck: never = input;
        throw new Error(`未知のツールです: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  }

  /** 接続中の接続だけを一覧する。パスワード（user）と SQLite の絶対パス（file）は含めない。 */
  private listConnections(): AiConnectionInfo[] {
    return getConnections()
      .filter((config) => this.manager.isConnected(config.id))
      .map((config) => ({
        id: config.id,
        name: config.name,
        kind: config.kind,
        database: config.kind === 'sqlite' ? undefined : config.database,
        host: config.kind === 'sqlite' ? undefined : config.host,
      }));
  }

  private async listTables(
    connectionId: string,
    schemaArg: string | undefined,
  ): Promise<Array<{ schema: string; tables: Array<{ name: string; type: string }> }>> {
    const { driver } = this.requireDriver(connectionId);
    const schemas = schemaArg ? [schemaArg] : await driver.listSchemas();
    const results: Array<{ schema: string; tables: Array<{ name: string; type: string }> }> = [];
    for (const schema of schemas) {
      const tables = await driver.listTables(schema);
      results.push({ schema, tables: tables.map((table) => ({ name: table.name, type: table.type })) });
    }
    return results;
  }

  private async describeTable(connectionId: string, table: string, schemaArg: string | undefined) {
    const { driver, config } = this.requireDriver(connectionId);
    const schema = schemaArg ?? (await this.defaultSchema(driver, config));
    const [columns, indexes] = await Promise.all([
      driver.listColumns(schema, table),
      driver.listIndexes(schema, table),
    ]);
    return { schema, table, columns, indexes };
  }

  /** schema を明示しなかったときに使う既定スキーマ。sqlite は 'main' 固定。 */
  private async defaultSchema(driver: DbDriver, config: ConnectionConfig): Promise<string> {
    if (config.kind === 'sqlite') {
      return 'main';
    }
    const schemas = await driver.listSchemas();
    if (config.kind === 'mysql' && config.database && schemas.includes(config.database)) {
      return config.database;
    }
    if (schemas.includes('public')) {
      return 'public';
    }
    return schemas[0] ?? 'public';
  }

  private async runSql(
    caller: AiCaller,
    connectionId: string,
    sql: string,
    maxRowsArg: number | undefined,
  ): Promise<string> {
    const { config } = this.requireDriver(connectionId);
    const aiConfig = vscode.workspace.getConfiguration('dbRover');
    const maxStatements = aiConfig.get<number>('ai.maxStatements', 10);
    const maxRows = clampMaxRows(maxRowsArg, aiConfig.get<number>('ai.maxRows', 200));
    const timeoutMs = aiConfig.get<number>('ai.timeoutMs', 30000);
    const showResults = aiConfig.get<boolean>('ai.showResults', true);

    const statements = splitSqlStatements(sql, config.kind);
    if (statements.length === 0) {
      throw new Error('実行できる SQL 文がありません。');
    }
    if (statements.length > maxStatements) {
      throw new Error(`文の数が上限（${maxStatements}）を超えています（${statements.length} 文）。`);
    }

    const kinds = statements.map((statement) => classifyStatement(statement.sql));
    const kindSummary = summarizeKinds(kinds);

    this.audit.request(
      caller,
      'dbrover_run_sql',
      `接続=${config.name} (${config.kind}) 判定=${kindSummary} 文数=${statements.length}`,
      sql,
    );

    const decision = this.approvalGate.decide(connectionId, kinds);
    if (decision === 'deny') {
      this.audit.approval(caller, 'dbrover_run_sql', '却下されました（設定 dbRover.ai.writes により拒否）');
      throw new Error('この接続は書き込みが許可されていません（設定 dbRover.ai.writes）。');
    }
    if (decision === 'ask') {
      this.audit.approval(caller, 'dbrover_run_sql', `承認待ち 判定=${kindSummary} 接続=${config.name}`);
      const approved = await this.approvalGate.confirm({ connectionId, connectionName: config.name, caller, kinds, sql });
      if (!approved) {
        this.audit.approval(caller, 'dbrover_run_sql', '却下されました（ユーザーがキャンセル）');
        throw new Error('ユーザーが実行を承認しませんでした。');
      }
    }

    let outcomes: StatementOutcome[];
    try {
      outcomes = await this.runWithTimeout(connectionId, statements, maxRows, timeoutMs, config.name);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.audit.failure(caller, 'dbrover_run_sql', message);
      throw error;
    }

    if (showResults) {
      await this.resultView.show(`${config.name}（AI）`, outcomes);
    }

    const failed = outcomes.find((outcome) => outcome.status === 'error');
    if (failed) {
      this.audit.failure(caller, 'dbrover_run_sql', failed.message ?? '不明なエラー');
    } else {
      const totalRows = outcomes.reduce((sum, outcome) => sum + (outcome.result?.rowCount ?? 0), 0);
      const totalDurationMs = outcomes.reduce((sum, outcome) => sum + (outcome.result?.durationMs ?? 0), 0);
      this.audit.success(caller, 'dbrover_run_sql', `${totalRows} 行 / ${totalDurationMs}ms`);
    }

    const payload = buildRunSqlPayload(outcomes, MAX_CELL_CHARS);
    return serializePayload(payload);
  }

  /**
   * タイムアウトを超えたら、まだ実行中のクエリを待たずに接続を切る
   * （src/query/runner.ts のキャンセル処理と同じ流儀）。ユーザーには通知し、AI にはエラーを返す。
   */
  private async runWithTimeout(
    connectionId: string,
    statements: { sql: string; start: number }[],
    maxRows: number,
    timeoutMs: number,
    connectionName: string,
  ): Promise<StatementOutcome[]> {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(new Error(`実行が ${timeoutMs}ms を超えたため接続を切断しました。`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([
        runStatements(
          this.manager,
          connectionId,
          statements,
          maxRows,
          true,
          'DB Rover: AI からの SQL を実行しています…',
        ),
        timeoutPromise,
      ]);
    } catch (error) {
      if (timedOut) {
        await this.manager.disconnect(connectionId);
        void vscode.window.showWarningMessage(
          `DB Rover: AI からの SQL 実行がタイムアウトしたため「${connectionName}」を切断しました。ツリーから接続し直してください。`,
        );
      }
      throw error;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /** driver の取得はここに閉じ込める。`ensureConnected` は使わず `manager.getDriver()` のみを使う。 */
  private requireDriver(connectionId: string): { driver: DbDriver; config: ConnectionConfig } {
    const config = getConnectionById(connectionId);
    const name = config?.name ?? connectionId;
    const driver = this.manager.getDriver(connectionId);
    if (!driver) {
      throw new Error(`接続「${name}」は接続されていません。DB Rover のツリーから接続してください。`);
    }
    return { driver, config: config ?? { id: connectionId, name, kind: driver.kind } };
  }

  dispose(): void {
    this.onDidChangeBusyEmitter.dispose();
  }
}

/** 複数文の中で最も強い（承認が必要な側の）分類を代表値として返す。 */
function summarizeKinds(kinds: readonly StatementKind[]): StatementKind {
  if (kinds.includes('destructive')) {
    return 'destructive';
  }
  if (kinds.includes('write')) {
    return 'write';
  }
  return 'read';
}
