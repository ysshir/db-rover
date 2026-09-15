#!/usr/bin/env node
// 先頭コメント（-- db-rover: ...）の読み書きの素朴なユニット検証。
// 他の check スクリプトと同じく、esbuild で src/query/connectionComment.ts を
// 単体ビルドして Node で直接実行する。

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const entryPoint = path.join(projectRoot, 'src', 'query', 'connectionComment.ts');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-rover-check-comment-'));
const outFile = path.join(outDir, 'connectionComment.mjs');

await esbuild.build({
  entryPoints: [entryPoint],
  bundle: true,
  outfile: outFile,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
});

const { findConnectionComment, formatConnectionComment, planConnectionComment, resolveConnectionRef } = await import(
  `file://${outFile}`,
);

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

const connections = [
  { id: 'local-postgres', name: 'Local Postgres', kind: 'postgres' },
  { id: 'connection-2', name: '本番 DB', kind: 'mysql' },
];

check('format: 名前・種別・id を 1 行に書く', () => {
  const line = formatConnectionComment(connections[0]);
  assert(line === '-- db-rover: Local Postgres (postgres) [local-postgres]', `実際: ${line}`);
});

check('find: 1 行目のマーカーを読む', () => {
  const text = '-- db-rover: Local Postgres (postgres) [local-postgres]\n\nSELECT 1;';
  const found = findConnectionComment(text);
  assert(found, 'マーカーが見つかること');
  assert(found.ref === 'Local Postgres (postgres) [local-postgres]', `実際: ${found.ref}`);
  assert(text.slice(found.start, found.end) === '-- db-rover: Local Postgres (postgres) [local-postgres]', '範囲');
});

check('find: 空行や他のコメントを挟んでいても先頭コメント塊なら読む', () => {
  const found = findConnectionComment('\n-- メモ\n# db-rover: local-postgres\nSELECT 1;');
  assert(found && found.ref === 'local-postgres', `実際: ${found && found.ref}`);
});

check('find: SQL が始まった後のマーカーは読まない', () => {
  assert(findConnectionComment('SELECT 1;\n-- db-rover: local-postgres') === undefined, '本体より後');
});

check('find: マーカーが無ければ undefined', () => {
  assert(findConnectionComment('-- ただのコメント\nSELECT 1;') === undefined, '無し');
});

check('resolve: [id] があれば id で引く', () => {
  const found = resolveConnectionRef('本番 DB (mysql) [connection-2]', connections);
  assert(found && found.id === 'connection-2', `実際: ${found && found.id}`);
});

check('resolve: [id] が壊れていれば見つからない', () => {
  assert(resolveConnectionRef('Local Postgres (postgres) [missing]', connections) === undefined, '不明な id');
});

check('resolve: 手書きの id / 名前でも引ける', () => {
  assert(resolveConnectionRef('local-postgres', connections).id === 'local-postgres', 'id');
  assert(resolveConnectionRef('本番 DB', connections).id === 'connection-2', '名前');
  assert(resolveConnectionRef('  local postgres  ', connections).id === 'local-postgres', '大文字小文字を無視');
  assert(resolveConnectionRef('   ', connections) === undefined, '空');
});

check('plan: マーカーが無ければ先頭に挿入する', () => {
  const comment = formatConnectionComment(connections[0]);
  const plan = planConnectionComment('SELECT 1;', comment);
  assert(plan.start === 0 && plan.end === 0, '挿入位置は先頭');
  assert(plan.insert === `${comment}\n`, `実際: ${plan.insert}`);
  assert(plan.delta === comment.length + 1, `実際: ${plan.delta}`);
});

check('plan: 既存のマーカー行だけを差し替える', () => {
  const text = '-- db-rover: Local Postgres (postgres) [local-postgres]\n\nSELECT 1;';
  const comment = formatConnectionComment(connections[1]);
  const plan = planConnectionComment(text, comment);
  const replaced = text.slice(0, plan.start) + plan.insert + text.slice(plan.end);
  assert(replaced === `${comment}\n\nSELECT 1;`, `実際: ${replaced}`);
  assert(replaced.length - text.length === plan.delta, 'delta は長さの差');
});

check('plan: 同じ内容なら編集しない', () => {
  const comment = formatConnectionComment(connections[0]);
  assert(planConnectionComment(`${comment}\nSELECT 1;`, comment) === undefined, '変更なし');
});

fs.rmSync(outDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} 件の検証に失敗しました。`);
  process.exit(1);
}
console.log('\nすべての検証にパスしました。');
