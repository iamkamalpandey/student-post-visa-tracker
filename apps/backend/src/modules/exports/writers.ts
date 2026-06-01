// Streaming export writers built on Node primitives.
//
// Why not pull `fast-csv` or `JSONStream` for v1? Same supply-chain rationale as the import
// parsers: every dep is a vector. The CSV writer is straight RFC 4180; the JSON wrappers are
// trivial. Performance is more than adequate at our v1 volumes (≤ 1M rows / export).
//
// Each writer returns a `Readable` so downstream code (storage put, sha256 stream, signed
// download stream) can pipe without buffering the full payload in memory.

import { Readable } from 'node:stream';

/**
 * Quote an arbitrary value for inclusion in an RFC 4180 CSV cell. We always quote when:
 *   - the field contains a comma, double-quote, CR or LF,
 *   - the field starts or ends with whitespace (defensive — Excel trims silently otherwise).
 * Numbers / booleans / null are stringified deterministically.
 */
// SVT-AUDIT-SEC-CSV-2026-05 — CSV injection prevention.
//
// Excel + Google Sheets evaluate any cell starting with `=`, `+`, `-`, `@`,
// `\t`, `\r` as a formula. An attacker who injects e.g.
// `=cmd|'/c calc'!A1` into a free-text field (notes, names, etc.) can
// trigger code execution when an admin opens the exported CSV.
//
// Mitigation: prefix any such cell with a leading single quote. Excel
// renders the quote as content and refuses to evaluate the formula. RFC
// 4180 doesn't care — the leading quote is just data.
//
// Applies to BOTH data cells and header names (since custom attribute
// definitions could supply attacker-controlled column labels).
const FORMULA_LEAD = /^[=+\-@\t\r]/;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (typeof value === 'string') s = value;
  else if (typeof value === 'number' || typeof value === 'boolean') s = String(value);
  else if (typeof value === 'bigint') s = value.toString(10);
  else if (value instanceof Date) s = value.toISOString();
  else s = JSON.stringify(value);
  if (FORMULA_LEAD.test(s)) {
    s = `'${s}`;
  }
  if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Write a stream of row objects as RFC 4180 CSV. The first byte is the UTF-8 BOM so Excel
 * recognises the encoding without prompting for a delimiter.
 */
export function writeCsv(
  rows: AsyncIterable<Record<string, unknown>>,
  columns: string[],
): Readable {
  const out = new Readable({ read() { /* push-driven below */ } });

  (async () => {
    try {
      // BOM (EF BB BF) so Excel decodes UTF-8 correctly.
      out.push(Buffer.from([0xef, 0xbb, 0xbf]));
      out.push(columns.map(csvCell).join(',') + '\r\n');
      for await (const row of rows) {
        const line = columns.map((c) => csvCell(row[c])).join(',') + '\r\n';
        if (!out.push(line)) {
          // Wait for drain — backpressure across the storage stream.
          await new Promise<void>((resolve) => out.once('data', () => resolve()));
        }
      }
      out.push(null);
    } catch (err) {
      out.destroy(err as Error);
    }
  })();

  return out;
}

/** JSON Lines: one document per line. RFC 8259 per line; empty lines are not emitted. */
export function writeJsonl(rows: AsyncIterable<unknown>): Readable {
  const out = new Readable({ read() {} });
  (async () => {
    try {
      for await (const row of rows) {
        out.push(JSON.stringify(row) + '\n');
      }
      out.push(null);
    } catch (err) {
      out.destroy(err as Error);
    }
  })();
  return out;
}

/**
 * Wrapped JSON: `{"data":[ row, row, ... ]}`. We stream the array elements with
 * comma separators so the consumer receives a single well-formed JSON document without us
 * ever materialising the whole array.
 */
export function writeJson(rows: AsyncIterable<unknown>): Readable {
  const out = new Readable({ read() {} });
  (async () => {
    try {
      out.push('{"data":[');
      let first = true;
      for await (const row of rows) {
        out.push((first ? '' : ',') + JSON.stringify(row));
        first = false;
      }
      out.push(']}');
      out.push(null);
    } catch (err) {
      out.destroy(err as Error);
    }
  })();
  return out;
}

/**
 * XLSX writer stub. v1 ships without a spreadsheet binary writer to keep the dep tree small.
 * Wire `exceljs` here — instantiate `new ExcelJS.stream.xlsx.WorkbookWriter`, add a sheet,
 * iterate `rows` with `worksheet.addRow(...)` and `.commit()` per row, then `.commit()` the
 * workbook to the output stream.
 */
export function writeXlsx(_rows: AsyncIterable<Record<string, unknown>>, _columns: string[]): Readable {
  throw new Error('XLSX export requires `exceljs`. Install to enable.');
}
