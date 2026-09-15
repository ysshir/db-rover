/**
 * SQL ドキュメントの先頭コメントに実行先の接続を書き出す／読み取るための純粋関数群。
 *
 * ウィンドウを再読み込みすると untitled の URI は別の文書に振り直されるため、
 * メモリ上の束縛だけでは実行先が失われる。ドキュメント自身の先頭コメントに
 * 書いておけば、再読み込みしても・ファイルを共有しても実行先が分かる。
 *
 * vscode に依存させない（scripts/check-connection-comment.mjs で単体検証するため）。
 */

/** 先頭コメントの書式。`-- db-rover: 名前 (kind) [id]` */
const MARKER_PATTERN = /^[ \t]*(?:--|#)[ \t]*db-rover[ \t]*:[ \t]*(.*?)[ \t]*$/i;
/** 参照末尾の `[id]`。id は接続の一意キーなので、あればこれを最優先で使う。 */
const ID_PATTERN = /\[([^[\]]+)\][ \t]*$/;
/** 行コメントで始まる行。ブロックコメントは扱わず、そこで走査を打ち切る。 */
const LINE_COMMENT_PATTERN = /^[ \t]*(?:--|#)/;
/** 先頭のコメント塊だけを見る。SQL 本体に入ったら打ち切るので、実質の上限。 */
export const HEAD_LINE_LIMIT = 20;

export interface ConnectionCommentRef {
  /** `db-rover:` の後ろの文字列。id か接続名を指す。 */
  ref: string;
  /** マーカー行の開始オフセット（改行を含まない）。 */
  start: number;
  /** マーカー行の終了オフセット（改行を含まない）。 */
  end: number;
}

export interface ConnectionCommentEdit {
  /** 置き換える範囲の開始オフセット。挿入のときは start === end === 0。 */
  start: number;
  end: number;
  /** 置き換え後の文字列。 */
  insert: string;
  /** この編集で先頭がずれる文字数。オフセットの補正に使う。 */
  delta: number;
}

/** 先頭のコメント塊からマーカー行を探す。見つからなければ undefined。 */
export function findConnectionComment(text: string): ConnectionCommentRef | undefined {
  let offset = 0;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length && index < HEAD_LINE_LIMIT; index += 1) {
    const raw = lines[index];
    // 行末の \r を落としつつ、オフセットは元の長さで進める。
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim() === '') {
      offset += raw.length + 1;
      continue;
    }
    if (!LINE_COMMENT_PATTERN.test(line)) {
      // SQL 本体が始まった。これ以降にマーカーがあっても先頭コメントではない。
      return undefined;
    }
    const matched = MARKER_PATTERN.exec(line);
    if (matched) {
      return { ref: matched[1], start: offset, end: offset + line.length };
    }
    offset += raw.length + 1;
  }
  return undefined;
}

/** 接続からマーカー行を作る。 */
export function formatConnectionComment(config: { id: string; name: string; kind: string }): string {
  const name = config.name.replace(/[\r\n]+/g, ' ').trim();
  return `-- db-rover: ${name} (${config.kind}) [${config.id}]`;
}

/**
 * マーカー行の参照から接続を引く。
 * `[id]` があれば id で、無ければ id → 名前（大文字小文字を無視）の順で探す。
 * 手書きで `-- db-rover: 本番DB` と書いても効くようにするため。
 */
export function resolveConnectionRef<T extends { id: string; name: string }>(
  ref: string,
  connections: readonly T[],
): T | undefined {
  const trimmed = ref.trim();
  if (trimmed === '') {
    return undefined;
  }
  const bracketed = ID_PATTERN.exec(trimmed);
  if (bracketed) {
    const id = bracketed[1].trim();
    return connections.find((connection) => connection.id === id);
  }
  return (
    connections.find((connection) => connection.id === trimmed) ??
    connections.find((connection) => connection.name === trimmed) ??
    connections.find((connection) => connection.name.toLowerCase() === trimmed.toLowerCase())
  );
}

/**
 * マーカー行を差し替える（無ければ先頭に挿入する）ための編集を組み立てる。
 * すでに同じ内容ならドキュメントを汚さないよう undefined を返す。
 */
export function planConnectionComment(text: string, comment: string): ConnectionCommentEdit | undefined {
  const found = findConnectionComment(text);
  if (!found) {
    const insert = `${comment}\n`;
    return { start: 0, end: 0, insert, delta: insert.length };
  }
  const current = text.slice(found.start, found.end);
  if (current === comment) {
    return undefined;
  }
  return {
    start: found.start,
    end: found.end,
    insert: comment,
    delta: comment.length - (found.end - found.start),
  };
}
