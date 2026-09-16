#!/usr/bin/env node
// ResilientDriver の復帰/非復帰の切り分けを、偽のドライバを差し込んで検証する。
// check-recovery.mjs と同じく、テストフレームワークは使わず esbuild で単体ビルドして
// Node で直接実行する（resilient.ts は vscode に依存していないのでそのまま動く）。

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const entryPoint = path.join(projectRoot, 'src', 'drivers', 'resilient.ts');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-rover-check-resilient-'));
const outFile = path.join(outDir, 'resilient.mjs');

await esbuild.build({
  entryPoints: [entryPoint],
  bundle: true,
  outfile: outFile,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
});

const { ResilientDriver } = await import(`file://${outFile}`);

let failures = 0;

async function check(label, fn) {
  try {
    await fn();
    console.log(`PASS: ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL: ${label}`);
    console.error(`  ${error instanceof Error ? error.stack : error}`);
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message ?? '条件を満たしませんでした');
  }
}

function lostError() {
  const error = new Error('read ECONNRESET');
  error.code = 'ECONNRESET';
  return error;
}

/** 接続回数を数えるだけの偽ドライバ。queryImpl を差し替えて挙動を作る。 */
function fakeDriver(queryImpl) {
  return {
    kind: 'postgres',
    connects: 0,
    disposes: 0,
    onConnectionLost: () => ({ dispose() {} }),
    async connect() {
      this.connects += 1;
    },
    async dispose() {
      this.disposes += 1;
    },
    async query(sql, limit) {
      return queryImpl.call(this, sql, limit);
    },
    async listSchemas() {
      return ['public'];
    },
  };
}

function wrap(inner) {
  return new ResilientDriver(inner, { log() {} });
}

await check('接続が切れた読み取りは張り直してやり直す', async () => {
  let calls = 0;
  const inner = fakeDriver(function () {
    calls += 1;
    if (calls === 1) {
      throw lostError();
    }
    return { columns: [], rows: [] };
  });
  const driver = wrap(inner);
  await driver.connect();
  await driver.query('SELECT 1', 100);
  assert(calls === 2, `やり直していません: ${calls}`);
  assert(inner.connects === 2, `張り直していません: ${inner.connects}`);
});

await check('切断したあとは操作しても張り直さない', async () => {
  const inner = fakeDriver(function () {
    return { columns: [], rows: [] };
  });
  const driver = wrap(inner);
  await driver.connect();
  await driver.dispose();
  let thrown;
  try {
    await driver.query('SELECT 1', 100);
  } catch (error) {
    thrown = error;
  }
  assert(thrown !== undefined, '切断後の操作がエラーになっていません');
  assert(inner.connects === 1, `切断後に接続し直しています: ${inner.connects}`);
});

await check('切断によって実行中の操作が落ちても張り直さない', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const inner = fakeDriver(async function () {
    await gate;
    throw lostError(); // 切断でソケットが死んだ、の再現
  });
  const driver = wrap(inner);
  await driver.connect();
  const running = driver.query('SELECT 1', 100);
  await driver.dispose();
  release();
  let thrown;
  try {
    await running;
  } catch (error) {
    thrown = error;
  }
  assert(thrown !== undefined, '実行中の操作がエラーになっていません');
  assert(inner.connects === 1, `切断後に接続し直しています: ${inner.connects}`);
});

await check('書き込みは自動でやり直さない（張り直しはする）', async () => {
  let calls = 0;
  const inner = fakeDriver(function () {
    calls += 1;
    throw lostError();
  });
  const driver = wrap(inner);
  await driver.connect();
  let thrown;
  try {
    await driver.query('UPDATE t SET a = 1', 100);
  } catch (error) {
    thrown = error;
  }
  assert(thrown !== undefined, '書き込みの失敗が返っていません');
  assert(calls === 1, `書き込みをやり直しています: ${calls}`);
  assert(inner.connects === 2, `次に備えた張り直しがされていません: ${inner.connects}`);
});

fs.rmSync(outDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} 件失敗しました`);
  process.exit(1);
}
console.log('\nすべて成功しました');
