/**
 * ツリーのテーブル／ビュー名を絞り込むための純粋関数。
 *
 * 入力は人が手で書く短い文字列なので、正規表現ではなく次の素朴な規則にしている。
 * - 大文字小文字は区別しない
 * - 空白区切りの語はすべて含む（AND）
 * - `*` はワイルドカード（その語だけ「含む」ではなく全体一致になる）
 */

/** 空白だけの入力を「絞り込みなし」に正規化する。 */
export function normalizeFilter(raw: string | undefined): string | undefined {
  const value = (raw ?? '').trim();
  return value.length > 0 ? value : undefined;
}

/** name が filter に一致するか。filter が未設定なら常に true。 */
export function matchesFilter(name: string, filter: string | undefined): boolean {
  const normalized = normalizeFilter(filter);
  if (!normalized) {
    return true;
  }
  const target = name.toLowerCase();
  return normalized
    .toLowerCase()
    .split(/\s+/)
    .every((term) => (term.includes('*') ? globMatches(target, term) : target.includes(term)));
}

/** `*` だけを特別扱いするグロブ一致。それ以外の文字は正規表現として無害化する。 */
function globMatches(target: string, term: string): boolean {
  const pattern = term
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${pattern}$`).test(target);
}
