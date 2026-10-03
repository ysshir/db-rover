import * as fs from 'node:fs';
import { Database as WasmDatabase } from 'node-sqlite3-wasm';
import type { BindValues } from 'node-sqlite3-wasm';

/**
 * SQLite の実装差を吸収する薄い層。
 *
 * 優先するのは Node 組み込みの `node:sqlite`。WAL モードの DB（アプリが開発中に使う DB は WAL が多い）を
 * そのまま開けるため。`node-sqlite3-wasm` は共有メモリ（-shm）を扱えず、WAL の DB を開くと
 * 「unable to open database file」になる。
 * `node:sqlite` が無い実行環境（拡張ホストの Node が古い等）では wasm 版にフォールバックする。
 */
export interface SqliteBackend {
  /** どの実装で開いたか（ステータス表示・エラー文言用） */
  readonly engine: 'node:sqlite' | 'wasm';
  all(sql: string, params?: unknown[]): Array<Record<string, unknown>>;
  get(sql: string, params?: unknown[]): Record<string, unknown> | null;
  run(sql: string, params?: unknown[]): { changes: number };
  exec(sql: string): void;
  close(): void;
}

type NodeSqliteModule = typeof import('node:sqlite');

let nodeSqliteCache: NodeSqliteModule | null | undefined;

function loadNodeSqlite(): NodeSqliteModule | null {
  if (nodeSqliteCache !== undefined) {
    return nodeSqliteCache;
  }
  try {
    // 静的 import にすると node:sqlite の無い環境で拡張機能ごと読み込みに失敗するため、実行時に解決する。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    nodeSqliteCache = require('node:sqlite') as NodeSqliteModule;
  } catch {
    nodeSqliteCache = null;
  }
  return nodeSqliteCache;
}

/** node:sqlite はバインド値に boolean / undefined を受け付けないため、SQLite の表現に寄せる */
function toNodeParams(params: unknown[] | undefined): Array<null | number | bigint | string | Uint8Array> {
  return (params ?? []).map((value) => {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value === 'boolean') {
      return value ? 1 : 0;
    }
    if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') {
      return value;
    }
    if (value instanceof Uint8Array) {
      return value;
    }
    return String(value);
  });
}

function openNodeSqlite(mod: NodeSqliteModule, filePath: string): SqliteBackend {
  const db = new mod.DatabaseSync(filePath);
  // アプリ側が書き込み中でもすぐ失敗しないよう、ロック待ちを入れる
  db.exec('PRAGMA busy_timeout = 5000');
  return {
    engine: 'node:sqlite',
    all: (sql, params) => db.prepare(sql).all(...toNodeParams(params)) as Array<Record<string, unknown>>,
    get: (sql, params) => (db.prepare(sql).get(...toNodeParams(params)) as Record<string, unknown> | undefined) ?? null,
    run: (sql, params) => {
      const result = db.prepare(sql).run(...toNodeParams(params));
      return { changes: Number(result.changes) };
    },
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  };
}

function openWasm(filePath: string): SqliteBackend {
  const db = new WasmDatabase(filePath);
  return {
    engine: 'wasm',
    all: (sql, params) => db.all(sql, params as unknown as BindValues) as unknown as Array<Record<string, unknown>>,
    get: (sql, params) => db.get(sql, params as unknown as BindValues) as Record<string, unknown> | null,
    run: (sql, params) => ({ changes: db.run(sql, params as unknown as BindValues).changes }),
    exec: (sql) => db.exec(sql),
    close: () => db.close(),
  };
}

/** ファイルヘッダの 18〜19 バイト目が 2 なら WAL モード（SQLite のファイル形式仕様） */
export function isWalDatabaseFile(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const header = Buffer.alloc(20);
      const read = fs.readSync(fd, header, 0, 20, 0);
      return read === 20 && header.subarray(0, 16).toString('latin1') === 'SQLite format 3\u0000' && header[18] === 2;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

export function openSqliteBackend(filePath: string): SqliteBackend {
  const nodeSqlite = loadNodeSqlite();
  if (nodeSqlite) {
    return openNodeSqlite(nodeSqlite, filePath);
  }
  try {
    return openWasm(filePath);
  } catch (error) {
    if (isWalDatabaseFile(filePath)) {
      throw new Error(
        'この SQLite ファイルは WAL モードのため開けません。拡張ホストの Node.js に node:sqlite が無く、' +
          'WAL 非対応の wasm 版で開こうとしました。Node.js 22.13 以上の環境（VS Code の更新）で開くか、' +
          '対象の DB で `PRAGMA journal_mode = DELETE;` を実行してください。',
      );
    }
    throw error;
  }
}
