import type { QueryResult } from '../types.js';

function escapeCsvField(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function toCsv(result: QueryResult): string {
  const lines: string[] = [];
  lines.push(result.columns.map(escapeCsvField).join(','));
  for (const row of result.rows) {
    lines.push(row.map(escapeCsvField).join(','));
  }
  return lines.join('\r\n');
}
