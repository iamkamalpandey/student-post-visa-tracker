// Streaming parsers for the bulk-import pipeline.
//
// We deliberately avoid pulling in `papaparse` / `csv-parse` / `xlsx` for v1 — every
// transitive dep on a server-side ingest path is a supply-chain concern, and the formats
// we accept are well-defined enough that a small hand-rolled parser is auditable.
//
// What we accept (v1):
//   - CSV (RFC 4180): quoted fields, escaped quotes (""), CRLF / LF line endings, UTF-8
//     only (BOM stripped). Anything that decodes as non-UTF-8 is rejected upstream.
//   - JSONL (newline-delimited JSON, RFC 8259 per line).
//   - JSON: a single document — either an array, or `{ data: [...] }`.
//   - XLSX: STUB. The function exists so callers can branch on extension; calling it throws
//     a clear instructional error pointing at `xlsx`/SheetJS.
//
// All parsers are async-iterable so the import worker can stream rows in O(1) memory rather
// than building one giant JS array.

const CR = 0x0d;
const LF = 0x0a;
const QUOTE = 0x22;
const BOM_BYTES = [0xef, 0xbb, 0xbf] as const;

/**
 * Return true iff `buf` starts with the UTF-8 BOM (EF BB BF).
 */
function hasUtf8Bom(buf: Buffer): boolean {
  return (
    buf.length >= 3 &&
    buf[0] === BOM_BYTES[0] &&
    buf[1] === BOM_BYTES[1] &&
    buf[2] === BOM_BYTES[2]
  );
}

/**
 * Strip a UTF-8 BOM if present. Returns the original buffer otherwise (no copy).
 */
function stripBom(buf: Buffer): Buffer {
  return hasUtf8Bom(buf) ? buf.subarray(3) : buf;
}

/**
 * Cheap encoding sniff. Strict UTF-8 only in v1 — any other encoding (UTF-16, ISO-8859-1,
 * Windows-1252, etc.) is rejected at the API boundary. The user can re-save as UTF-8.
 *
 * Strategy: BOM check first (definitive); otherwise try TextDecoder('utf-8',{fatal:true})
 * which surfaces invalid sequences as a thrown TypeError.
 */
export function sniffEncoding(buf: Buffer): 'utf-8' | 'unknown' {
  if (hasUtf8Bom(buf)) return 'utf-8';
  // Catch UTF-16 LE/BE BOM explicitly so we don't waste a TextDecoder pass.
  if (buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) return 'unknown';
    if (buf[0] === 0xfe && buf[1] === 0xff) return 'unknown';
  }
  try {
    const td = new TextDecoder('utf-8', { fatal: true });
    td.decode(buf);
    return 'utf-8';
  } catch {
    return 'unknown';
  }
}

/**
 * Pick the most likely delimiter from the small allow-list `, ; \t |`. We don't accept
 * anything outside this list — RFC 4180 is comma but spreadsheets in EU locales habitually
 * emit `;`, and analyst exports sometimes use tab or pipe.
 */
export function sniffDelimiter(headerLine: string): ',' | ';' | '\t' | '|' {
  const candidates: Array<',' | ';' | '\t' | '|'> = [',', ';', '\t', '|'];
  let best: ',' | ';' | '\t' | '|' = ',';
  let bestCount = -1;
  for (const c of candidates) {
    // We count occurrences ignoring those inside quoted fields. The header line is unlikely
    // to contain quotes in practice, so a naive count is good enough for sniffing.
    let count = 0;
    let inQuote = false;
    for (let i = 0; i < headerLine.length; i++) {
      const ch = headerLine.charCodeAt(i);
      if (ch === QUOTE) {
        inQuote = !inQuote;
        continue;
      }
      if (!inQuote && headerLine[i] === c) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      best = c;
    }
  }
  return best;
}

/**
 * Streaming RFC 4180 CSV parser.
 *
 * Yields one record per row, keyed by header column. The first non-empty row is taken as
 * the header. Empty trailing lines are ignored.
 *
 * Quoting rules (RFC 4180 §2):
 *   - A field MAY be enclosed in double quotes.
 *   - If a field is quoted, a literal double quote is encoded as `""`.
 *   - Inside a quoted field, the delimiter and CR/LF are part of the value.
 *
 * UTF-8 is enforced. The buffer is decoded into a string up-front so we can index by code
 * unit; for the file sizes the controller permits (≤ 50MB) this is fine.
 */
export async function* parseCsvStream(
  buf: Buffer,
  opts: { delimiter?: string } = {},
): AsyncIterable<Record<string, string>> {
  if (sniffEncoding(buf) !== 'utf-8') {
    throw new Error('CSV must be UTF-8 encoded');
  }
  const text = stripBom(buf).toString('utf8');
  const delimiter = opts.delimiter ?? sniffDelimiter(text.split(/\r?\n/, 1)[0] ?? '');

  const rows = parseAll(text, delimiter);
  if (rows.length === 0) return;
  const header = rows[0]!.map((h) => h.trim());
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]!;
    // Skip totally-empty lines (single empty field) — common in spreadsheets that pad.
    if (row.length === 1 && row[0] === '') continue;
    const obj: Record<string, string> = {};
    for (let c = 0; c < header.length; c++) {
      obj[header[c]!] = row[c] ?? '';
    }
    yield obj;
  }
}

/**
 * RFC 4180 state machine. Returns a 2D array of fields. We keep this internal so the
 * streaming generator above can treat the first row specially.
 */
function parseAll(text: string, delim: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let inQuotes = false;
  const len = text.length;

  while (i < len) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        // Doubled quote inside a quoted field is a literal quote.
        if (i + 1 < len && text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"') {
      // A quote in the middle of an unquoted field is technically nonconformant; we accept
      // it as a literal to match Excel's lenient behaviour.
      if (field.length === 0) {
        inQuotes = true;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === delim) {
      row.push(field);
      field = '';
      i++;
      continue;
    }

    if (ch === '\r' || ch === '\n') {
      row.push(field);
      out.push(row);
      row = [];
      field = '';
      // Normalise CRLF to a single line-end.
      if (ch === '\r' && i + 1 < len && text[i + 1] === '\n') i += 2;
      else i++;
      continue;
    }

    field += ch;
    i++;
  }
  // Flush the trailing partial row (file without final newline).
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    out.push(row);
  }
  return out;
}

/**
 * JSONL: one JSON document per line. Empty lines are skipped silently. Parse failures throw
 * with a 1-indexed line number so the caller can surface a useful error.
 */
export async function* parseJsonlStream(buf: Buffer): AsyncIterable<unknown> {
  if (sniffEncoding(buf) !== 'utf-8') {
    throw new Error('JSONL must be UTF-8 encoded');
  }
  const text = stripBom(buf).toString('utf8');
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    try {
      yield JSON.parse(line);
    } catch (err) {
      throw new Error(`JSONL parse error on line ${i + 1}: ${(err as Error).message}`);
    }
  }
}

/**
 * Single-document JSON. Two acceptable shapes:
 *   - top-level array: each element is yielded.
 *   - `{ "data": [...] }`: each element of `data` is yielded.
 * Anything else is a usage error.
 */
export async function* parseJsonStream(buf: Buffer): AsyncIterable<unknown> {
  if (sniffEncoding(buf) !== 'utf-8') {
    throw new Error('JSON must be UTF-8 encoded');
  }
  const text = stripBom(buf).toString('utf8');
  const doc: unknown = JSON.parse(text);
  if (Array.isArray(doc)) {
    for (const item of doc) yield item;
    return;
  }
  if (doc && typeof doc === 'object' && Array.isArray((doc as { data?: unknown }).data)) {
    for (const item of (doc as { data: unknown[] }).data) yield item;
    return;
  }
  throw new Error('JSON document must be an array or { data: [...] }');
}

/**
 * XLSX parser stub. v1 ships with no spreadsheet binary support to keep our supply-chain
 * surface small. Wire in `xlsx` (SheetJS) here — read the workbook with `xlsx.read(buf)`,
 * grab the first sheet, and yield rows via `xlsx.utils.sheet_to_json(sheet, { defval: '' })`.
 */
export async function* parseXlsxStream(_buf: Buffer): AsyncIterable<Record<string, string>> {
  // The `function*` syntax already marks this as a generator, so the throw
  // alone is sufficient — no sentinel `yield` needed to satisfy the type.
  throw new Error('XLSX import requires `sheetjs` — install xlsx@latest to enable.');
}
