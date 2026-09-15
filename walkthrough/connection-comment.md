## 実行先は先頭コメントで決まる

SQL エディタの実行先は、ドキュメントの **1 行目のコメント**に記録されます。

```sql
-- db-rover: Local Postgres (postgres) [local-postgres]

SELECT * FROM users LIMIT 10;
```

- 実行先を変えるには、ステータスバーの `$(database)` か、先頭の CodeLens
  「接続先: ...」をクリックして選び直します。この行も一緒に書き換わります。
- 手で書いても効きます。`[...]` の中は `settings.json` の `dbRover.connections` の `id` です。
  `-- db-rover: Local Postgres` のように接続名だけでも解決されます。
- ウィンドウを再読み込みしても実行先が残るのはこのためです。名前を付けていないエディタは
  URI が振り直されるので、ドキュメント自身に書いておく必要があります。

補完（テーブル名・列名）も、この実行先のスキーマから出ます。
