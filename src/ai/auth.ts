/**
 * MCP HTTP サーバ（src/ai/mcpHttp.ts）が使う、トークン抽出と多層ガードの純粋関数。
 *
 * サーバは loopback にのみ bind した上で、ここの判定を「remoteAddress → Host → Origin →
 * トークン」の順に重ねて外部からのアクセスと DNS リバインディングを弾く。
 *
 * vscode に依存させないこと。scripts/check-ai-auth.mjs が単体ビルドして検証する。
 */

import { timingSafeEqual } from 'node:crypto';

/** `/mcp/<token>` のパスからトークンを取り出す。一致しなければ undefined。 */
export function extractTokenFromPath(pathname: string): string | undefined {
  const match = /^\/mcp\/([^/]+)\/?$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
}

/** `Authorization: Bearer <token>` ヘッダからトークンを取り出す。 */
export function extractTokenFromHeader(authorizationHeader: string | undefined | null): string | undefined {
  if (!authorizationHeader) {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim());
  return match ? match[1].trim() : undefined;
}

/** パス埋め込みを優先し、無ければ Authorization ヘッダから取り出す。両方無ければ undefined。 */
export function extractToken(
  pathname: string,
  authorizationHeader: string | undefined | null,
): string | undefined {
  return extractTokenFromPath(pathname) ?? extractTokenFromHeader(authorizationHeader);
}

/** タイミング攻撃を避けるための定数時間比較。長さが違う時点で false を返す。 */
export function tokensEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) {
    return false;
  }
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** リクエストの送信元アドレスが loopback かどうか。 */
export function isLoopbackAddress(remoteAddress: string | undefined | null): boolean {
  if (!remoteAddress) {
    return false;
  }
  return LOOPBACK_ADDRESSES.has(remoteAddress);
}

/**
 * Host ヘッダが `127.0.0.1:<port>` / `localhost:<port>` のどちらかと一致するか。
 * DNS リバインディング対策として MCP 仕様が必須にしている検査。
 */
export function isAllowedHost(hostHeader: string | undefined | null, port: number): boolean {
  if (!hostHeader) {
    return false;
  }
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return allowed.has(hostHeader.trim());
}

const ALLOWED_ORIGIN_PREFIXES = ['vscode-file://', 'vscode-webview://'];
const ALLOWED_ORIGIN_HOST_PATTERN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i;

/**
 * Origin ヘッダの許可判定。ヘッダが無ければ許可する（外部 AI の CLI は Origin を送らないため。
 * その場合もトークン検証は別途必須）。
 */
export function isAllowedOrigin(originHeader: string | undefined | null): boolean {
  if (!originHeader) {
    return true;
  }
  const origin = originHeader.trim();
  if (ALLOWED_ORIGIN_PREFIXES.some((prefix) => origin.startsWith(prefix))) {
    return true;
  }
  return ALLOWED_ORIGIN_HOST_PATTERN.test(origin);
}
