#!/usr/bin/env node
// 結果の書き出し（toDelimitedText）の素朴なユニット検証。
// check-mutations.mjs と同じく、テストフレームワークは使わず esbuild で
// src/util/delimited.ts を単体ビルドして Node で直接実行する。

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const entryPoint = path.join(projectRoot, 'src', 'util', 'delimited.ts');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-rover-check-export-'));
const outFile = path.join(outDir, 'delimited.mjs');

await esbuild.build({
  entryPoints: [entryPoint],
  bundle: true,
  outfile: outFile,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
});

const { toDelimitedText, normalizeExportFormat } = await import(`file://${outFile}`);

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

function assertEqual(actual, expected) {
  if (actual !== expected) {
    throw new Error(`\n    期待: ${JSON.stringify(expected)}\n    実際: ${JSON.stringify(actual)}`);
  }
}

function result(columns, rows) {
  return { columns, rows, rowCount: rows.length, truncated: false, durationMs: 0 };
}

check('CSV はカンマ区切り', () => {
  assertEqual(toDelimitedText(result(['id', 'name'], [[1, 'a']]), 'csv'), 'id,name\r\n1,a');
});

check('TSV はタブ区切り', () => {
  assertEqual(toDelimitedText(result(['id', 'name'], [[1, 'a']]), 'tsv'), 'id\tname\r\n1\ta');
});

check('CSV はカンマを含む値を引用する', () => {
  assertEqual(toDelimitedText(result(['memo'], [['a,b']]), 'csv'), 'memo\r\n"a,b"');
});

check('TSV はカンマを含む値を引用しない', () => {
  assertEqual(toDelimitedText(result(['memo'], [['a,b']]), 'tsv'), 'memo\r\na,b');
});

check('TSV はタブを含む値を引用する', () => {
  assertEqual(toDelimitedText(result(['memo'], [['a\tb']]), 'tsv'), 'memo\r\n"a\tb"');
});

check('CSV はタブを含む値を引用しない', () => {
  assertEqual(toDelimitedText(result(['memo'], [['a\tb']]), 'csv'), 'memo\r\na\tb');
});

check('引用符は 2 つ重ねて逃がす', () => {
  assertEqual(toDelimitedText(result(['memo'], [['say "hi"']]), 'csv'), 'memo\r\n"say ""hi"""');
  assertEqual(toDelimitedText(result(['memo'], [['say "hi"']]), 'tsv'), 'memo\r\n"say ""hi"""');
});

check('改行を含む値はどちらの形式でも引用する', () => {
  assertEqual(toDelimitedText(result(['memo'], [['a\nb']]), 'csv'), 'memo\r\n"a\nb"');
  assertEqual(toDelimitedText(result(['memo'], [['a\nb']]), 'tsv'), 'memo\r\n"a\nb"');
});

check('null と undefined は空欄にする', () => {
  assertEqual(toDelimitedText(result(['a', 'b'], [[null, undefined]]), 'csv'), 'a,b\r\n,');
});

check('行が無くてもヘッダは出す', () => {
  assertEqual(toDelimitedText(result(['id'], []), 'csv'), 'id');
});

check('列名も同じ規則で引用する', () => {
  assertEqual(toDelimitedText(result(['a,b'], []), 'csv'), '"a,b"');
  assertEqual(toDelimitedText(result(['a,b'], []), 'tsv'), 'a,b');
});

check('設定値が壊れていても csv に倒す', () => {
  assertEqual(normalizeExportFormat('tsv'), 'tsv');
  assertEqual(normalizeExportFormat('csv'), 'csv');
  assertEqual(normalizeExportFormat('xlsx'), 'csv');
  assertEqual(normalizeExportFormat(undefined), 'csv');
  assertEqual(normalizeExportFormat(null), 'csv');
});

fs.rmSync(outDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} 件失敗しました`);
  process.exit(1);
}
console.log('\nすべて成功しました');
