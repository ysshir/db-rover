import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as vscode from 'vscode';
import type { AiServerStatus } from '../types.js';
import { extractToken, isAllowedHost, isAllowedOrigin, isLoopbackAddress, tokensEqual } from './auth.js';
import { handleRpcMessage, parseRpcMessage, type RpcHandlers } from './mcpRpc.js';

/** ポート探索の範囲（既定ポートから何個先まで試すか）。 */
const PORT_SEARCH_COUNT = 10;
/** ボディの上限（超えたらソケットを破棄する）。 */
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB

export interface McpHttpServerOptions {
  outputChannel: vscode.OutputChannel;
  handlers: RpcHandlers;
  /** 現在有効なトークン。回転に追随できるよう、呼び出しのたびに参照する。 */
  getToken: () => string | undefined;
}

/** dbRover.ai.showStatus / ステータスバーの tooltip に使う状態は src/types.ts の共有型を使う。 */
export type McpServerState = AiServerStatus;

/**
 * localhost にのみ bind する Streamable HTTP の MCP サーバ。
 *
 * 多層ガードは「remoteAddress（loopback）→ Host（DNS リバインディング対策）→ Origin →
 * メソッド（POST のみ）→ ルート/トークン → ボディサイズ」の順に適用する。
 * CORS ヘッダは一切返さない。`/.well-known/...` 等の追加エンドポイントも生やさない。
 */
export class McpHttpServer implements vscode.Disposable {
  private server: http.Server | undefined;
  private port: number | undefined;

  private readonly onDidChangeStateEmitter = new vscode.EventEmitter<McpServerState>();
  readonly onDidChangeState = this.onDidChangeStateEmitter.event;

  constructor(private readonly options: McpHttpServerOptions) {}

  get state(): McpServerState {
    return { running: this.server !== undefined, port: this.port };
  }

  /**
   * 指定ポートから `preferredPort..preferredPort+9` まで 1 つずつ試し、全滅したら
   * エフェメラルポート（0）にフォールバックする。`0` を明示指定したときは常にエフェメラル。
   */
  async start(preferredPort: number): Promise<void> {
    if (this.server) {
      return;
    }

    const candidates =
      preferredPort === 0
        ? [0]
        : Array.from({ length: PORT_SEARCH_COUNT }, (_, index) => preferredPort + index);

    let server: http.Server | undefined;
    for (const candidate of candidates) {
      try {
        server = await this.tryListen(candidate);
        break;
      } catch (error) {
        if (!isPortInUseError(error)) {
          throw error;
        }
      }
    }

    if (!server) {
      this.options.outputChannel.appendLine(
        `[${new Date().toISOString()}] [AI] ポート ${preferredPort}..${preferredPort + PORT_SEARCH_COUNT - 1} がすべて使用中のため、空きポートで起動します。`,
      );
      server = await this.tryListen(0);
    }

    this.server = server;
    server.on('error', (error) => {
      this.options.outputChannel.appendLine(`[${new Date().toISOString()}] [AI] MCP サーバでエラーが発生しました: ${String(error)}`);
    });
    const address = server.address() as AddressInfo;
    this.port = address.port;
    this.onDidChangeStateEmitter.fire(this.state);
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    this.server = undefined;
    this.port = undefined;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.onDidChangeStateEmitter.fire(this.state);
  }

  private tryListen(port: number): Promise<http.Server> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void this.handleRequest(req, res);
      });
      const onError = (error: unknown): void => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        resolve(server);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      this.reject(res, 403, 'Forbidden');
      return;
    }

    const port = this.port;
    if (port === undefined || !isAllowedHost(req.headers.host, port)) {
      this.reject(res, 403, 'Forbidden');
      return;
    }

    if (!isAllowedOrigin(req.headers.origin)) {
      this.reject(res, 403, 'Forbidden');
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname !== '/mcp' && !/^\/mcp\/[^/]+\/?$/.test(url.pathname)) {
      this.reject(res, 404, 'Not Found');
      return;
    }

    const token = extractToken(url.pathname, req.headers.authorization);
    const expected = this.options.getToken();
    if (!tokensEqual(token, expected)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    let body: string;
    try {
      body = await this.readBody(req);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        req.socket.destroy();
        return;
      }
      this.reject(res, 400, 'Bad Request');
      return;
    }

    const parsed = parseRpcMessage(body);
    if (!parsed.ok) {
      this.sendJson(res, 200, parsed.response);
      return;
    }
    const response = await handleRpcMessage(parsed.message, this.options.handlers);
    if (response === undefined) {
      res.writeHead(202, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    this.sendJson(res, 200, response);
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          reject(new BodyTooLargeError());
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', (error) => reject(error));
    });
  }

  private sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(text);
  }

  private reject(res: http.ServerResponse, status: number, message: string): void {
    res.writeHead(status, { 'Cache-Control': 'no-store' });
    res.end(message);
  }

  /** `context.subscriptions` に積む用。`server.closeAllConnections()` → `server.close()` の順で畳む。 */
  async dispose(): Promise<void> {
    await this.stop();
    this.onDidChangeStateEmitter.dispose();
  }
}

class BodyTooLargeError extends Error {}

function isPortInUseError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'EADDRINUSE';
}
