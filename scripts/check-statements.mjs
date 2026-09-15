#!/usr/bin/env node
// splitSqlStatements の素朴なユニット検証。
// check-mutations.mjs と同じく、テストフレームワークは使わず esbuild で
// src/query/splitStatements.ts を単体ビルドして Node で直接実行する。

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const entryPoint = path.join(projectRoot, 'src', 'query', 'splitStatements.ts');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-rover-check-stmt-'));
const outFile = path.join(outDir, 'splitStatements.mjs');

await esbuild.build({
  entryPoints: [entryPoint],
  bundle: true,
  outfile: outFile,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
});

const { splitSqlStatements, statementAtOffset, nearestStatement } = await import(`file://${outFile}`);

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

function assertSql(text, kind, expected) {
  const actual = splitSqlStatements(text, kind).map((s) => s.sql);
  assert(
    actual.length === expected.length && actual.every((sql, i) => sql === expected[i]),
    `期待: ${JSON.stringify(expected)}\n  実際: ${JSON.stringify(actual)}`,
  );
}

check('基本: ; で分割する', () => {
  assertSql('SELECT 1; SELECT 2;', 'postgres', ['SELECT 1', 'SELECT 2']);
});

check('末尾に ; が無くても最後の文を拾う', () => {
  assertSql('SELECT 1;\nSELECT 2', 'postgres', ['SELECT 1', 'SELECT 2']);
});

check('空文（;; や空白のみ）は返さない', () => {
  assertSql(';;\n\n SELECT 1 ;;  \n', 'postgres', ['SELECT 1']);
});

check('文字列リテラル中の ; は区切らない', () => {
  assertSql("SELECT ';'; SELECT 2", 'postgres', ["SELECT ';'", 'SELECT 2']);
});

check("'' による引用符エスケープを跨いでも区切らない", () => {
  assertSql("SELECT 'a''; b'; SELECT 2", 'postgres', ["SELECT 'a''; b'", 'SELECT 2']);
});

check('行コメント中の ; は区切らない', () => {
  assertSql('SELECT 1 -- ; コメント\n; SELECT 2', 'postgres', ['SELECT 1 -- ; コメント', 'SELECT 2']);
});

check('ブロックコメント中の ; は区切らない', () => {
  assertSql('SELECT /* ; */ 1; SELECT 2', 'postgres', ['SELECT /* ; */ 1', 'SELECT 2']);
});

check('PostgreSQL の入れ子ブロックコメントを正しく抜ける', () => {
  assertSql('SELECT /* a /* b */ ; */ 1; SELECT 2', 'postgres', ['SELECT /* a /* b */ ; */ 1', 'SELECT 2']);
});

check('先頭のコメントと空白は文の開始に含めない', () => {
  const [first] = splitSqlStatements('-- メモ\n\n  SELECT 1;', 'postgres');
  assert(first.sql === 'SELECT 1', `sql: ${JSON.stringify(first.sql)}`);
  assert(first.start === '-- メモ\n\n  '.length, `start: ${first.start}`);
});

check('start / end が元テキストの該当範囲を指す', () => {
  const text = 'SELECT 1;\nSELECT 2;';
  const statements = splitSqlStatements(text, 'postgres');
  for (const statement of statements) {
    assert(
      text.slice(statement.start, statement.end) === statement.sql,
      `slice が sql と一致しない: ${JSON.stringify(text.slice(statement.start, statement.end))}`,
    );
  }
});

check('MySQL: バッククォート識別子中の ; は区切らない', () => {
  assertSql('SELECT `a;b` FROM t; SELECT 2', 'mysql', ['SELECT `a;b` FROM t', 'SELECT 2']);
});

check('MySQL: バックスラッシュでエスケープされた引用符を跨ぐ', () => {
  assertSql("SELECT 'a\\'; b'; SELECT 2", 'mysql', ["SELECT 'a\\'; b'", 'SELECT 2']);
});

check('PostgreSQL: 標準の文字列ではバックスラッシュはエスケープにならない', () => {
  assertSql("SELECT 'a\\'; SELECT 2", 'postgres', ["SELECT 'a\\'", 'SELECT 2']);
});

check("PostgreSQL: E'...' ではバックスラッシュがエスケープになる", () => {
  assertSql("SELECT E'a\\'; b'; SELECT 2", 'postgres', ["SELECT E'a\\'; b'", 'SELECT 2']);
});

check('PostgreSQL: ドル引用符の中の ; は区切らない', () => {
  assertSql('CREATE FUNCTION f() AS $$ BEGIN; END; $$; SELECT 2', 'postgres', [
    'CREATE FUNCTION f() AS $$ BEGIN; END; $$',
    'SELECT 2',
  ]);
});

check('PostgreSQL: タグ付きドル引用符も扱える', () => {
  assertSql('SELECT $tag$ a; b $tag$; SELECT 2', 'postgres', ['SELECT $tag$ a; b $tag$', 'SELECT 2']);
});

check('SQLite: [識別子] 中の ; は区切らない', () => {
  assertSql('SELECT [a;b] FROM t; SELECT 2', 'sqlite', ['SELECT [a;b] FROM t', 'SELECT 2']);
});

check('閉じられていないリテラルは末尾までを 1 文として扱う', () => {
  assertSql("SELECT 'abc; SELECT 2", 'postgres', ["SELECT 'abc; SELECT 2"]);
});

check('statementAtOffset: カーソル位置の文を返す', () => {
  const text = 'SELECT 1;\nSELECT 2;';
  const statements = splitSqlStatements(text, 'postgres');
  assert(statementAtOffset(statements, 0).sql === 'SELECT 1', '先頭');
  assert(statementAtOffset(statements, 8).sql === 'SELECT 1', '1 文目の末尾');
  assert(statementAtOffset(statements, 12).sql === 'SELECT 2', '2 文目の途中');
  assert(statementAtOffset(statements, text.length).sql === 'SELECT 2', '末尾');
});

check('nearestStatement: 文の内側ならその文', () => {
  const text = 'SELECT 1;\nSELECT 2;';
  const statements = splitSqlStatements(text, 'postgres');
  assert(nearestStatement(statements, 0).sql === 'SELECT 1', '1 文目の先頭');
  assert(nearestStatement(statements, 8).sql === 'SELECT 1', '1 文目の末尾');
  assert(nearestStatement(statements, 12).sql === 'SELECT 2', '2 文目の途中');
  assert(nearestStatement(statements, text.length).sql === 'SELECT 2', '末尾');
});

check('nearestStatement: 文と文の間は近いほうを選ぶ', () => {
  // 'SELECT 1'(0-8) ; 空行 ; 'SELECT 2'
  const text = 'SELECT 1;\n\n\n\n\n\n\n\n\nSELECT 2;';
  const statements = splitSqlStatements(text, 'postgres');
  const gapStart = text.indexOf('\n') + 1; // 1 文目寄り
  const gapEnd = text.indexOf('SELECT 2') - 1; // 2 文目寄り
  assert(nearestStatement(statements, gapStart).sql === 'SELECT 1', `前寄り: ${nearestStatement(statements, gapStart).sql}`);
  assert(nearestStatement(statements, gapEnd).sql === 'SELECT 2', `後ろ寄り: ${nearestStatement(statements, gapEnd).sql}`);
});

check('nearestStatement: 先頭コメント上なら最初の文', () => {
  const text = '-- メモ\n\nSELECT 1;';
  const statements = splitSqlStatements(text, 'postgres');
  assert(nearestStatement(statements, 3).sql === 'SELECT 1', 'コメント上');
});

check('nearestStatement: 文が無ければ undefined', () => {
  assert(nearestStatement([], 0) === undefined, '空');
  assert(nearestStatement(splitSqlStatements('-- コメントだけ\n', 'postgres'), 2) === undefined, 'コメントのみ');
});

if (failures > 0) {
  console.error(`\n${failures} 件の検証に失敗しました。`);
  process.exit(1);
}
console.log('\nすべての検証にパスしました。');
