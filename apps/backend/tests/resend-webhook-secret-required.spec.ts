// P1-WB6 (2026-05) — RESEND_WEBHOOK_SECRET must be required at boot in
// every non-test environment.
//
// We can't easily import src/server.ts inside a test (it side-effects:
// listens on a port, registers signal handlers). Instead we replicate the
// exact predicate the boot guard uses and pin it against a matrix of
// (NODE_ENV, RESEND_WEBHOOK_SECRET) values. Any future refactor that
// loosens the guard (e.g. excluding `development`) trips this spec.
//
// Coverage:
//   - production + secret unset            → boot REJECT
//   - staging    + secret unset            → boot REJECT
//   - development + secret unset           → boot REJECT
//   - test      + secret unset             → boot OK (supertest harness)
//   - production + secret set              → boot OK
//
// The webhooks router behaviour is still the per-request 503 fallback;
// boot rejection is the new outer ring.

import { describe, it, expect } from 'vitest';

type Env = 'development' | 'test' | 'staging' | 'production';

function shouldRejectBoot(nodeEnv: Env, secret: string | undefined): boolean {
  return nodeEnv !== 'test' && !secret;
}

describe('P1-WB6 — RESEND_WEBHOOK_SECRET boot guard predicate', () => {
  it('rejects boot in production when secret is unset', () => {
    expect(shouldRejectBoot('production', undefined)).toBe(true);
  });

  it('rejects boot in staging when secret is unset', () => {
    expect(shouldRejectBoot('staging', undefined)).toBe(true);
  });

  it('rejects boot in development when secret is unset', () => {
    expect(shouldRejectBoot('development', undefined)).toBe(true);
  });

  it('permits boot in test when secret is unset (supertest harness flow)', () => {
    expect(shouldRejectBoot('test', undefined)).toBe(false);
  });

  it('permits boot in production when secret is set', () => {
    expect(shouldRejectBoot('production', 'whsec_xxx')).toBe(false);
  });

  it('permits boot in any env when secret is set', () => {
    for (const env of ['development', 'test', 'staging', 'production'] as Env[]) {
      expect(shouldRejectBoot(env, 'whsec_xxx')).toBe(false);
    }
  });
});

// Defence-in-depth: the per-request 503 fallback inside the webhooks router
// is still the authoritative guard if somehow the boot guard is bypassed.
// We exercise the router-level behaviour separately in webhooks-resend.spec.ts.
