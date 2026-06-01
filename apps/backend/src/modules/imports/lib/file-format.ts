// File-extension dispatch for the bulk-import parsers + content-type lookup.
// Pulled out of imports.service.ts so the orchestrator stays small.

import {
  parseCsvStream,
  parseJsonStream,
  parseJsonlStream,
} from '../parsers.js';

export type SupportedExt = 'csv' | 'json' | 'jsonl' | 'xlsx';

export function inferExt(filename: string): SupportedExt {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.csv')) return 'csv';
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) return 'jsonl';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return 'xlsx';
  // Default to CSV — most spreadsheets export with that extension and our
  // parser is the most permissive of the three.
  return 'csv';
}

export async function parseByExt(
  buf: Buffer,
  ext: SupportedExt,
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  if (ext === 'csv') {
    for await (const row of parseCsvStream(buf)) out.push(row);
  } else if (ext === 'jsonl') {
    for await (const row of parseJsonlStream(buf)) {
      if (row && typeof row === 'object') out.push(row as Record<string, unknown>);
    }
  } else if (ext === 'json') {
    for await (const row of parseJsonStream(buf)) {
      if (row && typeof row === 'object') out.push(row as Record<string, unknown>);
    }
  } else if (ext === 'xlsx') {
    throw new Error('XLSX import requires `sheetjs` — install xlsx@latest to enable.');
  }
  return out;
}

export function contentTypeFor(ext: SupportedExt): string {
  switch (ext) {
    case 'csv':
      return 'text/csv; charset=utf-8';
    case 'json':
      return 'application/json';
    case 'jsonl':
      return 'application/x-ndjson';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
}
