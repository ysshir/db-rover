/**
 * MCP (Model Context Protocol) の JSON-RPC 2.0 層。
 *
 * HTTP との結線（ポート・ヘッダ検査・ソケット管理）は src/ai/mcpHttp.ts が担い、
 * ここでは「ボディ文字列を解釈する → メソッドごとに振り分ける → 応答を組み立てる」だけを行う。
 * `tools/list` / `tools/call` の実処理はハンドラとして呼び出し側が注入する（Dependency Injection）。
 *
 * vscode に依存させないこと。scripts/check-mcp-rpc.mjs が単体ビルドして検証する。
 */

export const JSON_RPC_VERSION = '2.0';

/** JSON-RPC 2.0 の標準エラーコード。 */
export const RPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/** これまでに実装したことのある MCP のプロトコルバージョン。 */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const DEFAULT_PROTOCOL_VERSION: (typeof SUPPORTED_PROTOCOL_VERSIONS)[number] = '2025-06-18';

export type RpcId = string | number | null;

export interface RpcRequest {
  jsonrpc: '2.0';
  id?: RpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcSuccess {
  jsonrpc: '2.0';
  id: RpcId;
  result: unknown;
}

export interface RpcError {
  jsonrpc: '2.0';
  id: RpcId;
  error: { code: number; message: string; data?: unknown };
}

export type RpcResponse = RpcSuccess | RpcError;

/** `tools/list` が返すツール 1 件分。 */
export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** `tools/call` の実処理の結果。ツール側のエラーも JSON-RPC エラーにはせず、ここに詰める。 */
export interface McpToolResult {
  isError: boolean;
  text: string;
}

export interface RpcHandlers {
  listTools: () => McpToolDescriptor[];
  callTool: (name: string, args: unknown) => Promise<McpToolResult> | McpToolResult;
}

function errorResponse(id: RpcId, code: number, message: string, data?: unknown): RpcError {
  const error: RpcError['error'] = { code, message };
  if (data !== undefined) {
    error.data = data;
  }
  return { jsonrpc: JSON_RPC_VERSION, id, error };
}

/**
 * POST ボディの生テキストを JSON として解釈する。
 * 壊れた JSON は Parse error、配列（バッチリクエスト）は Invalid Request として拒否する
 * （本サーバはバッチに対応しない）。
 */
export function parseRpcMessage(
  rawBody: string,
): { ok: true; message: unknown } | { ok: false; response: RpcResponse } {
  let parsed: unknown;
  try {
    parsed = rawBody.trim() === '' ? undefined : JSON.parse(rawBody);
  } catch {
    return { ok: false, response: errorResponse(null, RPC_ERROR.PARSE_ERROR, 'JSON の解釈に失敗しました') };
  }
  if (Array.isArray(parsed)) {
    return {
      ok: false,
      response: errorResponse(null, RPC_ERROR.INVALID_REQUEST, 'バッチリクエストには対応していません'),
    };
  }
  return { ok: true, message: parsed };
}

function isValidRequest(message: unknown): message is RpcRequest {
  if (typeof message !== 'object' || message === null) {
    return false;
  }
  const candidate = message as Record<string, unknown>;
  return candidate.jsonrpc === JSON_RPC_VERSION && typeof candidate.method === 'string';
}

/** 通知（id を持たないリクエスト）は応答を返さない約束なので、送信側で判別に使う。 */
export function isNotification(message: RpcRequest): boolean {
  return message.id === undefined;
}

/** クライアントが要求したプロトコルバージョンを既知のものと突き合わせる。未知なら既定へ倒す。 */
export function negotiateProtocolVersion(requested: unknown): string {
  if (
    typeof requested === 'string' &&
    (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
  ) {
    return requested;
  }
  return DEFAULT_PROTOCOL_VERSION;
}

/**
 * 1 件のリクエスト/通知を処理する。通知（id 無し）には常に `undefined` を返す。
 * 呼び出し側（mcpHttp.ts）は `undefined` のとき 202、それ以外は 200 + JSON を返すこと。
 */
export async function handleRpcMessage(
  message: unknown,
  handlers: RpcHandlers,
): Promise<RpcResponse | undefined> {
  if (!isValidRequest(message)) {
    return errorResponse(null, RPC_ERROR.INVALID_REQUEST, '不正なリクエストです');
  }

  const isNotify = message.id === undefined;
  const id: RpcId = message.id ?? null;

  switch (message.method) {
    case 'initialize': {
      const params = (message.params ?? {}) as { protocolVersion?: unknown };
      const protocolVersion = negotiateProtocolVersion(params.protocolVersion);
      if (isNotify) {
        return undefined;
      }
      return {
        jsonrpc: JSON_RPC_VERSION,
        id,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'db-rover', version: '0.2.0' },
        },
      };
    }

    case 'notifications/initialized':
      // 通知専用のメソッド。id が付いていても応答は返さない。
      return undefined;

    case 'ping':
      if (isNotify) {
        return undefined;
      }
      return { jsonrpc: JSON_RPC_VERSION, id, result: {} };

    case 'tools/list': {
      if (isNotify) {
        return undefined;
      }
      const tools = handlers.listTools();
      return { jsonrpc: JSON_RPC_VERSION, id, result: { tools } };
    }

    case 'tools/call': {
      const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
      if (typeof params.name !== 'string') {
        return isNotify ? undefined : errorResponse(id, RPC_ERROR.INVALID_PARAMS, 'name は必須です');
      }
      try {
        const toolResult = await handlers.callTool(params.name, params.arguments);
        if (isNotify) {
          return undefined;
        }
        return {
          jsonrpc: JSON_RPC_VERSION,
          id,
          result: {
            content: [{ type: 'text', text: toolResult.text }],
            isError: toolResult.isError,
          },
        };
      } catch (error) {
        // ツール側の例外も JSON-RPC エラーにはせず、isError: true の結果として返す
        // （モデルが自分の間違いとして読み解けるように）。
        if (isNotify) {
          return undefined;
        }
        const text = error instanceof Error ? error.message : String(error);
        return {
          jsonrpc: JSON_RPC_VERSION,
          id,
          result: { content: [{ type: 'text', text }], isError: true },
        };
      }
    }

    default:
      return isNotify
        ? undefined
        : errorResponse(id, RPC_ERROR.METHOD_NOT_FOUND, `未知のメソッドです: ${message.method}`);
  }
}
