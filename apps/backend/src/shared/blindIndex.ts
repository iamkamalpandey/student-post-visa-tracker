// SVT-PII-2026-08 — deterministic "blind index" for searchable encrypted columns.
//
// THE PROBLEM
//
// Envelope encryption (shared/encryption.ts) is non-deterministic by design: a
// fresh DEK and a random IV per field mean the same plaintext encrypts to a
// different blob every time. That is exactly what you want for confidentiality
// — and exactly what breaks these, which the app genuinely needs:
//
//   * `@@unique([tenant_id, email_primary])` on Student. Two rows holding the
//     same email would produce different ciphertext, so the constraint would
//     silently stop preventing duplicates.
//   * `dsar-public/service.ts` looks a subject up BY email to honour an
//     unauthenticated Art. 15 request. With only ciphertext, that lookup is a
//     full-table decrypt.
//   * The convert dedup guard matches on (family_name, given_name,
//     date_of_birth) to avoid minting a second managed student for someone who
//     already exists.
//
// THE APPROACH
//
// Store an HMAC-SHA256 of the NORMALISED plaintext alongside the ciphertext.
// The hash is deterministic, so equality lookups and unique constraints work
// on it; it is keyed, so an attacker with only a database dump cannot brute
// force it the way they could a bare SHA-256 of an email address.
//
// WHAT THIS DOES AND DOES NOT PROTECT
//
// A blind index leaks EQUALITY: an attacker who reads the table learns which
// rows share a value, and can confirm a guess about a specific person if they
// also hold the key. It does NOT leak the value itself, and without the key it
// is not brute-forceable. That trade is the price of keeping a unique
// constraint and an indexed lookup. It is deliberately NOT used for columns
// that need neither (name_in_passport, passport numbers, sponsor income) —
// those get ciphertext only.
//
// KEY SEPARATION
//
// Uses its own PII_BLIND_INDEX_KEY, never the KEK and never LOG_HMAC_KEY_BASE64.
// Rotating the audit-correlation key must not silently invalidate every unique
// constraint on the students table, and vice versa — the codebase already
// learned this lesson once when the correlation key was derived from
// JWT_PRIVATE_KEY (see infra/docs/runbooks/kek-rotation.md).
//
// ROTATION
//
// Rotating this key requires recomputing every index column, which is a
// backfill — the same shape as rewrap-secrets. Unlike the KEK, a lost blind
// index key is NOT a data-loss event: the ciphertext is unaffected and the
// index can be rebuilt by decrypting each row. That asymmetry is why it is a
// separate, lower-ceremony secret.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

let cachedKey: Buffer | null = null;

function key(): Buffer {
  if (cachedKey) return cachedKey;
  const b64 = env.PII_BLIND_INDEX_KEY;
  if (b64) {
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 32) {
      throw new Error(
        `PII_BLIND_INDEX_KEY must decode to at least 32 bytes (got ${buf.length}). ` +
          'Generate with: openssl rand -base64 32',
      );
    }
    cachedKey = buf;
    return cachedKey;
  }
  if (env.isTest) {
    // Deterministic in tests so a value hashed in one test matches the same
    // value hashed in another within the run. NOT random: a random key would
    // make blind-index assertions non-reproducible across processes.
    cachedKey = Buffer.alloc(32, 0x5a);
    return cachedKey;
  }
  throw new Error(
    'PII_BLIND_INDEX_KEY is required outside of test. Generate with: openssl rand -base64 32',
  );
}

/** Test-only: drop the cached key so a different one is read next call. */
export function __resetBlindIndexKeyForTests(): void {
  cachedKey = null;
}

/**
 * Normalise an email for indexing.
 *
 * Lowercased and trimmed so `Foo@Bar.com ` and `foo@bar.com` collide, which is
 * what a "have we already got this person?" check must do. We deliberately do
 * NOT strip dots or +tags: for Gmail those are aliases, but for most providers
 * they are distinct mailboxes, and wrongly merging two real people is a worse
 * failure than missing a duplicate.
 */
export function normaliseEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Normalise a phone number for indexing.
 *
 * Keeps a leading `+` and digits only, so formatting differences
 * (`+977 980-000-0000` vs `+9779800000000`) collide. Callers should already be
 * passing E.164; this is defence against historical rows and CRM imports that
 * were never validated.
 */
export function normalisePhone(value: string): string {
  const trimmed = value.trim();
  const digits = trimmed.replace(/[^\d]/g, '');
  return trimmed.startsWith('+') ? `+${digits}` : digits;
}

/**
 * Normalise a date for indexing — the calendar day in UTC, `YYYY-MM-DD`.
 *
 * `date_of_birth` is a DATE column but arrives as a JS Date, whose time
 * component would otherwise make two representations of the same birthday
 * hash differently and break the convert dedup guard.
 */
export function normaliseDate(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) throw new Error('normaliseDate: invalid date');
  return d.toISOString().slice(0, 10);
}

/**
 * Compute the blind index for an already-normalised value.
 *
 * `domain` separates namespaces so the same string indexed as an email and as
 * a phone number produces different hashes. Without it, a value that happened
 * to appear in two columns would collide across them, leaking a relationship
 * that does not exist.
 *
 * Returns lowercase hex (64 chars) — indexable as a plain String column.
 */
export function blindIndex(domain: string, normalised: string): string {
  return createHmac('sha256', key()).update(`${domain}:${normalised}`).digest('hex');
}

/** Blind index for an email. Returns null for absent/blank input. */
export function emailIndex(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const n = normaliseEmail(value);
  return n.length === 0 ? null : blindIndex('email', n);
}

/** Blind index for a phone number. Returns null for absent/blank input. */
export function phoneIndex(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const n = normalisePhone(value);
  return n.length === 0 ? null : blindIndex('phone', n);
}

/** Blind index for a date of birth. Returns null for absent input. */
export function dateIndex(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return blindIndex('date', normaliseDate(value));
}

/**
 * Constant-time comparison of two blind indexes.
 *
 * Equality on a keyed hash is not usually a timing-attack target — an attacker
 * who can already read the column has the hash — but comparisons on the
 * unauthenticated public-DSAR intake path are attacker-controlled, so compare
 * in constant time rather than reason case-by-case about which call sites are
 * reachable pre-auth.
 */
export function blindIndexEquals(a: string | null, b: string | null): boolean {
  if (a == null || b == null) return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
