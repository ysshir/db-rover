# DB Rover（VS Code 拡張機能）

サイドバーから DB を探索し、SQL 実行とテーブルの閲覧・編集を行う拡張機能。
UI 文言・コメント・コミットメッセージはすべて日本語で書く。

## 修正したら必ずインストールまで行う（最重要）

**コードを直したら、ビルドで終わらせずインストール済みの拡張機能を最新にすること。**
`npm run compile` は `dist/` を作り直すだけで、ユーザーが実際に使っている
`~/.vscode/extensions/leptosystem.db-rover-<version>/` は古いままになる。
「直したのに挙動が変わらない」の原因はほぼこれ。

```bash
npm run verify        # typecheck + check（先に通す）
npm run install:local # compile → vsix 作成 → code --install-extension --force
```

- `--force` は必須。`version` を上げずに入れ直すと、同一バージョンとしてスキップされることがある。
- `media/` 配下の webview 用 JS/CSS も vsix に同梱される。**CSS や webview の JS だけの変更でも再パッケージ・再インストールが必要**。
- インストール後、反映には VS Code のウィンドウ再読み込みが要る（コマンドパレット →
  `Developer: Reload Window`）。これはこちらからは実行できないので、作業の最後にユーザーへ依頼すること。
- 反映されたか疑わしいときは、インストール先のタイムスタンプを見て判断する:
  `ls -la ~/.vscode/extensions/leptosystem.db-rover-*/dist ~/.vscode/extensions/leptosystem.db-rover-*/media`
- F5（Extension Development Host）で試す場合は `dist/` を直接読むのでインストールは不要。
  ただしユーザーが普段使っているウィンドウには反映されない。

## 検証

- `npm run typecheck` — `tsc --noEmit`
- `npm run check` — `scripts/check-mutations.mjs`。`src/drivers/sqlBuilder.ts` の純粋関数を
  esbuild で単体ビルドして Node で直接検証する。**SQL 生成を変えたらここにケースを足す。**
- テストフレームワークは導入していない。上記スクリプトに合わせること。

## 新機能を足したらヘルプも更新する

**機能を追加・変更したら、コードだけで終わらせずヘルプを同じコミットで更新すること。**
後回しにすると、どこにも書かれていない機能が増えて誰も気づけなくなる。

更新先は次の 4 つ。該当するものを漏れなく直す。

| 置き場所 | 実体 | 何を書くか |
| --- | --- | --- |
| ウォークスルー（ようこそ画面） | `package.json` の `contributes.walkthroughs` と `walkthrough/*.md` | 初回に知るべき操作。ステップを増やしすぎない |
| README.md | `README.md` | 正式なリファレンス。設定・キーバインド・挙動の詳細 |
| ツリーが空のときの案内 | `package.json` の `contributes.viewsWelcome` | 接続 0 件のときの導線だけ |
| コマンド一覧 | `package.json` の `contributes.commands` と README の「コマンド一覧」 | 追加したコマンドは必ず両方に |

- コマンドを増やしたら `contributes.commands` に加えて、パレットに出すかを
  `menus.commandPalette` の `when` で決める（エディタ専用のものは `editorLangId == sql`）。
- 設定（`contributes.configuration`）を増やしたら README の設定例にも足す。
- **使い方を SQL エディタの本文に書かない。** ユーザーの成果物を汚すうえ、2 回目以降はノイズになる。
  その場で伝えたいことは CodeLens・ステータスバーの tooltip・通知に留める。
- `walkthrough/` は `.vscodeignore` に入れない（vsix に同梱される必要がある）。

## 設計上の約束

- **SQL 生成**: 列名は必ず `ColumnMeta` のホワイトリストと突き合わせて検証し、値は必ず
  プレースホルダにする（`src/drivers/sqlBuilder.ts`）。文字列連結で値を埋め込まない。
  ユーザーが手書きする WHERE 式だけは例外的に連結するため、`validateWhereExpression()` で
  文字列リテラル外の `;` とコメントを拒否している。ここを緩めない。
- **パスワード**: SecretStorage にのみ保存する。`settings.json`（`dbRover.connections`）や
  webview へ平文を渡さない。webview には「保存済みかどうか」の真偽値だけ送る。
- **webview**: CSP + nonce 付きで HTML を生成し、`localResourceRoots` は `media/` のみ。
  外部 CDN・フォントを読み込まない。スクリプトは素の JavaScript（ビルド対象外）で書く。
- **SQL エディタの実行先**: 真は先頭コメント `-- db-rover: 名前 (kind) [id]`（`src/query/connectionComment.ts`）。
  ウィンドウを再読み込みすると untitled の URI は振り直され、メモリ上の束縛は失われるため。
  ドキュメントを書き換えるとオフセットがずれるので、`bindDocument()` の戻り値（delta）で
  CodeLens から渡ってきた実行位置を補正すること。
- **ページング**: `ORDER BY` を必ず付ける（無いと LIMIT/OFFSET で行の重複・取りこぼしが起きる）。
