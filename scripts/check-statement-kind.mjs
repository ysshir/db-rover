#!/usr/bin/env node
// classifyStatement（SQL 文の read / write / destructive 分類）の素朴なユニット検証。
// check-mutations.mjs と同じく、テストフレームワークは使わず esbuild で
// src/drivers/statementKind.ts を単体ビルドして Node で直接実行する。

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const entryPoint = path.join(projectRoot, 'src', 'drivers', 'statementKind.ts');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-rover-check-statement-kind-'));
const outFile = path.join(outDir, 'statementKind.mjs');

await esbuild.build({
  entryPoints: [entryPoint],
  bundle: true,
  outfile: outFile,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
});

const { classifyStatement } = await import(`file://${outFile}`);

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

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message ?? ''}\n    期待: ${JSON.stringify(expected)}\n    実際: ${JSON.stringify(actual)}`);
  }
}

check('SELECT / WITH / EXPLAIN は read', () => {
  assertEqual(classifyStatement('SELECT * FROM users'), 'read');
  assertEqual(classifyStatement('  with recent as (select 1) select * from recent'), 'read');
  assertEqual(classifyStatement('EXPLAIN SELECT * FROM users'), 'read');
  assertEqual(classifyStatement('SHOW TABLES'), 'read');
});

check('WHERE 付き DELETE / UPDATE は write', () => {
  assertEqual(classifyStatement('DELETE FROM users WHERE id = 1'), 'write');
  assertEqual(classifyStatement('UPDATE users SET name = ? WHERE id = 1'), 'write');
});

check('WHERE 無し DELETE / UPDATE は destructive', () => {
  assertEqual(classifyStatement('DELETE FROM users'), 'destructive');
  assertEqual(classifyStatement('UPDATE users SET name = ?'), 'destructive');
});

check('DROP / TRUNCATE は destructive', () => {
  assertEqual(classifyStatement('DROP TABLE users'), 'destructive');
  assertEqual(classifyStatement('TRUNCATE TABLE users'), 'destructive');
});

check('ALTER TABLE ... DROP COLUMN は destructive', () => {
  assertEqual(classifyStatement('ALTER TABLE t DROP COLUMN c'), 'destructive');
});

check('文字列リテラルやコメントの中の where / drop に惑わされない', () => {
  assertEqual(classifyStatement("SELECT * FROM t WHERE memo = 'drop table x'"), 'read');
  assertEqual(classifyStatement('SELECT * FROM t -- where や drop ではない\n'), 'read');
  assertEqual(classifyStatement("UPDATE t SET note = 'no where clause here' WHERE id = 1"), 'write');
});

check('読み取りの顔をした CTE の書き込みは write', () => {
  assertEqual(
    classifyStatement('WITH moved AS (DELETE FROM a RETURNING *) INSERT INTO b SELECT * FROM moved'),
    'write',
  );
});

check('空文は write（フェイルクローズ）', () => {
  assertEqual(classifyStatement(''), 'write');
  assertEqual(classifyStatement('   -- コメントだけ'), 'write');
});

fs.rmSync(outDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} 件失敗しました`);
  process.exit(1);
}
console.log('\nすべて成功しました');
