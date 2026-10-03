#!/usr/bin/env node
// openSqliteBackend（SQLite の実装切り替え）の素朴な検証。
// 他の check-*.mjs と同じく、テストフレームワークは使わず esbuild で
// src/drivers/sqliteBackend.ts を単体ビルドして Node で直接実行する。
// 拡張機能本体と同じく cjs でビルドする（esm だと require('node:sqlite') が解決できず wasm 側に落ちるため）。

import * as esbuild from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const entryPoint = path.join(projectRoot, 'src', 'drivers', 'sqliteBackend.ts');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-rover-check-sqlite-backend-'));
// 外部パッケージ（node-sqlite3-wasm）を解決できるよう、バンドル自体はプロジェクト配下に置く
const bundleDir = path.join(projectRoot, 'node_modules', '.cache', 'db-rover-check');
fs.mkdirSync(bundleDir, { recursive: true });
const outFile = path.join(bundleDir, 'sqliteBackend.cjs');

await esbuild.build({
  entryPoints: [entryPoint],
  bundle: true,
  outfile: outFile,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  packages: 'external',
});

const require = createRequire(path.join(projectRoot, 'package.json'));
const { openSqliteBackend, isWalDatabaseFile } = require(outFile);

let failures = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`PASS: ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL: ${label}`);
    console.error(`  ${error instanceof Error ? error.stack : error}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

const hasNodeSqlite = (() => {
  try {
    require('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

const walFile = path.join(outDir, 'wal.sqlite');
const deleteFile = path.join(outDir, 'delete.sqlite');

check('WAL モードの DB を作り、ヘッダから WAL と判定できる', () => {
  const db = openSqliteBackend(walFile);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, flag INTEGER)');
  db.close();
  assert(isWalDatabaseFile(walFile), 'WAL と判定されなかった');
});

check('DELETE モードの DB は WAL と判定しない', () => {
  const db = openSqliteBackend(deleteFile);
  db.exec('CREATE TABLE t (id INTEGER)');
  db.close();
  assert(!isWalDatabaseFile(deleteFile), 'DELETE モードなのに WAL と判定された');
});

check('存在しないファイル・SQLite 以外のファイルは WAL と判定しない', () => {
  assert(!isWalDatabaseFile(path.join(outDir, 'missing.sqlite')), '存在しないファイルを WAL と判定した');
  const textFile = path.join(outDir, 'text.txt');
  fs.writeFileSync(textFile, 'hello world, this is not sqlite');
  assert(!isWalDatabaseFile(textFile), 'テキストファイルを WAL と判定した');
});

if (hasNodeSqlite) {
  check('node:sqlite がある環境では node:sqlite で開く', () => {
    const db = openSqliteBackend(walFile);
    assert(db.engine === 'node:sqlite', `engine が ${db.engine}`);
    db.close();
  });

  check('WAL モードの DB でテーブル一覧・書き込み・読み出しができる', () => {
    const db = openSqliteBackend(walFile);
    const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name);
    assert(tables.includes('items'), `テーブルが見えない: ${tables.join(',')}`);
    // boolean / undefined も SQLite の表現（1/0, NULL）に寄せてバインドできること
    const result = db.run('INSERT INTO items (name, flag) VALUES (?, ?)', ['a', true]);
    assert(result.changes === 1, `changes が ${result.changes}`);
    db.run('INSERT INTO items (name, flag) VALUES (?, ?)', [undefined, false]);
    const rows = db.all('SELECT name, flag FROM items ORDER BY id');
    assert(rows.length === 2 && rows[0].flag === 1 && rows[1].flag === 0 && rows[1].name === null, JSON.stringify(rows));
    const one = db.get('SELECT COUNT(*) AS cnt FROM items WHERE flag = ?', [1]);
    assert(Number(one.cnt) === 1, JSON.stringify(one));
    assert(db.get('SELECT * FROM items WHERE id = ?', [999]) === null, '該当なしで null にならない');
    db.close();
  });
} else {
  console.log('SKIP: この Node には node:sqlite が無いため、node:sqlite 経路の検証を省略しました');
}

check('DELETE モードの DB はどちらの実装でも読める', () => {
  const db = openSqliteBackend(deleteFile);
  const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name);
  assert(tables.includes('t'), `テーブルが見えない: ${tables.join(',')}`);
  db.close();
});

fs.rmSync(outDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} 件の検証に失敗しました。`);
  process.exit(1);
}
console.log('\nすべての検証に成功しました。');
