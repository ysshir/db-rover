# DB Rover

サイドバーのツリーで PostgreSQL / MySQL(MariaDB) / SQLite に接続し、スキーマ → テーブル → カラム/インデックスを辿りながら、SQL の実行やテーブルデータの閲覧・編集ができる VS Code 拡張機能です。

## 使い方

初回の導線はようこそ画面のウォークスルー「DB Rover をはじめる」にまとめてあります。コマンドパレットの `DB Rover: はじめに（使い方）` でいつでも開けます。

## 機能

- **接続管理**: 入力フォーム（モーダル）から接続を追加・編集し、その場で接続テストができます。パスワードは VS Code の SecretStorage に保存され、設定ファイル（`settings.json`）には書き込まれません。
- **ツリー表示**: 接続 → （PostgreSQL/MySQL のみ）スキーマ → テーブル/ビュー → カラム/インデックスの階層をツリーで探索できます。未接続の接続は展開時に遅延接続します。接続状態は左のアイコン（未接続はグレー）で分かり、行にカーソルを合わせると接続 $(plug) / 切断 $(debug-disconnect) のアイコンが出ます（その時点で意味のある方だけが出ます）。
- **テーブル名の絞り込み**: 接続の行にカーソルを合わせると出る漏斗 $(filter) から、テーブル／ビュー名を絞り込めます。入力した文字を含む名前だけがツリーに残り、絞り込み中は接続行に `絞り込み: ...` と表示されます。詳細は後述します。
- **SQL 実行**: `.sql` ファイルでクエリを実行し、結果を下部パネル（ターミナル・出力と同じ場所）の「DB Rover」タブで確認できます。実行時間・行数・行数制限による打ち切りの表示、結果のコピー/保存に対応しています（CSV / TSV は設定 `dbRover.exportFormat` で選べます）。実行先はエディタごとに決まり、先頭コメントに記録されます（後述）。
- **テーブルビュー**: ツリーのテーブル/ビューをクリックするとエディタタブとしてテーブルビューが開きます。
  - ページング（100/200/500/1000 行）と仮想スクロール。ページ送り（先頭・前・次・末尾のアイコン）と件数の指定は WHERE 入力バーの左端にまとまっています
  - 列ヘッダのクリックでソート（Shift+クリックで複数列ソート）
  - WHERE 式を直接書ける入力バー。`Enter` で適用します（適用ボタンはありません）。文の区切り（`;`）やコメント（`--` `#` `/* */`）は拒否されます。「クリア」は消すものがあるときだけ押せます
  - 入力中は列名と語句が補完されます（Ctrl+Space で全候補、↑↓ で選択、Enter/Tab で確定）。語句は `IS NULL` / `IS NOT NULL` / `AND` / `OR` / `NOT` / `LIKE` / `IN` / `BETWEEN` などで、接続先に応じて `ILIKE`（PostgreSQL）・`REGEXP`（MySQL）・`GLOB`（SQLite）も出ます。`LIKE` や `IN` を選ぶとクォートや括弧ごと入り、キャレットは書き始める位置に置かれます
  - 列幅のリサイズ・列の固定・非表示（次回開いたときも復元されます）。列ヘッダの右クリックから操作します
  - セルは 1 回目のクリックで選択、選択済みのセルをもう一度クリックすると編集モードに入ります。選択中のセルとその列は色が変わります
  - 主キーを持つテーブルはセルのインライン編集と行の削除ができます。変更は保留された差分（更新は緑、削除候補は赤）として表示され、「変更を保存」で実行される SQL のプレビューを確認したうえでトランザクション実行されます
  - セルの右クリックメニューから「値をコピー」「NULL に設定」「この行を削除候補にする」を実行できます
  - `Cmd/Ctrl+R` で再読み込みします。ページ位置・ソート・WHERE はそのままです（未保存の変更があるときは、捨てずに再読み込みを断ります）
- **接続の自動復帰**: スリープ復帰・VPN の張り直し・ネットワークの切り替えでソケットが切れた場合（`read EADDRNOTAVAIL` など）、次の操作の前に自動で接続を張り直します。自分で「切断」したときは張り直しません。詳細は後述します。

### テーブルビューのキー操作

保存と再読み込みは VS Code のキーボードショートカット（コマンド `dbRover.saveTableEdits` = 既定 `Cmd/Ctrl+S`、`dbRover.reloadTableView` = 既定 `Cmd/Ctrl+R`）です。グリッド内の操作は設定 `dbRover.keybindings` でアクション単位に上書きできます。値は `"ctrl+n"` のような文字列か、その配列です。修飾子は `ctrl` / `shift` / `alt` / `cmd`、`mod` は macOS で `cmd`・それ以外で `ctrl` になります。

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

AI 連携（`contributes.mcpServerDefinitionProviders`）の関係で、対応する VS Code は `1.101.0` 以上が必要です（`engines.vscode`）。

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
  "dbRover.exportFormat": "csv",
  "dbRover.autoConnectOnStartup": false,
  "dbRover.ai.mcpServer.enabled": false,
  "dbRover.ai.languageModelTools.enabled": true,
  "dbRover.ai.port": 47600,
  "dbRover.ai.writes": "ask",
  "dbRover.ai.maxRows": 200,
  "dbRover.ai.maxStatements": 10,
  "dbRover.ai.timeoutMs": 30000,
  "dbRover.ai.showResults": true
}
```

パスワードは接続時にプロンプトで入力し、保存するかどうかを選べます（保存先は SecretStorage）。

`dbRover.exportFormat` はクエリ結果の「コピー」「保存」で書き出す形式です。`"csv"`（カンマ区切り、既定）か
`"tsv"`（タブ区切り）を指定します。値にその区切り文字・改行・引用符が含まれる場合はどちらの形式でも
引用符で囲み、引用符は 2 つ重ねて逃がします。表計算ソフトへ貼り付けるときは、カンマを含む値が多いデータでも
崩れにくい `"tsv"` が扱いやすいことがあります。

## テーブル名の絞り込み

テーブルが多い DB では、接続の行にカーソルを合わせると出る漏斗 $(filter)（コマンド
`DB Rover: テーブル名で絞り込み`）から名前で絞り込めます。入力欄には現在の絞り込みが入っているので、
そのまま書き換えられます。**入力するそばからツリーが絞り込まれ**、結果がすぐ見えるようにスキーマと
「テーブル」「ビュー」は開いた状態になります（未接続の場合は先に接続します）。

- 大文字小文字は区別しません。`user` は `APP_USERS` にも一致します
- 空白で区切ると、そのすべてを含む名前だけが残ります（AND）。`user token` は `app_user_tokens` に一致します
- `*` はワイルドカードです。`order_*` は `order_items` に一致し、`shop_orders` には一致しません
  （`*` を含む語だけは「含む」ではなく全体一致になります）
- 絞り込みが効くのはテーブル／ビューの名前だけです。カラムやインデックスは隠しません
- 解除してもツリーは広げたままです（畳まずに全件が並んだ状態に戻ります）
- 絞り込み中は漏斗が塗りつぶした漏斗 $(filter-filled) に変わります。これを押すか、入力を空にすると解除です
  （コマンド `DB Rover: 絞り込みを解除`。絞り込みの内容を変えたいときは、接続行を右クリック →「テーブル名で絞り込み」）
- 入力欄は閉じた時点の内容で確定します（`Esc` で閉じても元には戻りません）。絞り込んだ結果をクリックした
  ときにも入力欄は閉じるので、そこで巻き戻すと目的の行ごと消えてしまうためです
- 絞り込みは接続ごとに持ちます。保存はしないので、ウィンドウを再読み込みすると解除されます

絞り込み中かどうかは、接続の行の `絞り込み: ...` で分かります。

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

## 接続が切れたときの挙動

スリープからの復帰・VPN の張り直し・Wi-Fi の切り替えでローカルのアドレスが無効になると、張りっぱなしの
ソケットは `read EADDRNOTAVAIL` などで死にます。放置すると以降の操作がすべて同じエラーで失敗し続けるため、
DB Rover は接続が切れたことを検知して自動で張り直します。

- **操作を始める前に切れていた場合**: 黙って張り直してから実行します。よくあるケース（待機中に切れた）は
  これで吸収され、利用者からは何も起きていないように見えます。
- **操作の最中に切れた場合**: 張り直したうえで、読み取り専用と確信できる文（`SELECT` / `SHOW` /
  `EXPLAIN` など）だけ自動でやり直します。`INSERT` / `UPDATE` / `DELETE` やテーブルビューの「変更を保存」は、
  サーバに届いて実行されたのかどうかが分からないため**自動では再送しません**。接続だけ直したうえでエラーを返すので、
  結果を確かめてから実行し直してください（黙って再送すると二重に適用されるおそれがあるためです）。
- **張り直せなかった場合**: 3 回試して駄目なら接続を畳み、ツリーを未接続表示に戻して通知します。
  ツリーから開き直すと接続し直します。
- **自分で切断した場合**: 「切断」やクエリのキャンセルで閉じた接続は張り直しません。
  実行中だった操作は接続断のエラーで終わり、次につなぐのはツリーから開き直したときだけです。

再接続するとサーバ側のセッションは作り直しになります。トランザクション・一時テーブル・セッション変数は
失われるので、明示的に `BEGIN` を書いて作業していた場合は最初からやり直してください。
再接続の記録は出力チャンネル「DB Rover」に残ります。

## AI 連携（MCP / Language Model Tools）

DB Rover が「接続中」の接続に対して SQL を実行できる口を、AI 向けに 2 経路で公開します。

| 経路 | 対象 | 既定 | 有効化する設定 |
| --- | --- | --- | --- |
| Language Model Tools | VS Code 内蔵の Copilot Chat 等 | 有効 | `dbRover.ai.languageModelTools.enabled` |
| MCP サーバ（`http://127.0.0.1` の Streamable HTTP） | Claude Code など外部の AI クライアント | 無効 | `dbRover.ai.mcpServer.enabled` |

両方を有効にすると、Copilot からは同じツールが 2 系統見えて重複することがあります。通常は必要な経路だけを有効にしてください。

どちらの経路でも、公開されるツールは次の 4 本です（名前・入力は共通）。

| ツール名 | 内容 |
| --- | --- |
| `dbrover_list_connections` | 現在「接続中」の接続だけを一覧します。未接続の接続は見えません |
| `dbrover_list_tables` | 指定した接続のテーブル・ビュー一覧をスキーマごとに返します |
| `dbrover_describe_table` | 指定したテーブルの列定義とインデックスを返します（サンプル行など実データは含みません） |
| `dbrover_run_sql` | SQL を実行します（`;` 区切りで複数文可）。読み取り以外は承認が必要です |

- AI が触れるのは、ツリーから接続済みのデータベースだけです。接続 ID は `dbrover_list_connections` から取得させてください。
- `dbrover_run_sql` で読み取り（`SELECT` 等）以外の文を実行するときはモーダルの承認が必要です（設定 `dbRover.ai.writes` で挙動を変更できます）。
- **取り消せない文**（`DROP` / `TRUNCATE` / `WHERE` 無しの `DELETE`・`UPDATE` など）は「以後確認しない」を選んでいても、**毎回**確認が入ります。
- 実行結果は AI への応答だけでなく、既存の「クエリ結果」パネルにも `接続名（AI）` として流れます（設定 `dbRover.ai.showResults`）。何が実行されたかはここで必ず確認できます。
- すべてのリクエスト・承認可否・実行結果は出力チャンネル「DB Rover」に記録されます（SQL 本文・行数・所要時間のみ。値そのものやトークンは記録しません）。

### Claude Code などへの登録

1. コマンドパレットで `DB Rover: AI 連携: MCP サーバを開始` を実行します（設定 `dbRover.ai.mcpServer.enabled` が `true` になり、ループバックアドレスのみで待ち受けを開始します）。
2. `DB Rover: AI 連携: MCP の設定をコピー` を実行すると、`.mcp.json` にそのまま貼り付けられる JSON がクリップボードにコピーされます。これが主な登録手段です。
3. 貼り付け先が無い、または手早く済ませたい場合は `DB Rover: AI 連携: .mcp.json に登録` を使うと、ワークスペース直下の `.mcp.json` に `mcpServers["db-rover"]` をマージして書き込みます（書き込み前に内容を確認するモーダルが出ます）。

```jsonc
// .mcp.json
{
  "mcpServers": {
    "db-rover": {
      "type": "http",
      "url": "http://127.0.0.1:47600/mcp/<token>"
    }
  }
}
```

- `.mcp.json` にはトークンが**平文で**入ります。バージョン管理に含めないでください（`DB Rover: AI 連携: .mcp.json に登録` の実行時に `.gitignore` への追記を提案します）。
- ポートは VS Code の**ウィンドウごとに変わることがあります**（既定 `47600` が使用中なら `47609` まで空きを探し、全滅時は OS 任せのポートになります）。ウィンドウを開き直したときは登録し直してください。
- トークンを失効させたいときは `DB Rover: AI 連携: トークンを再発行` を実行します（既存の `.mcp.json` の登録は無効になります）。
- 接続ごとに記憶した書き込みの許可は `DB Rover: AI 連携: 書き込みの許可をリセット` で消せます。
- 状態（起動しているか・ポート番号など）は `DB Rover: AI 連携: 状態を表示` で確認できます（トークンはマスクされます）。

### Copilot Chat（Language Model Tools）

`dbRover.ai.languageModelTools.enabled`（既定 `true`）が有効なら、追加設定なしで Copilot Chat から上記 4 本のツールを使えます。VS Code 自身の確認 UI が承認を挟みます。MCP サーバも同時に有効にすると、Copilot からは同じツールが 2 系統（Language Model Tools と MCP）見えることがあります。

## キーバインド

| 操作 | キー |
|---|---|
| カーソルに一番近い文をハイライト／実行（`.sql` エディタで有効） | `Ctrl+Enter` / `Cmd+Enter` |
| ハイライト中の文を実行 | `Enter` |
| ハイライトを解除 | `Escape` |
| すべての文を実行 | `Ctrl+Shift+Enter` / `Cmd+Shift+Enter` |
| テーブルビューの変更を保存（テーブルビューがアクティブなとき） | `Ctrl+S` / `Cmd+S` |
| テーブルビューを再読み込み（テーブルビューがアクティブなとき） | `Ctrl+R` / `Cmd+R` |
| ツリーを再読み込み（接続ツリーにフォーカスがあるとき） | `Ctrl+R` / `Cmd+R` |

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
- テーブル名で絞り込み / 絞り込みを解除
- 新しいクエリ / クエリを実行
- テーブルを開く / データをプレビュー（同じ動作のエイリアス）
- テーブルの変更を保存 / テーブルビューを再読み込み
- 名前をコピー
- アクティブ接続を選択（ステータスバーの `$(database)` アイコンからも実行できます）
- はじめに（使い方）— ようこそ画面のウォークスルーを開きます
- AI 連携: MCP サーバを開始 / MCP サーバを停止
- AI 連携: MCP の設定をコピー / .mcp.json に登録
- AI 連携: 状態を表示 / トークンを再発行 / 書き込みの許可をリセット

## SQLite の実装について

ネイティブビルド依存を避けるため `node-sqlite3-wasm` を使用しています。
