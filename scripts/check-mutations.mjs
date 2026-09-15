#!/usr/bin/env node
// buildMutations / buildBrowseQuery の安全性についての素朴なユニット検証。
// テストフレームワークは使わず、esbuild で src/drivers/sqlBuilder.ts を単体ビルドして
// そのまま Node で実行することで、純粋関数をユニット検証する。

import * as esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const entryPoint = path.join(projectRoot, 'src', 'drivers', 'sqlBuilder.ts');

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-rover-check-'));
const outFile = path.join(outDir, 'sqlBuilder.mjs');

await esbuild.build({
  entryPoints: [entryPoint],
  bundle: true,
  outfile: outFile,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
});

const { buildMutationStatements, buildBrowseQuery, escapeLikeValue, validateWhereExpression } = await import(
  `file://${outFile}`,
);

const dialect = {
  quoteIdent: (name) => `"${name.replace(/"/g, '""')}"`,
  placeholderStyle: 'dollar',
  qualifyTable: (schema, table) => `"${schema}"."${table}"`,
};

const columns = [
  { name: 'id', dataType: 'integer', nullable: false, isPrimaryKey: true },
  { name: 'name', dataType: 'text', nullable: true, isPrimaryKey: false },
  { name: 'email', dataType: 'text', nullable: true, isPrimaryKey: false },
];

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

function assertThrows(fn, message) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  assert(threw, message || '例外が発生することを期待しましたが発生しませんでした');
}

// 1. key が空のとき update が例外になる
check('update: key が空だと例外になる', () => {
  assertThrows(() => {
    buildMutationStatements(
      'public',
      'users',
      [{ type: 'update', key: {}, changes: { name: 'x' } }],
      columns,
      dialect,
    );
  });
});

check('delete: key が空だと例外になる', () => {
  assertThrows(() => {
    buildMutationStatements('public', 'users', [{ type: 'delete', key: {} }], columns, dialect);
  });
});

// 2. 生成 SQL に WHERE 句が必ず含まれる
check('update: 生成 SQL に WHERE 句が含まれる', () => {
  const statements = buildMutationStatements(
    'public',
    'users',
    [{ type: 'update', key: { id: 1 }, changes: { name: 'Alice' } }],
    columns,
    dialect,
  );
  assert(statements.length === 1, 'statement が 1 件生成されること');
  assert(/\bWHERE\b/.test(statements[0].sql), `WHERE 句が含まれること: ${statements[0].sql}`);
  assert(statements[0].params.length === 2, 'params は SET 値 + key 値の 2 件であること');
});

check('delete: 生成 SQL に WHERE 句が含まれる', () => {
  const statements = buildMutationStatements(
    'public',
    'users',
    [{ type: 'delete', key: { id: 1 } }],
    columns,
    dialect,
  );
  assert(/\bWHERE\b/.test(statements[0].sql), `WHERE 句が含まれること: ${statements[0].sql}`);
});

// 3. 列名ホワイトリストに無い列名を渡すと例外になる
check('update: 未知の列名（changes）は例外になる', () => {
  assertThrows(() => {
    buildMutationStatements(
      'public',
      'users',
      [{ type: 'update', key: { id: 1 }, changes: { not_a_column: 'x' } }],
      columns,
      dialect,
    );
  });
});

check('update: 未知の列名（key）は例外になる', () => {
  assertThrows(() => {
    buildMutationStatements(
      'public',
      'users',
      [{ type: 'update', key: { not_a_column: 1 }, changes: { name: 'x' } }],
      columns,
      dialect,
    );
  });
});

check('browse: 未知の列名（filter）は例外になる', () => {
  assertThrows(() => {
    buildBrowseQuery(
      {
        schema: 'public',
        table: 'users',
        sort: [],
        filters: [{ column: 'not_a_column', operator: 'eq', value: '1' }],
        offset: 0,
        limit: 100,
      },
      columns,
      dialect,
    );
  });
});

// 4. LIKE のエスケープが効いている（% を含む値がリテラルとして扱われる）
check('escapeLikeValue: % _ \\ をエスケープする', () => {
  assert(escapeLikeValue('50%') === '50\\%', `実際: ${escapeLikeValue('50%')}`);
  assert(escapeLikeValue('a_b') === 'a\\_b', `実際: ${escapeLikeValue('a_b')}`);
  assert(escapeLikeValue('a\\b') === 'a\\\\b', `実際: ${escapeLikeValue('a\\b')}`);
});

check('browse: contains フィルタは ESCAPE 句付きの LIKE を生成し値をエスケープする', () => {
  const built = buildBrowseQuery(
    {
      schema: 'public',
      table: 'users',
      sort: [],
      filters: [{ column: 'name', operator: 'contains', value: '50%off' }],
      offset: 0,
      limit: 100,
    },
    columns,
    dialect,
  );
  assert(/LIKE \$\d+ ESCAPE '\\'/.test(built.sql), `ESCAPE 句が含まれること: ${built.sql}`);
  const likeParam = built.params.find((p) => typeof p === 'string' && p.includes('off'));
  assert(likeParam === '%50\\%off%', `エスケープ済みの値が params に入ること。実際: ${likeParam}`);
});

// 5. 手書き WHERE 式は、文字列リテラルの外にある ; とコメントを拒否する
check('WHERE 式: 通常の式はそのまま通る', () => {
  assert(validateWhereExpression("  name = 'a' AND id > 3  ") === "name = 'a' AND id > 3", '前後の空白のみ落ちること');
  assert(validateWhereExpression(undefined) === '', 'undefined は空文字になること');
});

check('WHERE 式: 文字列リテラル内の ; とコメント記号は許容する', () => {
  assert(validateWhereExpression("name = 'a;b'") === "name = 'a;b'", 'リテラル内のセミコロン');
  assert(validateWhereExpression("name = '--'") === "name = '--'", 'リテラル内の --');
  assert(validateWhereExpression("name = 'it''s;'") === "name = 'it''s;'", "'' エスケープをまたぐリテラル");
});

check('WHERE 式: 文の区切りとコメントは拒否する', () => {
  for (const expr of ["id = 1; DROP TABLE users", 'id = 1 -- x', 'id = 1 # x', 'id = 1 /* x */']) {
    let threw = false;
    try {
      validateWhereExpression(expr);
    } catch {
      threw = true;
    }
    assert(threw, `拒否されること: ${expr}`);
  }
});

check('WHERE 式: 閉じられていない引用符は拒否する', () => {
  let threw = false;
  try {
    validateWhereExpression("name = 'a");
  } catch {
    threw = true;
  }
  assert(threw, '閉じ忘れが拒否されること');
});

check('browse: WHERE 式は列フィルタと AND で結合され、括弧で包まれる', () => {
  const built = buildBrowseQuery(
    {
      schema: 'public',
      table: 'users',
      sort: [],
      filters: [{ column: 'name', operator: 'eq', value: 'x' }],
      where: "id > 10 OR email IS NULL",
      offset: 0,
      limit: 100,
    },
    columns,
    dialect,
  );
  assert(
    built.sql.includes(`WHERE "name" = $1 AND (id > 10 OR email IS NULL)`),
    `実際: ${built.sql}`,
  );
  assert(built.params.length === 3, `params は値 + limit + offset の 3 件。実際: ${built.params.length}`);
});

fs.rmSync(outDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} 件の検証が失敗しました。`);
  process.exit(1);
} else {
  console.log('\nすべての検証にパスしました。');
}
