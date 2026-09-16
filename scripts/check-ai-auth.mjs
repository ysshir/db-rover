#!/usr/bin/env node
// MCP HTTP サーバの認証・多層ガード（src/ai/auth.ts）の素朴なユニット検証。
// テストフレームワークは使わず esbuild で単体ビルドして Node で直接実行する。

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const entryPoint = path.join(projectRoot, 'src', 'ai', 'auth.ts');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-rover-check-ai-auth-'));
const outFile = path.join(outDir, 'auth.mjs');

await esbuild.build({
  entryPoints: [entryPoint],
  bundle: true,
  outfile: outFile,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
});

const {
  extractToken,
  extractTokenFromPath,
  extractTokenFromHeader,
  tokensEqual,
  isLoopbackAddress,
  isAllowedHost,
  isAllowedOrigin,
} = await import(`file://${outFile}`);

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

// --- トークン抽出 ---

check('パス埋め込みからトークンを取り出す', () => {
  assertEqual(extractTokenFromPath('/mcp/abc123'), 'abc123');
  assertEqual(extractTokenFromPath('/mcp/abc123/'), 'abc123');
});

check('パスがトークン付きでなければ undefined', () => {
  assertEqual(extractTokenFromPath('/mcp'), undefined);
  assertEqual(extractTokenFromPath('/other/abc123'), undefined);
});

check('Authorization: Bearer からトークンを取り出す', () => {
  assertEqual(extractTokenFromHeader('Bearer abc123'), 'abc123');
  assertEqual(extractTokenFromHeader('bearer   abc123  '), 'abc123');
});

check('Authorization ヘッダが無い・形式違いなら undefined', () => {
  assertEqual(extractTokenFromHeader(undefined), undefined);
  assertEqual(extractTokenFromHeader(null), undefined);
  assertEqual(extractTokenFromHeader('Basic abc123'), undefined);
});

check('extractToken はパス優先、両方無ければ undefined', () => {
  assertEqual(extractToken('/mcp/path-token', 'Bearer header-token'), 'path-token');
  assertEqual(extractToken('/mcp', 'Bearer header-token'), 'header-token');
  assertEqual(extractToken('/mcp', undefined), undefined);
});

// --- tokensEqual ---

check('同じトークンは true', () => {
  assert(tokensEqual('abc123', 'abc123'));
});

check('長さが違えば false', () => {
  assert(!tokensEqual('abc', 'abcd'));
});

check('空文字は false', () => {
  assert(!tokensEqual('', ''));
  assert(!tokensEqual('abc', ''));
  assert(!tokensEqual(undefined, 'abc'));
});

// --- isLoopbackAddress ---

check('127.0.0.1 / ::1 / ::ffff:127.0.0.1 は loopback', () => {
  assert(isLoopbackAddress('127.0.0.1'));
  assert(isLoopbackAddress('::1'));
  assert(isLoopbackAddress('::ffff:127.0.0.1'));
});

check('外部アドレスは loopback ではない', () => {
  assert(!isLoopbackAddress('192.168.1.10'));
  assert(!isLoopbackAddress(undefined));
});

// --- isAllowedHost ---

check('Host が 127.0.0.1:port / localhost:port なら許可', () => {
  assert(isAllowedHost('127.0.0.1:47600', 47600));
  assert(isAllowedHost('localhost:47600', 47600));
});

check('ポート違い・未知の Host は拒否', () => {
  assert(!isAllowedHost('127.0.0.1:9999', 47600));
  assert(!isAllowedHost('evil.example.com', 47600));
  assert(!isAllowedHost(undefined, 47600));
});

// --- isAllowedOrigin ---

check('許可リストの Origin は通す', () => {
  assert(isAllowedOrigin('vscode-file://vscode-app'));
  assert(isAllowedOrigin('vscode-webview://abc'));
  assert(isAllowedOrigin('http://127.0.0.1:5173'));
  assert(isAllowedOrigin('http://localhost:5173'));
});

check('不明な Origin は拒否する', () => {
  assert(!isAllowedOrigin('https://evil.example.com'));
  assert(!isAllowedOrigin('http://192.168.1.10'));
});

check('Origin ヘッダが無い場合は許可する（CLI 等）', () => {
  assert(isAllowedOrigin(undefined));
  assert(isAllowedOrigin(null));
});

fs.rmSync(outDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} 件失敗しました`);
  process.exit(1);
}
console.log('\nすべて成功しました');
