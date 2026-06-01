// SVT-WAVE-PRIV-C5-2026-05 — verify pino redaction covers the audit-pinned
// PII / credential paths. We capture a single log line by swapping pino's
// stream and asserting the serialised output replaces the redacted fields
// with the `[Redacted]` censor literal.

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('LOG_LEVEL', 'info');

// Re-import the logger so each spec gets a fresh pino instance bound to our
// per-test sink. We can't just spy on stdout because pino bypasses console.
const captured: string[] = [];

const { logger } = await import('../src/config/logger.js');

// Pino's default destination is process.stdout. Replace via the symbol API
// so this works even when pino-pretty isn't in the pipeline (LOG_LEVEL in
// .env.test usually keeps pretty off — but defend either way).
const pinoSym = Object.getOwnPropertySymbols(logger).find((s) => s.description?.includes('pino.stream'));
if (pinoSym) {
  (logger as unknown as Record<symbol, unknown>)[pinoSym] = {
    write: (s: string) => captured.push(s),
  };
}

beforeEach(() => {
  captured.length = 0;
});

describe('logger redaction', () => {
  it('redacts bare `email` at the top level of a log object', () => {
    logger.info({ email: 'subject@example.com', other: 'visible' }, 'test');
    const line = captured.join('');
    expect(line).toContain('[Redacted]');
    expect(line).not.toContain('subject@example.com');
    expect(line).toContain('"other":"visible"');
  });

  it('redacts nested *.email under a wrapper object', () => {
    logger.info({ student: { email: 'nested@example.com' } }, 'nested');
    const line = captured.join('');
    expect(line).toContain('[Redacted]');
    expect(line).not.toContain('nested@example.com');
  });

  it('redacts phone_e164 (bare + nested)', () => {
    logger.info({ phone_e164: '+1234567890', student: { phone_primary_e164: '+19999999999' } }, 'phones');
    const line = captured.join('');
    expect(line).not.toContain('+1234567890');
    expect(line).not.toContain('+19999999999');
  });

  it('redacts bare `authorization` and `set-cookie`', () => {
    logger.info({ authorization: 'Bearer secrettoken', 'set-cookie': 'session=abc' }, 'transport');
    const line = captured.join('');
    expect(line).not.toContain('secrettoken');
    expect(line).not.toContain('session=abc');
  });

  it('redacts ssn (bare + nested)', () => {
    logger.info({ ssn: '123-45-6789', user: { ssn: '999-99-9999' } }, 'pii');
    const line = captured.join('');
    expect(line).not.toContain('123-45-6789');
    expect(line).not.toContain('999-99-9999');
  });

  it('redacts email_primary / email_secondary', () => {
    logger.info(
      { email_primary: 'a@example.com', email_secondary: 'b@example.com' },
      'student-emails',
    );
    const line = captured.join('');
    expect(line).not.toContain('a@example.com');
    expect(line).not.toContain('b@example.com');
  });
});
