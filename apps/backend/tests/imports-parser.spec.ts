// Parser-level tests for the bulk-import streaming pipeline. We focus on the high-risk
// edge cases (RFC 4180 quoting, line endings, BOM, encoding rejection) rather than re-test
// the obvious happy path.

import { describe, it, expect } from 'vitest';
import {
  parseCsvStream,
  parseJsonlStream,
  sniffEncoding,
  sniffDelimiter,
} from '../src/modules/imports/parsers.js';

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe('CSV parser', () => {
  it('parses a simple CSV with LF line endings', async () => {
    const buf = Buffer.from('a,b,c\n1,2,3\n4,5,6\n', 'utf8');
    const rows = await collect(parseCsvStream(buf));
    expect(rows).toEqual([
      { a: '1', b: '2', c: '3' },
      { a: '4', b: '5', c: '6' },
    ]);
  });

  it('handles CRLF line endings', async () => {
    const buf = Buffer.from('a,b\r\n1,2\r\n3,4\r\n', 'utf8');
    const rows = await collect(parseCsvStream(buf));
    expect(rows).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
  });

  it('handles quoted fields with embedded commas', async () => {
    const buf = Buffer.from('a,b\n"hello, world","x"\n', 'utf8');
    const rows = await collect(parseCsvStream(buf));
    expect(rows).toEqual([{ a: 'hello, world', b: 'x' }]);
  });

  it('handles RFC 4180 escaped quotes ("")', async () => {
    const buf = Buffer.from('a,b\n"she said ""hi""",ok\n', 'utf8');
    const rows = await collect(parseCsvStream(buf));
    expect(rows).toEqual([{ a: 'she said "hi"', b: 'ok' }]);
  });

  it('handles embedded newlines inside quoted fields', async () => {
    const buf = Buffer.from('a,b\n"line1\nline2",x\n', 'utf8');
    const rows = await collect(parseCsvStream(buf));
    expect(rows).toEqual([{ a: 'line1\nline2', b: 'x' }]);
  });

  it('strips a UTF-8 BOM', async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const body = Buffer.from('a,b\n1,2\n', 'utf8');
    const rows = await collect(parseCsvStream(Buffer.concat([bom, body])));
    expect(rows).toEqual([{ a: '1', b: '2' }]);
  });

  it('rejects a UTF-16 LE encoded buffer', async () => {
    // 0xFF 0xFE is the UTF-16 LE BOM.
    const buf = Buffer.from([0xff, 0xfe, 0x61, 0x00]);
    await expect(collect(parseCsvStream(buf))).rejects.toThrow(/UTF-8/);
  });
});

describe('sniffEncoding', () => {
  it('returns utf-8 for a plain ASCII buffer', () => {
    expect(sniffEncoding(Buffer.from('hello', 'utf8'))).toBe('utf-8');
  });

  it('returns utf-8 when the BOM is present', () => {
    expect(sniffEncoding(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toBe('utf-8');
  });

  it('returns unknown for a UTF-16 LE buffer', () => {
    expect(sniffEncoding(Buffer.from([0xff, 0xfe, 0x61, 0x00]))).toBe('unknown');
  });

  it('returns unknown for a UTF-16 BE buffer', () => {
    expect(sniffEncoding(Buffer.from([0xfe, 0xff, 0x00, 0x61]))).toBe('unknown');
  });
});

describe('sniffDelimiter', () => {
  it('detects comma', () => {
    expect(sniffDelimiter('a,b,c,d')).toBe(',');
  });
  it('detects semicolon', () => {
    expect(sniffDelimiter('a;b;c;d')).toBe(';');
  });
  it('detects tab', () => {
    expect(sniffDelimiter('a\tb\tc\td')).toBe('\t');
  });
  it('detects pipe', () => {
    expect(sniffDelimiter('a|b|c|d')).toBe('|');
  });
});

describe('JSONL parser', () => {
  it('skips empty lines', async () => {
    const buf = Buffer.from('{"a":1}\n\n{"a":2}\n', 'utf8');
    const rows = await collect(parseJsonlStream(buf));
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('throws with the offending line number on a parse failure', async () => {
    const buf = Buffer.from('{"a":1}\n{not json}\n', 'utf8');
    await expect(collect(parseJsonlStream(buf))).rejects.toThrow(/line 2/);
  });

  it('handles trailing newline + CRLF', async () => {
    const buf = Buffer.from('{"a":1}\r\n{"a":2}\r\n', 'utf8');
    const rows = await collect(parseJsonlStream(buf));
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
  });
});
