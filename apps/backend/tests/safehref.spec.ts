// SVT-SEC-P1-FE1-2026-05 — unit tests for the frontend's safeHref helper.
//
// safeHref is pure (no React / no DOM) so we test it from the backend's
// vitest harness — the frontend doesn't currently ship a unit-test runner
// (only Playwright e2e). Importing the .ts source directly via a relative
// path keeps the tests co-located with the rest of the security suite.

import { describe, it, expect } from 'vitest';
import { safeHref } from '../../frontend/lib/safeHref.js';

describe('safeHref — scheme allowlist', () => {
  it('passes through https URLs unchanged', () => {
    expect(safeHref('https://example.com/path')).toBe('https://example.com/path');
  });

  it('passes through http URLs unchanged', () => {
    expect(safeHref('http://example.com')).toBe('http://example.com');
  });

  it('passes through mailto links', () => {
    expect(safeHref('mailto:user@example.com')).toBe('mailto:user@example.com');
  });

  it('passes through tel links', () => {
    expect(safeHref('tel:+15551234')).toBe('tel:+15551234');
  });

  it('passes through site-relative paths (leading /)', () => {
    expect(safeHref('/students/abc')).toBe('/students/abc');
  });

  it('trims surrounding whitespace before scheme check', () => {
    expect(safeHref('  https://example.com  ')).toBe('https://example.com');
  });

  it('is case-insensitive for the scheme allowlist', () => {
    expect(safeHref('HTTPS://example.com')).toBe('HTTPS://example.com');
    expect(safeHref('MAILTO:user@example.com')).toBe('MAILTO:user@example.com');
  });
});

describe('safeHref — XSS schemes rejected', () => {
  it('returns undefined for javascript: URLs', () => {
    expect(safeHref('javascript:alert(1)')).toBeUndefined();
    expect(safeHref('JaVaScRiPt:alert(1)')).toBeUndefined();
    // Whitespace-padded variant — the trim must NOT smuggle the scheme through.
    expect(safeHref('  javascript:alert(1)  ')).toBeUndefined();
  });

  it('returns undefined for data: URLs (could carry text/html payloads)', () => {
    expect(safeHref('data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==')).toBeUndefined();
  });

  it('returns undefined for vbscript: URLs (legacy IE; still blocked)', () => {
    expect(safeHref('vbscript:msgbox(1)')).toBeUndefined();
  });

  it('returns undefined for unknown schemes (file:, ftp:, chrome:)', () => {
    expect(safeHref('file:///etc/passwd')).toBeUndefined();
    expect(safeHref('ftp://example.com')).toBeUndefined();
    expect(safeHref('chrome://settings')).toBeUndefined();
  });

  it('returns undefined for protocol-relative URLs (no enforced scheme upgrade)', () => {
    // //evil.com would inherit the page's protocol; explicit https:// is required.
    expect(safeHref('//evil.com/path')).toBeUndefined();
  });
});

describe('safeHref — empty / nullish inputs', () => {
  it('returns undefined for an empty string', () => {
    expect(safeHref('')).toBeUndefined();
  });

  it('returns undefined for whitespace-only input', () => {
    expect(safeHref('   ')).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(safeHref(null)).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(safeHref(undefined)).toBeUndefined();
  });

  it('returns undefined for non-string runtime values (defensive)', () => {
    // Forced cast — at the runtime boundary an API response could carry a number.
    expect(safeHref(123 as unknown as string)).toBeUndefined();
    expect(safeHref({} as unknown as string)).toBeUndefined();
  });
});
