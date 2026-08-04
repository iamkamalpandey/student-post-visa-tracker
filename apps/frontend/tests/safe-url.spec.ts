// SVT-QA-2026-08 — XSS guards on user-supplied URL fields.
//
// `website` / `url` / `contract_url` / `action_url` come from CRM imports and
// admin input and flow straight into `<a href={…}>`. A `javascript:` value
// there is a one-click XSS in the app's own origin. These helpers are the
// render-time gate; this suite pins the exact attack shapes they must refuse,
// so a future "simplification" of the regex cannot quietly reopen the hole.

import { describe, it, expect } from 'vitest';
import { safeHref } from '@/lib/safeHref';
import { safeExternalUrl } from '@/lib/safeUrl';

describe('safeHref — scheme allowlist', () => {
  it.each([
    ['https://example.com/x', 'https://example.com/x'],
    ['http://example.com', 'http://example.com'],
    ['mailto:a@b.com', 'mailto:a@b.com'],
    ['tel:+9779800000000', 'tel:+9779800000000'],
    ['/students/123', '/students/123'],
    ['  https://example.com  ', 'https://example.com'],
  ])('allows %s', (input, expected) => {
    expect(safeHref(input)).toBe(expected);
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '  javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ])('rejects the executable scheme %s', (input) => {
    expect(safeHref(input)).toBeUndefined();
  });

  it('rejects protocol-relative URLs', () => {
    // These inherit the page protocol AND host-parsing rules — behind a future
    // proxy a click could land on an attacker-controlled origin.
    expect(safeHref('//evil.com/path')).toBeUndefined();
  });

  it('rejects empty, whitespace-only, and non-string input', () => {
    expect(safeHref('')).toBeUndefined();
    expect(safeHref('   ')).toBeUndefined();
    expect(safeHref(null)).toBeUndefined();
    expect(safeHref(undefined)).toBeUndefined();
    expect(safeHref(123 as unknown as string)).toBeUndefined();
  });

  it('rejects a bare hostname with no scheme (would resolve relative)', () => {
    expect(safeHref('evil.com')).toBeUndefined();
  });
});

describe('safeExternalUrl — http(s) only, returns null on reject', () => {
  it('allows http and https and normalises via URL', () => {
    expect(safeExternalUrl('https://example.com')).toBe('https://example.com/');
    expect(safeExternalUrl('http://example.com/a?b=1')).toBe('http://example.com/a?b=1');
  });

  it('is STRICTER than safeHref — no mailto, tel, or relative paths', () => {
    // These are category errors for an "external URL" field and almost always
    // signal a bug upstream, so this helper refuses what safeHref accepts.
    expect(safeHref('mailto:a@b.com')).toBe('mailto:a@b.com');
    expect(safeExternalUrl('mailto:a@b.com')).toBeNull();

    expect(safeHref('/students/1')).toBe('/students/1');
    expect(safeExternalUrl('/students/1')).toBeNull();
  });

  it.each(['javascript:alert(1)', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd'])(
    'rejects %s',
    (input) => {
      expect(safeExternalUrl(input)).toBeNull();
    },
  );

  it('rejects malformed URLs that pass the scheme prefix check', () => {
    // Prefix looks fine, but `new URL` cannot parse it — must not leak through.
    expect(safeExternalUrl('https://')).toBeNull();
  });

  it('rejects null / undefined / empty', () => {
    expect(safeExternalUrl(null)).toBeNull();
    expect(safeExternalUrl(undefined)).toBeNull();
    expect(safeExternalUrl('   ')).toBeNull();
  });
});
