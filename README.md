# DB Rover

サイドバーのツリーで PostgreSQL / MySQL(MariaDB) / SQLite に接続し、スキーマ → テーブル → カラム/インデックスを辿りながら、SQL の実行やテーブルデータの閲覧・編集ができる VS Code 拡張機能です。

## 使い方

初回の導線はようこそ画面のウォークスルー「DB Rover をはじめる」にまとめてあります。コマンドパレットの `DB Rover: はじめに（使い方）` でいつでも開けます。

## 機能

- **接続管理**: 入力フォーム（モーダル）から接続を追加・編集し、その場で接続テストができます。パスワードは VS Code の SecretStorage に保存され、設定ファイル（`settings.json`）には書き込まれません。
- **ツリー表示**: 接続 → （PostgreSQL/MySQL のみ）スキーマ → テーブル/ビュー → カラム/インデックスの階層をツリーで探索できます。未接続の接続は展開時に遅延接続します。
- **SQL 実行**: `.sql` ファイルでクエリを実行し、結果を下部パネル（ターミナル・出力と同じ場所）の「DB Rover」タブで確認できます。実行時間・行数・行数制限による打ち切りの表示、CSV へのコピー/保存に対応しています。実行先はエディタごとに決まり、先頭コメントに記録されます（後述）。
- **テーブルビュー**: ツリーのテーブル/ビューをクリックするとエディタタブとしてテーブルビューが開きます。
  - ページング（100/200/500/1000 行）と仮想スクロール
  - 列ヘッダのクリックでソート（Shift+クリックで複数列ソート）
  - WHERE 式を直接書ける入力バー。列名は入力中にサジェストされます（Ctrl+Space で全候補、↑↓ で選択、Enter/Tab で確定）。文の区切り（`;`）やコメント（`--` `#` `/* */`）は拒否されます
  - 列幅のリサイズ・列の固定・非表示（次回開いたときも復元されます）。列ヘッダの右クリックから操作します
  - セルは 1 回目のクリックで選択、選択済みのセルをもう一度クリックすると編集モードに入ります。選択中のセルとその列は色が変わります
  - 主キーを持つテーブルはセルのインライン編集と行の削除ができます。変更は保留された差分（更新は緑、削除候補は赤）として表示され、「変更を保存」で実行される SQL のプレビューを確認したうえでトランザクション実行されます
  - セルの右クリックメニューから「値をコピー」「NULL に設定」「この行を削除候補にする」を実行できます

### テーブルビューのキー操作

保存は VS Code のキーボードショートカット（コマンド `dbRover.saveTableEdits`、既定は `Cmd/Ctrl+S`）です。グリッド内の操作は設定 `dbRover.keybindings` でアクション単位に上書きできます。値は `"ctrl+n"` のような文字列か、その配列です。修飾子は `ctrl` / `shift` / `alt` / `cmd`、`mod` は macOS で `cmd`・それ以外で `ctrl` になります。

| アクション | 既定のキー | 内容 |
| --- | --- | --- |
| `moveUp` / `moveDown` | `↑` `Ctrl+P` / `↓` `Ctrl+N` | 上下のセルへ移動 |
| `moveLeft` / `moveRight` | `←` `Ctrl+B` / `→` `Ctrl+F` | 左右のセルへ移動 |
| `moveRowStart` / `moveRowEnd` | `Home` `Ctrl+A` / `End` `Ctrl+E` | 行の左端・右端の列へ移動 |
| `moveTop` / `moveBottom` | `Ctrl+Home` `Mod+↑` / `Ctrl+End` `Mod+↓` | 先頭行・末尾行へ移動 |
| `pageUp` / `pageDown` | `PageUp` / `PageDown` | 1 画面ぶん移動 |
| `edit` | `Enter` `F2` | 選択セルを編集モードにする |
| `copy` | `Mod+C` | 選択セルの値をコピー |
| `setNull` | `Option+N`（Windows/Linux は `Alt+N`） | 選択セルを NULL にする |
| `deleteRow` | `Ctrl+D` `Delete` | 選択行の削除候補を切り替える |

編集モード中は `Enter` で確定して下のセルへ、`Tab` で確定して右のセルへ、`Escape` で取り消しです。

```jsonc
{
  "dbRover.keybindings": {
    "moveDown": ["arrowdown", "ctrl+j"],
    "deleteRow": "ctrl+d"
  }
}
```

## インストール（開発）

```bash
npm install
```

VS Code でこのフォルダを開き、`F5` を押すと拡張機能開発ホストが起動します（`npm run watch` が自動実行されます）。

## 接続設定の例

接続定義は `settings.json` の `dbRover.connections` に保存されます（パスワードは含まれません）。「DB Rover: 接続を追加」コマンド（サイドバーの + アイコン）で開くフォームから追加し、接続を右クリック →「接続を編集」で同じフォームから編集するのが基本です。直接編集する場合は以下を参考にしてください。

```jsonc
{
  "dbRover.connections": [
    {
      "id": "local-postgres",
      "name": "Local Postgres",
      "kind": "postgres",
      "host": "localhost",
      "port": 5432,
      "database": "app_development",
      "user": "postgres",
      "ssl": false
    },
    {
      "id": "local-mysql",
      "name": "Local MySQL",
      "kind": "mysql",
      "host": "localhost",
      "port": 3306,
      "database": "app_development",
      "user": "root",
      "ssl": false
    },
    {
      "id": "local-sqlite",
      "name": "Local SQLite",
      "kind": "sqlite",
      "file": "./data/app.db"
    }
  ],
  "dbRover.queryRowLimit": 500,
  "dbRover.pageSize": 200,
  "dbRover.countRows": true,
  "dbRover.autoConnectOnStartup": false
}
```

パスワードは接続時にプロンプトで入力し、保存するかどうかを選べます（保存先は SecretStorage）。

## SQL エディタの実行先

SQL エディタの実行先は**ドキュメントの先頭コメント**に記録されます。

```sql
-- db-rover: Local Postgres (postgres) [local-postgres]

SELECT * FROM users LIMIT 10;
```

- 「SQL エディタを開く」で開いたエディタには、この行が最初から入っています。
- ステータスバーの `$(database)` や各文の上の CodeLens の「接続先: ...」をクリックして接続を選び直すと、この行も書き換わります。
- 手で書いても効きます。`[id]`（`settings.json` の `dbRover.connections` の `id`）があればそれが優先され、無ければ `-- db-rover: Local Postgres` のように接続名でも解決されます。
- 先頭コメントが無いときは、VS Code が覚えているエディタごとの実行先（保存済みファイルのみ）を使います。名前を付けずに開いたエディタはウィンドウを再読み込みすると実行先が失われるため、コメントに残す形にしています。

## キーバインド

| 操作 | キー |
|---|---|
| カーソルに一番近い文をハイライト／実行（`.sql` エディタで有効） | `Ctrl+Enter` / `Cmd+Enter` |
| ハイライト中の文を実行 | `Enter` |
| ハイライトを解除 | `Escape` |
| すべての文を実行 | `Ctrl+Shift+Enter` / `Cmd+Shift+Enter` |

`Ctrl/Cmd+Enter` は 2 段階です。1 回目でカーソルに一番近い文がハイライトされ、そのまま `Enter`
（または `Ctrl/Cmd+Enter` をもう一度）で実行します。何が走るのかを実行前に確認できるようにするためです。
ハイライトはカーソルが文の外へ出たとき・編集したとき・`Escape` で解除されます。
ハイライトの色は `settings.json` の `workbench.colorCustomizations` から変更できます。

```jsonc
"workbench.colorCustomizations": {
  "dbRover.statementFocusBackground": "#3794ff33",     // 文の背景
  "dbRover.statementFocusBorder": "#3794ff",           // 左端のバーと「Enter で実行」バッジ
  "dbRover.statementFocusHintForeground": "#ffffff"    // バッジの文字色
}
```

選択範囲がある場合はハイライトを挟まず、その範囲をそのまま実行します。
各文の上に出る `▷ 実行`（CodeLens）も、クリックで即実行です。

## コマンド一覧（カテゴリ: DB Rover）

- 接続を追加 / 接続を編集 / 接続を削除
- 接続 / 切断 / 再読み込み
- 新しいクエリ / クエリを実行
- テーブルを開く / データをプレビュー（同じ動作のエイリアス）
- 名前をコピー
- アクティブ接続を選択（ステータスバーの `$(database)` アイコンからも実行できます）
- はじめに（使い方）— ようこそ画面のウォークスルーを開きます

## SQLite の実装について

ネイティブビルド依存を避けるため `node-sqlite3-wasm` を使用しています。
