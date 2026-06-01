import { z } from 'zod';
import { isValidPhoneNumber } from 'libphonenumber-js';

export const Iso8601Date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected ISO 8601 date (YYYY-MM-DD)');

export const Iso8601DateTime = z.string().datetime({ offset: true, message: 'Expected ISO 8601 datetime' });

export const CountryAlpha2 = z
  .string()
  .length(2)
  .regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2 (uppercase)');

export const CurrencyCode = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, 'ISO 4217 currency code (uppercase)');

export const PhoneE164 = z
  .string()
  .refine((v) => isValidPhoneNumber(v), {
    message: 'Phone must be a valid E.164 number, e.g. +14155552671',
  });

// Backwards-compatible alias used by existing schemas across the package.
export const E164Phone = PhoneE164;

export const Email = z.string().email().max(254);

// SVT-WAVE-BLOCKER-5-2026-05 — SSRF-safe webhook URL.
//
// Validates the wire shape AT WRITE TIME so no caller can persist a
// dangerous URL. Rules:
//   1. Scheme must be https (no http, file://, ftp://, javascript:, data:).
//   2. Hostname must be present and non-empty.
//   3. Hostname must NOT be a literal IPv4 / IPv6 address (forces DNS hop
//      so the operator at least sees the domain in audit logs; loopback /
//      RFC 1918 / link-local literals would slip past hostname-only checks
//      otherwise).
//   4. Hostname must NOT match private/loopback/metadata-server suffixes.
//   5. Length cap so log lines stay sane.
//
// Run-time fetch callers MUST additionally:
//   - resolve DNS once and compare against an IP allowlist/denylist
//   - disable redirect-following
//   - set strict timeouts (5–10s)
//   - never echo the response body into our DB without sanitisation.
const SSRF_BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '169.254.169.254',          // AWS / GCP metadata
  'metadata.google.internal', // GCP metadata
  'metadata',                 // azure metadata short alias
]);
const SSRF_BLOCKED_SUFFIXES = ['.local', '.internal', '.localhost'];

export const SafeWebhookUrl = z
  .string()
  .url()
  .max(2048)
  .refine((raw) => {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return false;
    }
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (!host) return false;
    if (SSRF_BLOCKED_HOSTNAMES.has(host)) return false;
    if (SSRF_BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return false;
    // Reject literal IPv4 / IPv6 — force DNS so the audit trail records a domain.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
    if (host.startsWith('[') && host.endsWith(']')) return false;
    return true;
  }, {
    message:
      'Webhook URL must be an https:// URL on a public domain (no IP literals, no localhost, no .local, no cloud metadata hosts)',
  });

export const UuidV7 = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, 'Expected UUIDv7');

export const Uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'Expected UUID');

export const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});

export const RoleEnum = z.enum(['ADMIN', 'COUNSELLOR', 'VIEWER']);
export type Role = z.infer<typeof RoleEnum>;

// RFC 7807 Problem Details
export const ProblemDetail = z.object({
  type: z.string().url().or(z.literal('about:blank')),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  // Machine-readable short code so clients can branch without parsing detail.
  // Example: 'mfa_required' on a 401 from a step-up-protected route.
  code: z.string().optional(),
  instance: z.string().optional(),
  errors: z
    .array(z.object({ path: z.string(), message: z.string(), code: z.string().optional() }))
    .optional(),
  request_id: z.string().optional(),
});
export type ProblemDetail = z.infer<typeof ProblemDetail>;
