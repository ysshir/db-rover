#!/usr/bin/env node
// AI へ返す結果のサイズ制限（clampMaxRows / truncateCell / buildRunSqlPayload / serializePayload）の
// 素朴なユニット検証。テストフレームワークは使わず esbuild で src/ai/limits.ts を単体ビルドして
// Node で直接実行する。

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const entryPoint = path.join(projectRoot, 'src', 'ai', 'limits.ts');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-rover-check-ai-limits-'));
const outFile = path.join(outDir, 'limits.mjs');

await esbuild.build({
  entryPoints: [entryPoint],
  bundle: true,
  outfile: outFile,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
});

const { clampMaxRows, truncateCell, buildRunSqlPayload, serializePayload, HARD_MAX_ROWS } = await import(
  `file://${outFile}`
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

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message ?? ''}\n    期待: ${JSON.stringify(expected)}\n    実際: ${JSON.stringify(actual)}`);
  }
}

function okOutcome(index, columns, rows, overrides = {}) {
  return {
    index,
    sql: `SELECT ${index}`,
    status: 'ok',
    result: {
      columns,
      rows,
      rowCount: rows.length,
      truncated: false,
      durationMs: 1,
      ...overrides,
    },
  };
}

// --- clampMaxRows ---

check('maxRows は下限 1 にクランプされる', () => {
  assertEqual(clampMaxRows(0, 200), 1);
  assertEqual(clampMaxRows(-5, 200), 1);
});

check('maxRows は上限 1000 にクランプされる', () => {
  assertEqual(clampMaxRows(5000, 200), HARD_MAX_ROWS);
  assertEqual(clampMaxRows(1000, 200), 1000);
});

check('maxRows 未指定・不正値は既定値にフォールバックする', () => {
  assertEqual(clampMaxRows(undefined, 200), 200);
  assertEqual(clampMaxRows(Number.NaN, 50), 50);
});

// --- truncateCell ---

check('短い文字列はそのまま返す', () => {
  assertEqual(truncateCell('hello'), 'hello');
});

check('長い文字列は切り詰めて省略表記を付ける', () => {
  const long = 'a'.repeat(1500);
  const result = truncateCell(long);
  assert(result.startsWith('a'.repeat(1000)), '先頭 1000 文字は保持する');
  assert(result.includes('…（残り500文字省略）'), `省略表記が無い: ${result.slice(-30)}`);
});

check('文字列以外の値は切り詰めない', () => {
  assertEqual(truncateCell(123), 123);
  assertEqual(truncateCell(null), null);
  assertEqual(truncateCell(undefined), undefined);
});

// --- buildRunSqlPayload ---

check('行が 0 でも列名は残る', () => {
  const payload = buildRunSqlPayload([okOutcome(0, ['id', 'name'], [])]);
  assertEqual(payload.statements.length, 1);
  assert(Array.isArray(payload.statements[0].columns), 'columns が無い');
  assertEqual(payload.statements[0].columns.join(','), 'id,name');
  assertEqual(payload.statements[0].rows.length, 0);
});

check('error / skipped の文は message のみで rows を含まない', () => {
  const payload = buildRunSqlPayload([
    { index: 0, sql: 'DROP TABLE x', status: 'error', message: '権限がありません' },
  ]);
  assertEqual(payload.statements[0].rows, undefined);
  assertEqual(payload.statements[0].message, '権限がありません');
});

check('セルは buildRunSqlPayload の時点で切り詰められる', () => {
  const long = 'b'.repeat(2000);
  const payload = buildRunSqlPayload([okOutcome(0, ['memo'], [[long]])]);
  assert(payload.statements[0].rows[0][0].length < long.length, 'セルが切り詰められていない');
});

// --- serializePayload ---

check('上限内なら何も変わらない', () => {
  const payload = buildRunSqlPayload([okOutcome(0, ['id'], [[1], [2]])]);
  const json = serializePayload(payload, 20000);
  const parsed = JSON.parse(json);
  assertEqual(parsed.statements[0].rows.length, 2);
  assertEqual(parsed.note, undefined);
});

check('文字数上限を超えると末尾の行から落ち、truncated と note が両方立つ', () => {
  const rows = Array.from({ length: 200 }, (_, i) => [i, 'x'.repeat(50)]);
  const payload = buildRunSqlPayload([okOutcome(0, ['id', 'memo'], rows)]);
  const maxChars = 2000;
  const json = serializePayload(payload, maxChars);
  assert(json.length <= maxChars + 200, `想定より大きい: ${json.length}`); // note 追加分の余裕を見る
  const parsed = JSON.parse(json);
  assert(parsed.statements[0].rows.length < rows.length, '行が落ちていない');
  assertEqual(parsed.statements[0].truncated, true);
  assert(typeof parsed.note === 'string' && parsed.note.length > 0, 'note が無い');
});

fs.rmSync(outDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} 件失敗しました`);
  process.exit(1);
}
console.log('\nすべて成功しました');
