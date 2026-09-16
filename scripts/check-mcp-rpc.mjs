#!/usr/bin/env node
// MCP の JSON-RPC 層（src/ai/mcpRpc.ts）の素朴なユニット検証。
// テストフレームワークは使わず esbuild で単体ビルドして Node で直接実行する。

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const entryPoint = path.join(projectRoot, 'src', 'ai', 'mcpRpc.ts');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-rover-check-mcp-rpc-'));
const outFile = path.join(outDir, 'mcpRpc.mjs');

await esbuild.build({
  entryPoints: [entryPoint],
  bundle: true,
  outfile: outFile,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
});

const { parseRpcMessage, handleRpcMessage, negotiateProtocolVersion, RPC_ERROR, DEFAULT_PROTOCOL_VERSION } =
  await import(`file://${outFile}`);

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
    throw new Error(message || 'assertion failed');
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message ?? ''}\n    期待: ${JSON.stringify(expected)}\n    実際: ${JSON.stringify(actual)}`);
  }
}

const dummyHandlers = {
  listTools: () => [{ name: 'dbrover_list_connections', description: '一覧', inputSchema: { type: 'object' } }],
  callTool: () => ({ isError: false, text: '{}' }),
};

// --- parseRpcMessage ---

await check('壊れた JSON は Parse error (-32700)', () => {
  const parsed = parseRpcMessage('{not json');
  assertEqual(parsed.ok, false);
  assertEqual(parsed.response.error.code, RPC_ERROR.PARSE_ERROR);
});

await check('配列（バッチ）は Invalid Request (-32600)', () => {
  const parsed = parseRpcMessage('[]');
  assertEqual(parsed.ok, false);
  assertEqual(parsed.response.error.code, RPC_ERROR.INVALID_REQUEST);
});

await check('妥当な JSON はそのまま通す', () => {
  const parsed = parseRpcMessage('{"jsonrpc":"2.0","id":1,"method":"ping"}');
  assertEqual(parsed.ok, true);
  assertEqual(parsed.message.method, 'ping');
});

// --- handleRpcMessage: メソッド振り分け ---

await check('未知メソッドは Method not found (-32601)', async () => {
  const response = await handleRpcMessage(
    { jsonrpc: '2.0', id: 1, method: 'foo/bar' },
    dummyHandlers,
  );
  assertEqual(response.error.code, RPC_ERROR.METHOD_NOT_FOUND);
});

await check('notifications/initialized は応答を返さない（202 相当）', async () => {
  const response = await handleRpcMessage(
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    dummyHandlers,
  );
  assertEqual(response, undefined);
});

await check('id 無しの通知は他のメソッドでも応答を返さない', async () => {
  const response = await handleRpcMessage({ jsonrpc: '2.0', method: 'tools/list' }, dummyHandlers);
  assertEqual(response, undefined);
});

// --- initialize / バージョンネゴシエーション ---

await check('negotiateProtocolVersion: 既知のバージョンはそのまま返す', () => {
  assertEqual(negotiateProtocolVersion('2024-11-05'), '2024-11-05');
});

await check('negotiateProtocolVersion: 未知のバージョンは既定へ倒す', () => {
  assertEqual(negotiateProtocolVersion('9999-01-01'), DEFAULT_PROTOCOL_VERSION);
  assertEqual(negotiateProtocolVersion(undefined), DEFAULT_PROTOCOL_VERSION);
});

await check('initialize は交渉済みバージョンを含む結果を返す', async () => {
  const response = await handleRpcMessage(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    dummyHandlers,
  );
  assertEqual(response.result.protocolVersion, '2024-11-05');
  assertEqual(response.result.serverInfo.name, 'db-rover');
});

// --- tools/list ---

await check('tools/list はハンドラの返り値をそのまま result.tools に詰める', async () => {
  const response = await handleRpcMessage({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, dummyHandlers);
  assertEqual(response.id, 5);
  assert(Array.isArray(response.result.tools));
  assertEqual(response.result.tools[0].name, 'dbrover_list_connections');
});

// --- tools/call ---

await check('tools/call は正常結果を content[0].text / isError で返す', async () => {
  const handlers = {
    ...dummyHandlers,
    callTool: (name, args) => ({ isError: false, text: JSON.stringify({ name, args }) }),
  };
  const response = await handleRpcMessage(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dbrover_run_sql', arguments: { sql: '1' } } },
    handlers,
  );
  assertEqual(response.result.isError, false);
  assert(response.result.content[0].text.includes('dbrover_run_sql'));
});

await check('tools/call でツール側が isError を返しても JSON-RPC エラーにはしない', async () => {
  const handlers = {
    ...dummyHandlers,
    callTool: () => ({ isError: true, text: '接続されていません' }),
  };
  const response = await handleRpcMessage(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'dbrover_run_sql', arguments: {} } },
    handlers,
  );
  assert(response.error === undefined, 'error フィールドが付いてしまっている');
  assertEqual(response.result.isError, true);
  assertEqual(response.result.content[0].text, '接続されていません');
});

await check('tools/call でハンドラが例外を投げても JSON-RPC エラーにはしない', async () => {
  const handlers = {
    ...dummyHandlers,
    callTool: () => {
      throw new Error('想定外の失敗');
    },
  };
  const response = await handleRpcMessage(
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'dbrover_run_sql', arguments: {} } },
    handlers,
  );
  assert(response.error === undefined, 'error フィールドが付いてしまっている');
  assertEqual(response.result.isError, true);
  assertEqual(response.result.content[0].text, '想定外の失敗');
});

fs.rmSync(outDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} 件失敗しました`);
  process.exit(1);
}
console.log('\nすべて成功しました');
