// SVT-WAVE-BLOCKER-5-2026-05 — SSRF guard for the bulk-import webhook_url.
//
// SafeWebhookUrl refuses anything an attacker could use to reach internal
// services from the future webhook dispatcher:
//   - non-https schemes (http, file, javascript, data, ftp)
//   - IP literals (v4 / v6)
//   - localhost / 127.0.0.1 / 0.0.0.0
//   - .local / .internal / .localhost suffixes
//   - cloud metadata hosts (AWS 169.254.169.254, GCP metadata.google.internal)
//   - empty hostname

import { describe, it, expect } from 'vitest';
import { ApplyImportRequest } from '@spv/zod-schemas';

function parse(url: string | undefined) {
  return ApplyImportRequest.safeParse({
    mapping_json: { foo: 'bar' },
    ...(url === undefined ? {} : { webhook_url: url }),
  });
}

describe('ApplyImportRequest.webhook_url SSRF guard', () => {
  describe('accepted', () => {
    it('omitted webhook_url is fine (optional)', () => {
      expect(parse(undefined).success).toBe(true);
    });

    it('valid https URL on a real domain', () => {
      expect(parse('https://api.example.com/webhooks/import').success).toBe(true);
    });

    it('valid https URL with query string + port', () => {
      expect(parse('https://api.example.com:8443/hook?token=abc').success).toBe(true);
    });

    it('valid https URL with subdomain', () => {
      expect(parse('https://webhooks.tenant.example.co.uk/import').success).toBe(true);
    });
  });

  describe('refused (scheme)', () => {
    it.each([
      ['http', 'http://api.example.com/hook'],
      ['ftp', 'ftp://files.example.com/'],
      ['file', 'file:///etc/passwd'],
      ['javascript', 'javascript:fetch("/")'],
      ['data', 'data:text/plain,hi'],
    ])('rejects %s scheme', (_label, url) => {
      const r = parse(url);
      expect(r.success).toBe(false);
    });
  });

  describe('refused (IP literals)', () => {
    it.each([
      '127.0.0.1',
      '10.0.0.5',         // RFC 1918
      '192.168.1.1',      // RFC 1918
      '172.16.0.1',       // RFC 1918
      '169.254.169.254',  // AWS / Azure metadata
      '8.8.8.8',          // public IP literal still refused (force DNS)
    ])('rejects IPv4 literal %s', (host) => {
      const r = parse(`https://${host}/hook`);
      expect(r.success).toBe(false);
    });

    it('rejects IPv6 literal (bracketed)', () => {
      const r = parse('https://[::1]/hook');
      expect(r.success).toBe(false);
    });
  });

  describe('refused (loopback + private suffixes)', () => {
    it.each([
      'https://localhost/hook',
      'https://something.local/hook',
      'https://app.internal/hook',
      'https://foo.localhost/hook',
    ])('rejects %s', (url) => {
      expect(parse(url).success).toBe(false);
    });
  });

  describe('refused (cloud metadata hosts)', () => {
    it.each([
      'https://metadata.google.internal/computeMetadata/v1/',
      'https://metadata/instance',
    ])('rejects %s', (url) => {
      expect(parse(url).success).toBe(false);
    });
  });

  describe('refused (malformed)', () => {
    it('rejects empty string', () => {
      expect(parse('').success).toBe(false);
    });

    it('rejects extremely long URL (> 2048 chars)', () => {
      const long = 'https://example.com/' + 'a'.repeat(2100);
      expect(parse(long).success).toBe(false);
    });
  });
});
