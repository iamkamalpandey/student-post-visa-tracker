// Round-trip tests for the export writers. We pair each writer against the matching
// importer's parser so identical-rows-out is the load-bearing assertion.

import { describe, it, expect } from 'vitest';
import { writeCsv, writeJsonl, writeJson } from '../src/modules/exports/writers.js';
import { parseCsvStream, parseJsonlStream, parseJsonStream } from '../src/modules/imports/parsers.js';

async function* iter<T>(arr: T[]): AsyncIterable<T> {
  for (const v of arr) yield v;
}

async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

describe('CSV writer round-trip', () => {
  it('round-trips identical rows through the parser', async () => {
    const rows = [
      { a: 'plain', b: 'value' },
      { a: 'with, comma', b: 'with "quote"' },
      { a: 'multi\nline', b: 'tab\there' },
    ];
    const stream = writeCsv(iter(rows), ['a', 'b']);
    const buf = await drain(stream);

    const parsed = await collect(parseCsvStream(buf));
    expect(parsed).toEqual(rows);
  });

  it('writes a UTF-8 BOM as the first three bytes', async () => {
    const stream = writeCsv(iter([{ a: '1' }]), ['a']);
    const buf = await drain(stream);
    expect(buf[0]).toBe(0xef);
    expect(buf[1]).toBe(0xbb);
    expect(buf[2]).toBe(0xbf);
  });

  it('coerces bigint, Date, and null safely', async () => {
    const d = new Date('2025-01-31T12:34:56.000Z');
    const stream = writeCsv(
      iter([{ a: 100n, b: d, c: null, d: undefined }]),
      ['a', 'b', 'c', 'd'],
    );
    const buf = await drain(stream);
    const parsed = await collect(parseCsvStream(buf));
    expect(parsed).toEqual([
      { a: '100', b: '2025-01-31T12:34:56.000Z', c: '', d: '' },
    ]);
  });
});

describe('JSONL writer', () => {
  it('emits one parseable line per row', async () => {
    const rows = [{ a: 1 }, { a: 2, b: 'x' }];
    const stream = writeJsonl(iter(rows));
    const buf = await drain(stream);
    const parsed = await collect(parseJsonlStream(buf));
    expect(parsed).toEqual(rows);
  });
});

describe('JSON writer', () => {
  it('produces a {data:[...]} document the JSON parser yields per element', async () => {
    const rows = [{ a: 1 }, { a: 2 }];
    const stream = writeJson(iter(rows));
    const buf = await drain(stream);
    const parsed = await collect(parseJsonStream(buf));
    expect(parsed).toEqual(rows);
  });

  it('produces a valid JSON document for an empty input', async () => {
    const stream = writeJson(iter<unknown>([]));
    const buf = await drain(stream);
    const parsed = JSON.parse(buf.toString('utf8'));
    expect(parsed).toEqual({ data: [] });
  });
});
