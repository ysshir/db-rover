/**
 * 接続断からの復帰を判断するための純粋関数。
 *
 * スリープ復帰・VPN の張り直し・Wi-Fi の切り替えでローカルのアドレスが無効になると、
 * 張りっぱなしのソケットは `read EADDRNOTAVAIL` などで死ぬ。放置すると以降のすべての
 * 操作が同じエラーで失敗し続けるため、ここで拾って接続を張り直す（resilient.ts）。
 *
 * vscode に依存させないこと。scripts/check-recovery.mjs が単体ビルドして検証する。
 */

import { classifyStatement } from './statementKind.js';

/** 再接続すれば回復しうる Node のソケットエラー（errno）。 */
const SOCKET_CODES = [
  'EADDRNOTAVAIL', // ローカルアドレスが無くなった（スリープ復帰・VPN 断・NIC 切り替え）
  'ECONNRESET',
  'ECONNABORTED',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'ENOTCONN',
  'ESHUTDOWN',
  'EAI_AGAIN', // 名前解決の一時的な失敗
];

/** mysql2 が接続を捨てたときに付ける code。 */
const MYSQL_CODES = [
  'PROTOCOL_CONNECTION_LOST',
  'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
  'PROTOCOL_ENQUEUE_AFTER_QUIT',
  'PROTOCOL_SEQUENCE_TIMEOUT',
  'ER_CLIENT_INTERACTION_TIMEOUT',
];

/** PostgreSQL の SQLSTATE のうち、接続が落ちたことを表すもの。 */
const POSTGRES_SQLSTATES = [
  '08000', // connection_exception
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  '08P01', // protocol_violation
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
];

const RECOVERABLE_CODES = new Set([...SOCKET_CODES, ...MYSQL_CODES, ...POSTGRES_SQLSTATES]);

/**
 * code を持たないまま飛んでくるものを拾うための文言。
 * pg はソケットが死んだことを Error のメッセージだけで知らせてくることがある。
 */
const RECOVERABLE_MESSAGES = [
  'Connection terminated',
  'Connection ended unexpectedly',
  'Client has encountered a connection error and is not queryable',
  'Client was closed and is not queryable',
  'server closed the connection unexpectedly',
  'terminating connection due to',
  'Can\'t add new command when connection is in closed state',
  'This socket has been ended by the other party',
  'socket hang up',
];

const MAX_CAUSE_DEPTH = 5;

/**
 * 「接続が切れただけで、張り直せば回復しうる」エラーかどうか。
 *
 * 認証エラーや SQL の文法エラーをここに含めないこと。含めると、直らないものを
 * 延々と再接続して叩き続けることになる。
 */
export function isConnectionLostError(error: unknown, depth = 0): boolean {
  if (depth > MAX_CAUSE_DEPTH || typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown };

  if (typeof candidate.code === 'string' && RECOVERABLE_CODES.has(candidate.code.toUpperCase())) {
    return true;
  }
  if (
    typeof candidate.message === 'string' &&
    RECOVERABLE_MESSAGES.some((text) => (candidate.message as string).includes(text))
  ) {
    return true;
  }
  // AggregateError（Happy Eyeballs で複数アドレスに失敗したときなど）
  if (Array.isArray(candidate.errors) && candidate.errors.some((inner) => isConnectionLostError(inner, depth + 1))) {
    return true;
  }
  return isConnectionLostError(candidate.cause, depth + 1);
}

/**
 * 接続が切れたときに、黙って投げ直してよい文かどうか。
 *
 * 途中で切れた文は、サーバ側に届いて実行されたのか分からない。読み取り専用と
 * 確信できるものだけ自動でやり直し、それ以外は利用者に判断を委ねる（二重適用を避ける）。
 * 判定の実体は statementKind.ts の `classifyStatement()` に一本化している
 * （AI 連携の承認判定と意味が完全に一致するため）。
 */
export function isRetryableStatement(sql: string): boolean {
  return classifyStatement(sql) === 'read';
}

/** ログと通知に使う、例外からの短いメッセージ。 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && !error.message.includes(code) ? `${error.message} (${code})` : error.message;
  }
  return String(error);
}
