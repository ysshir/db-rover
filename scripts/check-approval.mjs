#!/usr/bin/env node
// 承認判定・文言生成（src/ai/approvalPolicy.ts）の素朴なユニット検証。
// テストフレームワークは使わず esbuild で単体ビルドして Node で直接実行する。

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const entryPoint = path.join(projectRoot, 'src', 'ai', 'approvalPolicy.ts');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-rover-check-approval-'));
const outFile = path.join(outDir, 'approvalPolicy.mjs');

await esbuild.build({
  entryPoints: [entryPoint],
  bundle: true,
  outfile: outFile,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
});

const { decideApproval, buildApprovalPrompt } = await import(`file://${outFile}`);

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

// --- decideApproval ---

check('read のみなら allow', () => {
  assertEqual(decideApproval(['read'], false, 'ask'), 'allow');
  assertEqual(decideApproval(['read', 'read'], true, 'never'), 'allow');
});

check('write を含めば ask（mode=ask）', () => {
  assertEqual(decideApproval(['read', 'write'], false, 'ask'), 'ask');
  assertEqual(decideApproval(['write'], false, 'ask'), 'ask');
});

check('write を記憶済み + mode=session なら allow', () => {
  assertEqual(decideApproval(['write'], true, 'session'), 'allow');
});

check('write を未記憶 + mode=session なら ask', () => {
  assertEqual(decideApproval(['write'], false, 'session'), 'ask');
});

check('destructive は記憶済みでも必ず ask', () => {
  assertEqual(decideApproval(['destructive'], true, 'session'), 'ask');
  assertEqual(decideApproval(['read', 'destructive'], true, 'session'), 'ask');
});

check('mode=never は write も destructive も deny', () => {
  assertEqual(decideApproval(['write'], true, 'never'), 'deny');
  assertEqual(decideApproval(['destructive'], true, 'never'), 'deny');
  assertEqual(decideApproval(['destructive'], false, 'never'), 'deny');
});

check('kinds が空ならフェイルクローズで ask', () => {
  assertEqual(decideApproval([], false, 'ask'), 'ask');
});

// --- buildApprovalPrompt ---

check('destructive のとき detail の先頭行に警告を置く', () => {
  const prompt = buildApprovalPrompt({
    connectionName: 'Local Postgres',
    kinds: ['destructive'],
    sql: 'DROP TABLE users',
    caller: 'mcp',
  });
  assert(prompt.destructive === true);
  const firstLine = prompt.detail.split('\n')[0];
  assertEqual(firstLine, '注意: この操作は取り消せません。');
  assert(prompt.title.includes('Local Postgres'), 'title に接続名が無い');
});

check('read/write のときは警告行を置かない', () => {
  const prompt = buildApprovalPrompt({
    connectionName: 'Local Postgres',
    kinds: ['write'],
    sql: 'INSERT INTO users (name) VALUES (?)',
    caller: 'lm',
  });
  assert(prompt.destructive === false);
  assert(!prompt.detail.startsWith('注意:'), '警告行が付いてしまっている');
});

check('呼び出し元ラベルが detail に含まれる', () => {
  const mcpPrompt = buildApprovalPrompt({
    connectionName: 'DB',
    kinds: ['write'],
    sql: 'INSERT INTO t VALUES (1)',
    caller: 'mcp',
  });
  const lmPrompt = buildApprovalPrompt({
    connectionName: 'DB',
    kinds: ['write'],
    sql: 'INSERT INTO t VALUES (1)',
    caller: 'lm',
  });
  assert(mcpPrompt.detail.includes('MCP（外部 AI）'));
  assert(lmPrompt.detail.includes('Copilot（LM ツール）'));
});

fs.rmSync(outDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} 件失敗しました`);
  process.exit(1);
}
console.log('\nすべて成功しました');
