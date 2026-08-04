// SVT-PII-2026-08 — blind index for searchable encrypted PII.
//
// These pin the properties the rest of the encryption work depends on. If any
// of them regress, encrypting Student.email_primary would silently break the
// `@@unique([tenant_id, email_primary])` constraint (duplicate students) or the
// unauthenticated public-DSAR subject lookup (Art. 15 request cannot find the
// person it is about).

import { describe, it, expect, vi } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3000');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const {
  blindIndex,
  emailIndex,
  phoneIndex,
  dateIndex,
  normaliseEmail,
  normalisePhone,
  normaliseDate,
  blindIndexEquals,
} = await import('../src/shared/blindIndex.js');

describe('determinism — the property unique constraints depend on', () => {
  it('produces the SAME hash for the same input every time', () => {
    // Envelope encryption is deliberately non-deterministic, which is why the
    // unique constraint needs this separate column.
    expect(emailIndex('a@b.com')).toBe(emailIndex('a@b.com'));
    expect(phoneIndex('+9779800000000')).toBe(phoneIndex('+9779800000000'));
    expect(dateIndex('2000-01-01')).toBe(dateIndex('2000-01-01'));
  });

  it('produces DIFFERENT hashes for different inputs', () => {
    expect(emailIndex('a@b.com')).not.toBe(emailIndex('c@d.com'));
  });

  it('returns 64-char lowercase hex (indexable as a plain String column)', () => {
    expect(emailIndex('a@b.com')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('domain separation', () => {
  it('the same string indexed under different domains does not collide', () => {
    // Without a domain prefix, a value appearing in both an email and a phone
    // column would produce identical hashes, implying a relationship between
    // two unrelated rows to anyone reading the table.
    const value = '12345';
    expect(blindIndex('email', value)).not.toBe(blindIndex('phone', value));
    expect(blindIndex('phone', value)).not.toBe(blindIndex('date', value));
  });
});

describe('email normalisation — controls what counts as a duplicate', () => {
  it('is case- and whitespace-insensitive', () => {
    expect(normaliseEmail('  Foo@Bar.COM ')).toBe('foo@bar.com');
    expect(emailIndex('  Foo@Bar.COM ')).toBe(emailIndex('foo@bar.com'));
  });

  it('does NOT strip dots or +tags', () => {
    // Gmail treats these as aliases, but most providers do not. Merging two
    // real, distinct people is a worse failure than missing a duplicate, so
    // we keep them distinct.
    expect(emailIndex('a.b@x.com')).not.toBe(emailIndex('ab@x.com'));
    expect(emailIndex('a+tag@x.com')).not.toBe(emailIndex('a@x.com'));
  });

  it('returns null for absent or blank input rather than hashing empty string', () => {
    // A hash of '' would make every row with no email collide on the unique
    // constraint, so only ONE student could ever have a blank email.
    expect(emailIndex(null)).toBeNull();
    expect(emailIndex(undefined)).toBeNull();
    expect(emailIndex('')).toBeNull();
    expect(emailIndex('   ')).toBeNull();
  });
});

describe('phone normalisation — tolerates historical CRM formatting', () => {
  it('ignores spaces, dashes and parens while keeping the leading +', () => {
    expect(normalisePhone('+977 980-000-0000')).toBe('+9779800000000');
    expect(phoneIndex('+977 980-000-0000')).toBe(phoneIndex('+9779800000000'));
    expect(phoneIndex('(977) 980 000 0000')).toBe(phoneIndex('9779800000000'));
  });

  it('treats a leading + as significant', () => {
    // +1555… (E.164) and 1555… (national) are not provably the same number.
    expect(phoneIndex('+15551234567')).not.toBe(phoneIndex('15551234567'));
  });

  it('returns null for blank input', () => {
    expect(phoneIndex('')).toBeNull();
    expect(phoneIndex('   ')).toBeNull();
    expect(phoneIndex(null)).toBeNull();
  });
});

describe('date normalisation — keeps the convert dedup guard working', () => {
  it('collapses a Date with a time component to its UTC calendar day', () => {
    // date_of_birth is a DATE column but arrives as a JS Date. Without this,
    // two representations of the same birthday hash differently and the
    // duplicate-student guard stops firing.
    expect(normaliseDate(new Date('2000-01-01T00:00:00Z'))).toBe('2000-01-01');
    expect(normaliseDate(new Date('2000-01-01T23:59:59Z'))).toBe('2000-01-01');
    expect(dateIndex(new Date('2000-01-01T13:45:00Z'))).toBe(dateIndex('2000-01-01'));
  });

  it('accepts a string or a Date interchangeably', () => {
    expect(dateIndex('2000-01-01')).toBe(dateIndex(new Date('2000-01-01T00:00:00Z')));
  });

  it('throws on an invalid date rather than indexing NaN', () => {
    expect(() => normaliseDate('not-a-date')).toThrow(/invalid date/i);
  });

  it('returns null for absent input', () => {
    expect(dateIndex(null)).toBeNull();
    expect(dateIndex(undefined)).toBeNull();
  });
});

describe('blindIndexEquals — constant-time comparison', () => {
  it('matches identical indexes', () => {
    const a = emailIndex('a@b.com');
    expect(blindIndexEquals(a, emailIndex('A@B.com'))).toBe(true);
  });

  it('rejects different indexes', () => {
    expect(blindIndexEquals(emailIndex('a@b.com'), emailIndex('c@d.com'))).toBe(false);
  });

  it('treats null as never-equal, including null vs null', () => {
    // Two rows with no email must NOT be considered the same subject — that
    // would let the public DSAR intake match an arbitrary emailless student.
    expect(blindIndexEquals(null, null)).toBe(false);
    expect(blindIndexEquals(emailIndex('a@b.com'), null)).toBe(false);
    expect(blindIndexEquals(null, emailIndex('a@b.com'))).toBe(false);
  });

  it('does not throw on length-mismatched input', () => {
    expect(blindIndexEquals('short', emailIndex('a@b.com'))).toBe(false);
  });
});

describe('keying — the hash must not be a bare digest of the plaintext', () => {
  it('does not equal an unkeyed SHA-256 of the value', async () => {
    // If it did, an attacker with a table dump could brute-force every email
    // against a wordlist with no key required.
    const { createHash } = await import('node:crypto');
    const bare = createHash('sha256').update('email:a@b.com').digest('hex');
    expect(emailIndex('a@b.com')).not.toBe(bare);
  });
});
