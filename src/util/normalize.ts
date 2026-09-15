const MAX_BUFFER_PREVIEW_BYTES = 32;

/**
 * ドライバから取得した生の値をシリアライズ可能な値に正規化する。
 * - Date は ISO 文字列
 * - Buffer / Uint8Array は 0x... （先頭 32 バイトまで + ...）
 * - null はそのまま null
 * - bigint は文字列
 * - オブジェクト / 配列は JSON.stringify
 */
export function normalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (Buffer.isBuffer(value)) {
    return bufferToHexPreview(value);
  }
  if (value instanceof Uint8Array) {
    return bufferToHexPreview(Buffer.from(value));
  }
  if (Array.isArray(value)) {
    return JSON.stringify(value);
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return value;
}

function bufferToHexPreview(buffer: Buffer): string {
  const truncated = buffer.length > MAX_BUFFER_PREVIEW_BYTES;
  const slice = truncated ? buffer.subarray(0, MAX_BUFFER_PREVIEW_BYTES) : buffer;
  const hex = `0x${slice.toString('hex')}`;
  return truncated ? `${hex}…` : hex;
}

export function normalizeRow(row: unknown[]): unknown[] {
  return row.map(normalizeValue);
}
