// Unit tests for redactSensitive() exported from students.service.ts.
// Confirms ANY *_enc property is stripped, recursively, without disturbing
// Buffers, Dates, or other non-plain-object values that happen to live alongside them.

import { describe, it, expect, vi } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3000');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

// We don't actually need encryption to import the service — but the module
// imports encryption, which imports kms. Stub for safety.
vi.mock('../src/shared/encryption.js', () => ({
  encryptField: async (s: string | Buffer) =>
    Buffer.from(typeof s === 'string' ? s : s.toString('utf8'), 'utf8'),
  decryptField: async (b: Buffer) => b.toString('utf8'),
}));
vi.mock('../src/config/db.js', () => ({
  prisma: {},
  disconnectDb: async () => undefined,
}));

const { redactSensitive } = await import('../src/modules/students/students.service.js');

describe('redactSensitive()', () => {
  it('strips name_in_passport_enc at the top level', () => {
    const input = {
      id: 'abc',
      given_name: 'Asha',
      name_in_passport_enc: Buffer.from('SECRET'),
    };
    const out = redactSensitive(input) as Record<string, unknown>;
    expect(out['id']).toBe('abc');
    expect(out['given_name']).toBe('Asha');
    expect(out['name_in_passport_enc']).toBeUndefined();
  });

  it('strips arbitrary *_enc keys (mfa_secret_enc, before_enc, after_enc, ...)', () => {
    const input = {
      id: 'u1',
      mfa_secret_enc: Buffer.from('totp-seed'),
      before_enc: Buffer.from('snapshot1'),
      after_enc: Buffer.from('snapshot2'),
      regular_field: 'visible',
    };
    const out = redactSensitive(input) as Record<string, unknown>;
    expect(out['mfa_secret_enc']).toBeUndefined();
    expect(out['before_enc']).toBeUndefined();
    expect(out['after_enc']).toBeUndefined();
    expect(out['regular_field']).toBe('visible');
  });

  it('walks nested objects (audit-style { actor: { mfa_secret_enc } })', () => {
    const input = {
      action: 'auth.login.success',
      actor: {
        id: 'u1',
        mfa_secret_enc: Buffer.from('seed'),
        profile: { display_name: 'Ada', secret_token_enc: Buffer.from('xx') },
      },
    };
    const out = redactSensitive(input) as Record<string, Record<string, Record<string, unknown>>>;
    expect(out['actor']!['mfa_secret_enc']).toBeUndefined();
    expect(out['actor']!['profile']!['secret_token_enc']).toBeUndefined();
    expect(out['actor']!['profile']!['display_name']).toBe('Ada');
  });

  it('walks arrays of objects', () => {
    const input = {
      students: [
        { id: '1', name_in_passport_enc: Buffer.from('a') },
        { id: '2', name_in_passport_enc: Buffer.from('b') },
      ],
    };
    const out = redactSensitive(input) as { students: Array<Record<string, unknown>> };
    expect(out.students[0]!['name_in_passport_enc']).toBeUndefined();
    expect(out.students[1]!['name_in_passport_enc']).toBeUndefined();
    expect(out.students[0]!['id']).toBe('1');
  });

  it('passes Date and Buffer values through (does not try to walk them)', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    const input = { id: 'x', created_at: d, blob: Buffer.from([1, 2, 3]) };
    const out = redactSensitive(input) as Record<string, unknown>;
    expect(out['created_at']).toBe(d);
    expect(Buffer.isBuffer(out['blob'])).toBe(true);
  });

  it('returns primitives untouched', () => {
    expect(redactSensitive('hello')).toBe('hello');
    expect(redactSensitive(42)).toBe(42);
    expect(redactSensitive(null)).toBeNull();
    expect(redactSensitive(undefined)).toBeUndefined();
  });

  it('does not touch keys that merely contain "enc" mid-string', () => {
    const input = { fenced: true, encryption_status: 'unknown', not_enc_at_all: 'keep me' };
    const out = redactSensitive(input) as Record<string, unknown>;
    expect(out['fenced']).toBe(true);
    expect(out['encryption_status']).toBe('unknown');
    expect(out['not_enc_at_all']).toBe('keep me');
  });
});
