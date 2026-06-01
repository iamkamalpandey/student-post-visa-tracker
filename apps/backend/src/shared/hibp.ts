// SVT-SEC-2026-05 — HaveIBeenPwned k-anonymity password check.
//
// Implements the HIBP Pwned Passwords API v3 k-anonymity model:
//
//   1. SHA-1 the password (HIBP intentionally uses SHA-1 for legacy
//      compatibility — it is NOT used as a credential hash anywhere here;
//      Argon2id remains the storage hash).
//   2. Send only the first 5 hex chars of the digest to
//      https://api.pwnedpasswords.com/range/{prefix}
//      The server returns ~500 suffix:count rows covering every breached
//      password whose SHA-1 starts with that prefix.
//   3. Search the response for the local suffix. If found, the password
//      appears in N breaches and must be rejected (or warned).
//
// Privacy: the full password and full hash NEVER leave the host. Only a
// 5-char prefix is sent. This is the model documented by Troy Hunt /
// Cloudflare and accepted by NIST 800-63B as "compromised-credential
// check".
//
// Environment flags:
//   HIBP_ENFORCEMENT=warn|block|off  (default: warn)
//     - off:    skip the check entirely (test envs)
//     - warn:   log + emit an audit row but allow the password
//     - block:  reject the password with a 422 (production-grade)
//
// Failure mode (HIBP unreachable, timeout, non-200):
//   - In production (NODE_ENV=production): fail-CLOSED by default. A 503
//     `Password validation service unavailable. Try again in a moment.` is
//     thrown so a HIBP outage cannot let a breached password through. This is
//     the SVT-SEC-HIBP-FAIL-CLOSED-2026-05 (P1-7) hardening — the previous
//     fail-open default meant an attacker who could DoS HIBP's edge could
//     freely set Password123! during change-password.
//   - In dev / test / staging: fail-OPEN so a missing internet connection
//     does not brick local password flows during development.
//   - HIBP_FAIL_CLOSED=true forces fail-closed in non-production too.
//   - HIBP_FAIL_OPEN=true forces fail-open in production (escape hatch for
//     verified-safe egress-blocked deployments; explicitly opt-in).

import { createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

const ENDPOINT = 'https://api.pwnedpasswords.com/range/';
const TIMEOUT_MS = 3_000;

export type HibpResult = {
  pwned: boolean;
  count: number;
  /** True when the API itself failed (network, timeout, non-200). */
  unreachable: boolean;
};

/** SHA-1 of input as uppercase hex. */
function sha1Hex(input: string): string {
  return createHash('sha1').update(input).digest('hex').toUpperCase();
}

/**
 * Probe HIBP for `password`. Never throws; failures resolve as
 * `{ pwned: false, unreachable: true }` so the caller can decide policy.
 */
export async function checkPwnedPassword(password: string): Promise<HibpResult> {
  if (!password || password.length < 1) return { pwned: false, count: 0, unreachable: false };
  const hash = sha1Hex(password);
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);
  try {
    const res = await fetch(`${ENDPOINT}${prefix}`, {
      method: 'GET',
      headers: { 'Add-Padding': 'true', 'User-Agent': 'svt-backend-hibp' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      return { pwned: false, count: 0, unreachable: true };
    }
    const body = await res.text();
    for (const line of body.split(/\r?\n/)) {
      const [s, c] = line.split(':');
      if (!s) continue;
      if (s.trim().toUpperCase() === suffix) {
        const count = Number(c?.trim() ?? '0');
        return { pwned: true, count: Number.isFinite(count) ? count : 1, unreachable: false };
      }
    }
    return { pwned: false, count: 0, unreachable: false };
  } catch (err) {
    logger.warn({ err }, 'hibp: probe failed (fail-open)');
    return { pwned: false, count: 0, unreachable: true };
  }
}

type EnforcementMode = 'off' | 'warn' | 'block';

function enforcementMode(): EnforcementMode {
  const raw = (env.NODE_ENV === 'test' ? 'off' : (process.env['HIBP_ENFORCEMENT'] ?? 'warn'))
    .toLowerCase();
  if (raw === 'off' || raw === 'warn' || raw === 'block') return raw;
  return 'warn';
}

/**
 * High-level guard for the password-set/change pipeline.
 *   - HIBP_ENFORCEMENT=off    → no-op.
 *   - HIBP_ENFORCEMENT=warn   → log + return false (do not block) if pwned.
 *   - HIBP_ENFORCEMENT=block  → throw a shaped UnprocessableEntity if pwned.
 *
 * Returns `true` when the password is safe (or check skipped/failed).
 * Returns `false` when the password is in HIBP but mode is `warn`.
 * Throws when mode is `block` AND the password is found.
 */
function shouldFailClosed(): boolean {
  // Explicit overrides win. Order:
  //   1. HIBP_FAIL_OPEN=true  → never fail-closed (opt-out).
  //   2. HIBP_FAIL_CLOSED=true → always fail-closed (opt-in for dev).
  //   3. NODE_ENV=production  → fail-closed by default.
  //   4. Anything else        → fail-open.
  if (process.env['HIBP_FAIL_OPEN'] === 'true') return false;
  if (process.env['HIBP_FAIL_CLOSED'] === 'true') return true;
  return env.NODE_ENV === 'production';
}

export async function ensurePasswordNotPwned(password: string, context: { userId?: string; tenantId?: string }): Promise<boolean> {
  const mode = enforcementMode();
  if (mode === 'off') return true;
  const result = await checkPwnedPassword(password);
  if (result.unreachable && shouldFailClosed()) {
    // SVT-SEC-HIBP-FAIL-CLOSED-2026-05 (P1-7) — production default. The
    // 503 status + sentinel detail string is what the FE matches on to
    // render the "try again in a moment" copy. Audit log records the
    // attempt so a sustained HIBP outage shows up on dashboards.
    logger.error(
      { ...context, mode, env: env.NODE_ENV },
      'hibp: unreachable in fail-closed mode; rejecting password change',
    );
    const e = new Error('Password validation service unavailable. Try again in a moment.') as Error & { status: number };
    e.status = 503;
    throw e;
  }
  if (!result.pwned) return true;
  // Found in HIBP.
  logger.warn(
    { ...context, breachCount: result.count, mode },
    'hibp: password found in breach corpus',
  );
  if (mode === 'block') {
    const e = new Error(
      `Password has appeared in ${result.count} known data breach${result.count === 1 ? '' : 'es'}. Choose a different one.`,
    ) as Error & { status: number; title: string };
    e.status = 422;
    e.title = 'Password is compromised';
    throw e;
  }
  return false;
}
