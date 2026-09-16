import type { ExportFormat, QueryResult } from '../types.js';

const DELIMITERS: Record<ExportFormat, string> = { csv: ',', tsv: '\t' };

export const EXPORT_LABELS: Record<ExportFormat, string> = { csv: 'CSV', tsv: 'TSV' };

/**
 * 区切り文字・改行・引用符を含む値は引用符で囲み、引用符は 2 つ重ねて逃がす。
 *
 * TSV に決まった引用規則は無いが、表計算ソフトは CSV と同じ書き方を読めるので揃えておく。
 * 区切りごとに判定を変えているのは、CSV のタブや TSV のカンマまで囲ってしまわないため。
 */
function escapeField(value: unknown, delimiter: string): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (text.includes(delimiter) || /["\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/** 設定から読んだ値が壊れていても落ちないように、既定（CSV）へ倒す。 */
export function normalizeExportFormat(value: unknown): ExportFormat {
  return value === 'tsv' ? 'tsv' : 'csv';
}

export function toDelimitedText(result: QueryResult, format: ExportFormat): string {
  const delimiter = DELIMITERS[format];
  const lines: string[] = [];
  lines.push(result.columns.map((column) => escapeField(column, delimiter)).join(delimiter));
  for (const row of result.rows) {
    lines.push(row.map((value) => escapeField(value, delimiter)).join(delimiter));
  }
  return lines.join('\r\n');
}
