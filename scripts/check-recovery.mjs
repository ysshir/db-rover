#!/usr/bin/env node
// 接続断の判定（isConnectionLostError / isRetryableStatement）の素朴なユニット検証。
// check-mutations.mjs と同じく、テストフレームワークは使わず esbuild で
// src/drivers/recovery.ts を単体ビルドして Node で直接実行する。

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const entryPoint = path.join(projectRoot, 'src', 'drivers', 'recovery.ts');

const statementKindEntryPoint = path.join(projectRoot, 'src', 'drivers', 'statementKind.ts');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-rover-check-recovery-'));
const outFile = path.join(outDir, 'recovery.mjs');
const statementKindOutFile = path.join(outDir, 'statementKind.mjs');

await esbuild.build({
  entryPoints: [entryPoint],
  bundle: true,
  outfile: outFile,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
});

await esbuild.build({
  entryPoints: [statementKindEntryPoint],
  bundle: true,
  outfile: statementKindOutFile,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
});

const { isConnectionLostError, isRetryableStatement, describeError } = await import(`file://${outFile}`);
const { classifyStatement } = await import(`file://${statementKindOutFile}`);

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
    throw new Error(message || 'assertion failed');
  }
}

/** Node のソケットエラーを模したもの。 */
function socketError(code, syscall = 'read') {
  const error = new Error(`${syscall} ${code}`);
  error.code = code;
  error.errno = -49;
  error.syscall = syscall;
  return error;
}

// --- isConnectionLostError: 拾うべきもの ---

check('read EADDRNOTAVAIL を接続断として拾う', () => {
  assert(isConnectionLostError(socketError('EADDRNOTAVAIL')));
});

check('ECONNRESET / EPIPE / ETIMEDOUT を接続断として拾う', () => {
  for (const code of ['ECONNRESET', 'EPIPE', 'ETIMEDOUT']) {
    assert(isConnectionLostError(socketError(code)), code);
  }
});

check('mysql2 の PROTOCOL_CONNECTION_LOST を拾う', () => {
  const error = new Error('Connection lost: The server closed the connection.');
  error.code = 'PROTOCOL_CONNECTION_LOST';
  error.fatal = true;
  assert(isConnectionLostError(error));
});

check('PostgreSQL の SQLSTATE 57P01 を拾う', () => {
  const error = new Error('terminating connection due to administrator command');
  error.code = '57P01';
  assert(isConnectionLostError(error));
});

check('code を持たない pg のメッセージだけのエラーを拾う', () => {
  assert(isConnectionLostError(new Error('Connection terminated unexpectedly')));
  assert(isConnectionLostError(new Error('Client has encountered a connection error and is not queryable')));
});

check('cause の奥にある接続断を拾う', () => {
  const wrapped = new Error('query failed', { cause: socketError('EADDRNOTAVAIL') });
  assert(isConnectionLostError(wrapped));
});

check('AggregateError の中の接続断を拾う', () => {
  const aggregate = new AggregateError([socketError('ECONNREFUSED'), socketError('EHOSTUNREACH')], 'all failed');
  assert(isConnectionLostError(aggregate));
});

// --- isConnectionLostError: 拾ってはいけないもの ---

check('認証エラーは接続断として扱わない', () => {
  const error = new Error("Access denied for user 'app'@'localhost'");
  error.code = 'ER_ACCESS_DENIED_ERROR';
  error.fatal = true;
  assert(!isConnectionLostError(error), '再接続しても直らないものを拾ってはいけない');
});

check('SQL の文法エラーは接続断として扱わない', () => {
  const error = new Error('syntax error at or near "slect"');
  error.code = '42601';
  assert(!isConnectionLostError(error));
});

check('文字列・null・undefined で落ちない', () => {
  assert(!isConnectionLostError('EADDRNOTAVAIL'));
  assert(!isConnectionLostError(null));
  assert(!isConnectionLostError(undefined));
});

check('cause が循環していても止まる', () => {
  const a = new Error('a');
  const b = new Error('b', { cause: a });
  a.cause = b;
  assert(!isConnectionLostError(a));
});

// --- isRetryableStatement ---

check('SELECT はやり直してよい', () => {
  assert(isRetryableStatement('SELECT * FROM users'));
  assert(isRetryableStatement('  select 1 '));
  assert(isRetryableStatement('SHOW TABLES'));
  assert(isRetryableStatement('EXPLAIN SELECT * FROM users'));
  assert(isRetryableStatement('PRAGMA table_info(users)'));
});

check('INSERT / UPDATE / DELETE はやり直さない', () => {
  assert(!isRetryableStatement('INSERT INTO users (name) VALUES (?)'));
  assert(!isRetryableStatement('UPDATE users SET name = ?'));
  assert(!isRetryableStatement('DELETE FROM users WHERE id = 1'));
  assert(!isRetryableStatement('CREATE TABLE t (id int)'));
  assert(!isRetryableStatement('BEGIN'));
});

check('読み取りの顔をした CTE の書き込みはやり直さない', () => {
  assert(!isRetryableStatement('WITH moved AS (DELETE FROM a RETURNING *) INSERT INTO b SELECT * FROM moved'));
  assert(isRetryableStatement('WITH recent AS (SELECT * FROM logs) SELECT * FROM recent'));
});

check('文字列リテラルやコメントの中の書き込みキーワードに惑わされない', () => {
  assert(isRetryableStatement("SELECT * FROM t WHERE memo = 'insert into x'"));
  assert(isRetryableStatement('SELECT * FROM t -- update しない\n'));
  assert(isRetryableStatement('SELECT * FROM t /* delete ではない */'));
});

check('列名やテーブル名に含まれる書き込みキーワードでは弾かれない', () => {
  assert(isRetryableStatement('SELECT updated_at FROM insert_log'));
});

check('空文はやり直さない', () => {
  assert(!isRetryableStatement(''));
  assert(!isRetryableStatement('   -- コメントだけ'));
});

// --- classifyStatement との一本化（リグレッション検知） ---

check('isRetryableStatement は classifyStatement(sql) === \'read\' と常に一致する', () => {
  const samples = [
    'SELECT * FROM users',
    '  select 1 ',
    'SHOW TABLES',
    'EXPLAIN SELECT * FROM users',
    'PRAGMA table_info(users)',
    'INSERT INTO users (name) VALUES (?)',
    'UPDATE users SET name = ?',
    'UPDATE users SET name = ? WHERE id = 1',
    'DELETE FROM users WHERE id = 1',
    'DELETE FROM users',
    'CREATE TABLE t (id int)',
    'DROP TABLE users',
    'TRUNCATE TABLE users',
    'ALTER TABLE t DROP COLUMN c',
    'BEGIN',
    'WITH moved AS (DELETE FROM a RETURNING *) INSERT INTO b SELECT * FROM moved',
    'WITH recent AS (SELECT * FROM logs) SELECT * FROM recent',
    "SELECT * FROM t WHERE memo = 'insert into x'",
    'SELECT * FROM t -- update しない\n',
    'SELECT * FROM t /* delete ではない */',
    'SELECT updated_at FROM insert_log',
    '',
    '   -- コメントだけ',
  ];
  for (const sql of samples) {
    assert(
      isRetryableStatement(sql) === (classifyStatement(sql) === 'read'),
      `不一致: ${JSON.stringify(sql)} isRetryableStatement=${isRetryableStatement(sql)} classifyStatement=${classifyStatement(sql)}`,
    );
  }
});

// --- describeError ---

check('describeError は code を添える', () => {
  assert(describeError(socketError('EADDRNOTAVAIL')) === 'read EADDRNOTAVAIL', describeError(socketError('EADDRNOTAVAIL')));
  const error = new Error('切れました');
  error.code = 'ECONNRESET';
  assert(describeError(error) === '切れました (ECONNRESET)');
  assert(describeError('文字列') === '文字列');
});

fs.rmSync(outDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} 件失敗しました`);
  process.exit(1);
}
console.log('\nすべて成功しました');
