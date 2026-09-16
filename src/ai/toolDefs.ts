/**
 * AI（MCP / Language Model Tool）に公開する 4 つのツールの定義（名前・説明・入力スキーマ）と
 * 入力検証。MCP の tools/list と package.json の contributes.languageModelTools.inputSchema は
 * ここの内容と一致させる（スキーマの実体はここだけに置く）。
 *
 * vscode に依存させないこと。他の src/ai の純粋モジュールと同様、単体ビルドして検証できる状態を保つ。
 */

export type AiToolName =
  | 'dbrover_list_connections'
  | 'dbrover_list_tables'
  | 'dbrover_describe_table'
  | 'dbrover_run_sql';

export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDef {
  name: AiToolName;
  description: string;
  inputSchema: JsonSchema;
}

export interface ListConnectionsInput {
  readonly _tag: 'dbrover_list_connections';
}

export interface ListTablesInput {
  readonly _tag: 'dbrover_list_tables';
  connectionId: string;
  schema?: string;
}

export interface DescribeTableInput {
  readonly _tag: 'dbrover_describe_table';
  connectionId: string;
  table: string;
  schema?: string;
}

export interface RunSqlInput {
  readonly _tag: 'dbrover_run_sql';
  connectionId: string;
  sql: string;
  maxRows?: number;
}

export type ToolInput = ListConnectionsInput | ListTablesInput | DescribeTableInput | RunSqlInput;

const CONNECTION_ID_PROPERTY = {
  type: 'string',
  description: '対象の接続 ID。dbrover_list_connections で取得したものを渡してください。',
};

const SCHEMA_PROPERTY = {
  type: 'string',
  description: '対象スキーマ名（省略時は既定のスキーマ／データベース全体を対象にする）。',
};

export const TOOL_DEFS: readonly ToolDef[] = [
  {
    name: 'dbrover_list_connections',
    description:
      'DB Rover で現在「接続中」の接続だけを一覧します。未接続の接続は含まれません。' +
      'ここで得た connectionId を他のツールに渡してください。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'dbrover_list_tables',
    description:
      '指定した接続内のテーブル・ビュー一覧をスキーマごとに返します。' +
      'connectionId は dbrover_list_connections で取得してください。',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: CONNECTION_ID_PROPERTY,
        schema: SCHEMA_PROPERTY,
      },
      required: ['connectionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'dbrover_describe_table',
    description:
      '指定したテーブルの列定義（columns）とインデックス（indexes）を返します。' +
      'サンプル行など実データは含みません。connectionId は dbrover_list_connections で取得してください。',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: CONNECTION_ID_PROPERTY,
        table: { type: 'string', description: 'テーブル名（スキーマ修飾なし）。' },
        schema: SCHEMA_PROPERTY,
      },
      required: ['connectionId', 'table'],
      additionalProperties: false,
    },
  },
  {
    name: 'dbrover_run_sql',
    description:
      'DB Rover で接続中のデータベースに SQL を実行します。読み取り以外の文はユーザーの承認が必要です。' +
      '取り消せない文（DROP / TRUNCATE / WHERE 無しの DELETE・UPDATE 等）は毎回確認されます。' +
      '接続 ID は dbrover_list_connections で取得してください。',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: CONNECTION_ID_PROPERTY,
        sql: { type: 'string', description: '実行する SQL。`;` 区切りで複数文を渡せます。' },
        maxRows: {
          type: 'number',
          description: '返す最大行数（既定 200、上限 1000）。',
        },
      },
      required: ['connectionId', 'sql'],
      additionalProperties: false,
    },
  },
];

export function getToolDef(name: string): ToolDef | undefined {
  return TOOL_DEFS.find((def) => def.name === name);
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${key} は必須の文字列です。`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${key} は文字列で指定してください。`);
  }
  return value;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${key} は数値で指定してください。`);
  }
  return value;
}

/**
 * ツール名と生の引数（JSON から来た unknown）を検証し、型付きの入力に変換する。
 * 未知のツール名・型の合わない引数は Error を投げる（呼び出し側で isError に変換すること）。
 */
export function validateInput(name: string, rawArgs: unknown): ToolInput {
  const args = (rawArgs && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {}) ?? {};

  switch (name) {
    case 'dbrover_list_connections':
      return { _tag: 'dbrover_list_connections' };
    case 'dbrover_list_tables':
      return {
        _tag: 'dbrover_list_tables',
        connectionId: requireString(args, 'connectionId'),
        schema: optionalString(args, 'schema'),
      };
    case 'dbrover_describe_table':
      return {
        _tag: 'dbrover_describe_table',
        connectionId: requireString(args, 'connectionId'),
        table: requireString(args, 'table'),
        schema: optionalString(args, 'schema'),
      };
    case 'dbrover_run_sql':
      return {
        _tag: 'dbrover_run_sql',
        connectionId: requireString(args, 'connectionId'),
        sql: requireString(args, 'sql'),
        maxRows: optionalNumber(args, 'maxRows'),
      };
    default:
      throw new Error(`未知のツールです: ${name}`);
  }
}
