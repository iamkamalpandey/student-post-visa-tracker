// Tests the magic-byte sniffer in modules/documents/mime.ts.
// We construct minimal byte sequences that match the documented signatures
// and assert: (a) detection succeeds when header hint == sniffed type, and
// (b) detection rejects mismatches and unknown types.

import { describe, it, expect, vi } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3000');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const { detectMime, ALLOWED_MIME, MAX_UPLOAD_BYTES, mimeToExt } = await import(
  '../src/modules/documents/mime.js'
);

function buf(...bytes: number[]): Buffer {
  return Buffer.from(bytes);
}

describe('detectMime — happy path per format', () => {
  it('detects PDF via "%PDF-"', () => {
    const b = Buffer.concat([buf(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37), Buffer.alloc(64)]);
    const r = detectMime(b, 'application/pdf');
    expect(r).toEqual({ detected: 'application/pdf', allowed: true });
  });

  it('detects PNG via 89 50 4E 47 0D 0A 1A 0A', () => {
    const b = Buffer.concat([buf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), Buffer.alloc(64)]);
    const r = detectMime(b, 'image/png');
    expect(r.allowed).toBe(true);
    expect(r.detected).toBe('image/png');
  });

  it('detects JPEG via FF D8 FF', () => {
    const b = Buffer.concat([buf(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10), Buffer.alloc(64)]);
    const r = detectMime(b, 'image/jpeg');
    expect(r.allowed).toBe(true);
    expect(r.detected).toBe('image/jpeg');
  });

  it('detects WEBP via RIFF....WEBP', () => {
    const b = Buffer.concat([
      Buffer.from('RIFF'),
      buf(0x00, 0x00, 0x00, 0x00),
      Buffer.from('WEBP'),
      Buffer.alloc(64),
    ]);
    const r = detectMime(b, 'image/webp');
    expect(r.allowed).toBe(true);
    expect(r.detected).toBe('image/webp');
  });

  it('detects HEIC via ftyp+heic brand', () => {
    const b = Buffer.concat([
      buf(0x00, 0x00, 0x00, 0x18),
      Buffer.from('ftyp'),
      Buffer.from('heic'),
      Buffer.alloc(64),
    ]);
    const r = detectMime(b, 'image/heic');
    expect(r.allowed).toBe(true);
    expect(r.detected).toBe('image/heic');
  });

  // SVT-QA-2026-08 (DOCS-H5) — these two used to pass a BARE ZIP header and
  // assert acceptance, which encoded the vulnerability: the sniffer trusted
  // the client's Content-Type, so any archive (including a zip bomb) could be
  // stored and later served labelled as an Office document. The sniffer now
  // verifies the OOXML container shape from the raw bytes, so the fixtures
  // carry the entry names a real package has.
  it('accepts a genuine docx container when hint is docx', () => {
    const b = Buffer.concat([
      buf(0x50, 0x4b, 0x03, 0x04),
      Buffer.from('[Content_Types].xml\0word/document.xml\0_rels/.rels', 'ascii'),
    ]);
    const r = detectMime(b, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(r.allowed).toBe(true);
    expect(r.detected).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });

  it('accepts a genuine xlsx container when hint is xlsx', () => {
    const b = Buffer.concat([
      buf(0x50, 0x4b, 0x03, 0x04),
      Buffer.from('[Content_Types].xml\0xl/workbook.xml\0_rels/.rels', 'ascii'),
    ]);
    const r = detectMime(b, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(r.allowed).toBe(true);
    expect(r.detected).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  });

  it('rejects a bare ZIP that merely CLAIMS to be docx', () => {
    const b = Buffer.concat([buf(0x50, 0x4b, 0x03, 0x04), Buffer.alloc(64)]);
    const r = detectMime(b, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(r.allowed).toBe(false);
    expect(r.detected).toBeNull();
  });
});

describe('detectMime — rejection paths', () => {
  it('rejects when header hint disagrees with sniffed type', () => {
    const pngBytes = Buffer.concat([buf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), Buffer.alloc(64)]);
    const r = detectMime(pngBytes, 'application/pdf');
    expect(r.allowed).toBe(false);
    expect(r.detected).toBe('image/png');
  });

  it('rejects unknown magic bytes', () => {
    const r = detectMime(Buffer.from('garbage data here'), 'application/pdf');
    expect(r.allowed).toBe(false);
    expect(r.detected).toBeNull();
  });

  it('rejects ZIP magic with a non-OOXML hint', () => {
    const b = Buffer.concat([buf(0x50, 0x4b, 0x03, 0x04), Buffer.alloc(64)]);
    const r = detectMime(b, 'application/zip');
    expect(r.allowed).toBe(false);
  });

  it('rejects ftyp with a non-HEIC brand', () => {
    const b = Buffer.concat([
      buf(0x00, 0x00, 0x00, 0x18),
      Buffer.from('ftyp'),
      Buffer.from('mp42'),
      Buffer.alloc(64),
    ]);
    const r = detectMime(b, 'image/heic');
    expect(r.allowed).toBe(false);
    expect(r.detected).toBeNull();
  });

  it('rejects buffers shorter than the minimum sniff window', () => {
    const r = detectMime(Buffer.from([0x25]), 'application/pdf');
    expect(r.allowed).toBe(false);
  });
});

describe('exports', () => {
  it('ALLOWED_MIME contains the expected types', () => {
    expect(ALLOWED_MIME.has('application/pdf')).toBe(true);
    expect(ALLOWED_MIME.has('image/png')).toBe(true);
    expect(ALLOWED_MIME.has('application/octet-stream')).toBe(false);
  });

  it('MAX_UPLOAD_BYTES is 10 MiB', () => {
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
  });

  it('mimeToExt returns sane extensions', () => {
    expect(mimeToExt('application/pdf')).toBe('pdf');
    expect(mimeToExt('image/jpeg')).toBe('jpg');
    expect(mimeToExt('something/unknown')).toBe('bin');
  });
});
