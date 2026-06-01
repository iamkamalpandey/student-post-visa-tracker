// SVT-WAVE-MEDIUM-AUDIT-REDACT-2026-05 — verify writeAudit's snapshot
// redaction strips envelope ciphertext + raw PII before encryption.
//
// Approach: stub encryption.encryptJson to capture the cleaned payload, run
// writeAudit with a fixture that contains every key the redactor should
// strip, and assert the captured value uses the [REDACTED:*] sentinels.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');

const captured: Array<unknown> = [];

vi.mock('../src/shared/encryption.js', () => ({
  encryptJson: vi.fn(async (v: unknown) => {
    captured.push(v);
    return Buffer.from('stub', 'utf8');
  }),
  encryptField: vi.fn(async (s: string | Buffer) => Buffer.from(typeof s === 'string' ? s : s.toString('utf8'))),
  decryptField: vi.fn(async (b: Buffer) => b.toString('utf8')),
  decryptJson: vi.fn(async (b: Buffer) => JSON.parse(b.toString('utf8'))),
  isCiphertext: vi.fn(() => true),
}));

vi.mock('../src/config/db.js', () => {
  const prisma = {
    auditLog: { create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    $queryRaw: vi.fn(async () => [{ entry_hash: null }]),
  };
  return { prisma, disconnectDb: async () => undefined };
});

const { writeAudit } = await import('../src/shared/audit.js');

beforeEach(() => {
  captured.length = 0;
});

describe('writeAudit snapshot redaction', () => {
  it('strips *_enc fields (Buffer + key suffix)', async () => {
    await writeAudit({} as never, {
      action: 'student.updated',
      entityType: 'student',
      after: {
        id: 'abc',
        given_name: 'Maya',
        family_name: 'Patel',
        passport_number_enc: Buffer.from('ciphertext'),
        name_in_passport_enc: Buffer.from('also-ciphertext'),
        visa_number_enc: Buffer.from('visa-ciphertext'),
      },
    });
    expect(captured).toHaveLength(1);
    const blob = captured[0] as Record<string, unknown>;
    expect(blob['given_name']).toBe('Maya');
    expect(blob['passport_number_enc']).toBe('[REDACTED:enc]');
    expect(blob['name_in_passport_enc']).toBe('[REDACTED:enc]');
    expect(blob['visa_number_enc']).toBe('[REDACTED:enc]');
  });

  it('strips raw PII keys (passport_number, dob, ssn, etc.)', async () => {
    await writeAudit({} as never, {
      action: 'student.updated',
      entityType: 'student',
      before: {
        passport_number: 'A12345678',
        national_id: 'NID-9999',
        dob: '1995-04-12',
        date_of_birth: '1995-04-12',
        ssn: '123-45-6789',
        sponsor_income: 50_000,
      },
    });
    const blob = captured[0] as Record<string, unknown>;
    expect(blob['passport_number']).toBe('[REDACTED]');
    expect(blob['national_id']).toBe('[REDACTED]');
    expect(blob['dob']).toBe('[REDACTED]');
    expect(blob['date_of_birth']).toBe('[REDACTED]');
    expect(blob['ssn']).toBe('[REDACTED]');
    expect(blob['sponsor_income']).toBe('[REDACTED]');
  });

  it('strips auth material (password, token, mfa_secret)', async () => {
    await writeAudit({} as never, {
      action: 'user.updated',
      entityType: 'user',
      after: {
        email: 'a@b.com',
        password: 'super-secret',
        password_hash: '$argon2id...',
        mfa_secret: 'JBSWY3DPEHPK3PXP',
        access_token: 'eyJhbGciOi...',
        refresh_token: 'rtk_xxx',
      },
    });
    const blob = captured[0] as Record<string, unknown>;
    expect(blob['email']).toBe('a@b.com');
    expect(blob['password']).toBe('[REDACTED]');
    expect(blob['password_hash']).toBe('[REDACTED]');
    expect(blob['mfa_secret']).toBe('[REDACTED]');
    expect(blob['access_token']).toBe('[REDACTED]');
    expect(blob['refresh_token']).toBe('[REDACTED]');
  });

  it('strips financial PII (bank_account, iban, card_number)', async () => {
    await writeAudit({} as never, {
      action: 'payment.received',
      entityType: 'payment',
      after: {
        amount: 1000,
        bank_account: '00012345',
        iban: 'GB82WEST12345698765432',
        swift: 'BARCGB22',
        card_number: '4242 4242 4242 4242',
        cvv: '123',
      },
    });
    const blob = captured[0] as Record<string, unknown>;
    expect(blob['amount']).toBe(1000);
    expect(blob['bank_account']).toBe('[REDACTED]');
    expect(blob['iban']).toBe('[REDACTED]');
    expect(blob['swift']).toBe('[REDACTED]');
    expect(blob['card_number']).toBe('[REDACTED]');
    expect(blob['cvv']).toBe('[REDACTED]');
  });

  it('walks nested objects recursively', async () => {
    await writeAudit({} as never, {
      action: 'student.updated',
      entityType: 'student',
      after: {
        id: 'abc',
        contacts: [
          { email: 'a@b.com', annual_income_minor_enc: Buffer.from('x') },
          { email: 'c@d.com', ssn: '999-99-9999' },
        ],
        meta: {
          nested: { passport_number: 'P12345' },
        },
      },
    });
    const blob = captured[0] as Record<string, unknown>;
    const contacts = blob['contacts'] as Array<Record<string, unknown>>;
    expect(contacts[0]!['email']).toBe('a@b.com');
    expect(contacts[0]!['annual_income_minor_enc']).toBe('[REDACTED:enc]');
    expect(contacts[1]!['ssn']).toBe('[REDACTED]');
    const meta = blob['meta'] as Record<string, unknown>;
    expect((meta['nested'] as Record<string, unknown>)['passport_number']).toBe('[REDACTED]');
  });

  it('strips bare Buffer values (e.g. raw encrypted blobs anywhere)', async () => {
    await writeAudit({} as never, {
      action: 'document.created',
      entityType: 'document',
      after: {
        id: 'doc-1',
        raw_ciphertext: Buffer.from('binary'),
      },
    });
    const blob = captured[0] as Record<string, unknown>;
    expect(blob['raw_ciphertext']).toBe('[REDACTED:Buffer]');
  });

  it('passes through safe shapes unchanged', async () => {
    await writeAudit({} as never, {
      action: 'student.updated',
      entityType: 'student',
      after: {
        id: 'abc',
        given_name: 'Maya',
        nationality_code: 'NP',
        current_stage_id: 'stage-1',
      },
    });
    const blob = captured[0] as Record<string, unknown>;
    expect(blob).toEqual({
      id: 'abc',
      given_name: 'Maya',
      nationality_code: 'NP',
      current_stage_id: 'stage-1',
    });
  });
});
