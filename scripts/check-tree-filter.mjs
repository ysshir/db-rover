#!/usr/bin/env node
// matchesFilter / normalizeFilter（ツリーのテーブル名絞り込み）の素朴なユニット検証。
// 他の check-*.mjs と同じく、テストフレームワークは使わず esbuild で
// src/tree/filter.ts を単体ビルドして Node で直接実行する。

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const entryPoint = path.join(projectRoot, 'src', 'tree', 'filter.ts');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-rover-check-tree-filter-'));
const outFile = path.join(outDir, 'filter.mjs');

await esbuild.build({
  entryPoints: [entryPoint],
  bundle: true,
  outfile: outFile,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
});

const { matchesFilter, normalizeFilter } = await import(`file://${outFile}`);

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

check('空の絞り込みは解除として正規化される', () => {
  assertEqual(normalizeFilter(undefined), undefined);
  assertEqual(normalizeFilter(''), undefined);
  assertEqual(normalizeFilter('   '), undefined);
  assertEqual(normalizeFilter('  users  '), 'users');
});

check('絞り込みなしはすべて通す', () => {
  assertEqual(matchesFilter('users', undefined), true);
  assertEqual(matchesFilter('users', ''), true);
  assertEqual(matchesFilter('users', '   '), true);
});

check('部分一致・大文字小文字は区別しない', () => {
  assertEqual(matchesFilter('app_users', 'user'), true);
  assertEqual(matchesFilter('APP_USERS', 'user'), true);
  assertEqual(matchesFilter('app_users', 'USER'), true);
  assertEqual(matchesFilter('orders', 'user'), false);
});

check('空白区切りは AND', () => {
  assertEqual(matchesFilter('app_user_tokens', 'user token'), true);
  assertEqual(matchesFilter('app_user_tokens', 'user order'), false);
  assertEqual(matchesFilter('app_user_tokens', '  user   token  '), true);
});

check('* はワイルドカード（全体一致）', () => {
  assertEqual(matchesFilter('order_items', 'order_*'), true);
  assertEqual(matchesFilter('shop_orders', 'order_*'), false, '前方一致を含む一致にしない');
  assertEqual(matchesFilter('order_items', '*items'), true);
  assertEqual(matchesFilter('order_items', '*der*tem*'), true);
  assertEqual(matchesFilter('ORDER_ITEMS', 'order_*'), true);
});

check('正規表現のメタ文字はリテラルとして扱う', () => {
  assertEqual(matchesFilter('users', 'u.ers'), false, '. は任意の 1 文字にしない');
  assertEqual(matchesFilter('u.ers', 'u.ers'), true);
  assertEqual(matchesFilter('a+b', 'a+b'), true);
  assertEqual(matchesFilter('ab', 'a+b'), false);
  assertEqual(matchesFilter('log[2024]', '*[2024]'), true);
});

if (failures > 0) {
  console.error(`\n${failures} 件の検証に失敗しました。`);
  process.exit(1);
}
console.log('\nすべての検証に成功しました。');
