// SVT-SEC-MFA-STEPUP-2026-05 — step-up MFA enforcement for the most dangerous
// billing mutations (refund / void / cancel-plan / complete-refund).
//
// Design (Option A — header-based, stateless).
//
//   - Client sends `X-MFA-Code: 123456` alongside the sensitive mutation.
//   - Middleware loads the authenticated user's MFA state. If MFA is disabled
//     for the account the middleware passes through — there's nothing to
//     enforce. (Org-wide MFA enforcement is tracked separately; this gate
//     only adds friction for users who have already enrolled.)
//   - When MFA is enabled and the header is missing we return 401 with
//     `code: 'mfa_required'` so the FE knows to open the inline TOTP prompt
//     and retry the same mutation with the header attached.
//   - When the code is wrong we return 401 `code: 'mfa_invalid'`.
//   - Replay protection: a (userId, code) tuple seen within the last 60s
//     returns 401 `code: 'mfa_replay'`. The TOTP step window is 30s with ±1
//     skew (90s effective), so a 60s anti-replay window prevents the same
//     code from being used twice in rapid succession while still letting a
//     legitimate user retry with a fresh code as the window rolls.
//   - We do NOT mint a step-up JWT (Option B). A second token surface adds
//     complexity (refresh, revocation, FE storage) for no benefit at v1 —
//     each sensitive call is rare enough that one prompt per click is fine.
//
// SVT-SEC-MFA-REPLAY-REDIS-2026-05 — multi-replica safety.
//   The original implementation used a per-process Map for replay tracking;
//   with >1 backend replica behind a load balancer the same TOTP could be
//   replayed against a sibling replica that hadn't seen it yet. We now choose
//   a `ReplayStore` strategy at module load:
//     - `RedisReplayStore` when a shared Redis client is available
//       (REDIS_URL set + `redis` package installed). Uses `SET key 1 NX EX 60`
//       so the SETNX is atomic across replicas. Returns null on replay.
//     - `InProcessReplayStore` (the legacy Map) when Redis is unavailable.
//       Safe ONLY for single-replica deployments; server.ts logs a loud WARN
//       at boot if NODE_ENV=production and SPV_ALLOW_SINGLE_REPLICA != true.

import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/db.js';
import { decryptField } from '../shared/encryption.js';
import { verifyTotp } from '../modules/auth/auth.totp.js';
import { writeAudit } from '../shared/audit.js';
import { Unauthorized } from '../shared/errors.js';
import { logger } from '../config/logger.js';
import { captureException } from '../config/sentry.js';
import { getRedisClient, type RedisLikeClient } from '../shared/redisClient.js';

// `req.mfaVerifiedAt` is augmented globally in `src/types/express.d.ts`.

const REPLAY_TTL_MS = 60_000;
const REPLAY_TTL_SECONDS = REPLAY_TTL_MS / 1000;

// P0-WB2 (2026-05) — per-user MFA-attempt throttle. The per-IP authLimiter
// (5/min/IP) on /auth/mfa/* is good for unauthenticated brute force, but
// the step-up `X-MFA-Code` header bypasses that limiter on every other
// authenticated route. Without a user-scoped cap an attacker holding a
// session token could spin through 600 codes/min from every authenticated
// route in the app. 10 attempts/min/user keeps a legitimate retry budget
// (typo, clock drift) while crushing automated guessers.
const MFA_THROTTLE_TTL_MS = 60_000;
const MFA_THROTTLE_LIMIT = 10;
const mfaAttemptBuckets = new Map<string, { count: number; resetAt: number }>();

/** Reset the per-user MFA throttle. Test-only. */
export function __resetMfaThrottleForTests(): void {
  mfaAttemptBuckets.clear();
}

/**
 * Record a step-up MFA attempt for `userId` and return whether the user is
 * over budget. Tracked in-process (single-replica safe; Redis upgrade later).
 *
 * Returns `true` when the request should be allowed, `false` when the user
 * has already exhausted the per-minute budget and the caller MUST return
 * 429 mfa_throttled.
 */
function recordMfaAttempt(userId: string): boolean {
  const now = Date.now();
  const existing = mfaAttemptBuckets.get(userId);
  if (!existing || existing.resetAt <= now) {
    mfaAttemptBuckets.set(userId, { count: 1, resetAt: now + MFA_THROTTLE_TTL_MS });
    return true;
  }
  if (existing.count >= MFA_THROTTLE_LIMIT) return false;
  existing.count += 1;
  return true;
}

/**
 * Strategy interface for the anti-replay cache. Both implementations expose
 * the same atomic "claim this (userId, code) pair for the next 60s" verb:
 *
 *   markIfFresh(userId, code) => true  -> first use, request may proceed
 *                              => false -> replay, caller MUST return mfa_replay
 *
 * The check + set MUST be atomic to defend against parallel replays hitting
 * two replicas at the same instant.
 */
export type ReplayStore = {
  /** Atomically reserve (userId, code) for the TTL window. */
  markIfFresh(userId: string, code: string): Promise<boolean>;
  /** Wipe all entries — test hook only. */
  reset(): void;
  /** Strategy name surfaced in logs / debugging. */
  readonly kind: 'in-process' | 'redis';
};

// -------------------------------------------------------------------------
// In-process implementation (legacy; safe ONLY for single-replica deploys).
// -------------------------------------------------------------------------
//
// Map<userId, Map<code, expiresAt>> — bounded by REPLAY_TTL_MS. Stale entries
// are swept lazily on every check (cheap; the inner map is per-user and short).

function makeInProcessReplayStore(): ReplayStore {
  const replayCache = new Map<string, Map<string, number>>();

  function sweepUser(userId: string, now: number): Map<string, number> | null {
    const inner = replayCache.get(userId);
    if (!inner) return null;
    for (const [code, exp] of inner) {
      if (exp <= now) inner.delete(code);
    }
    if (inner.size === 0) {
      replayCache.delete(userId);
      return null;
    }
    return inner;
  }

  return {
    kind: 'in-process',
    async markIfFresh(userId, code) {
      const now = Date.now();
      const inner = sweepUser(userId, now);
      const exp = inner?.get(code);
      if (exp !== undefined && exp > now) return false;
      let target = replayCache.get(userId);
      if (!target) {
        target = new Map<string, number>();
        replayCache.set(userId, target);
      }
      target.set(code, now + REPLAY_TTL_MS);
      return true;
    },
    reset() {
      replayCache.clear();
    },
  };
}

// -------------------------------------------------------------------------
// Redis implementation (preferred for multi-replica).
// -------------------------------------------------------------------------
//
// `SET mfa:replay:<userId>:<code> 1 NX EX 60` is atomic on the Redis server,
// so two replicas racing the same TOTP cannot both succeed. We treat any
// Redis failure (network blip, ECONNREFUSED) as fail-open and log loudly;
// briefly degrading to "no anti-replay" beats locking legitimate admins
// out of refunds during an incident.

export function makeRedisReplayStore(client: RedisLikeClient): ReplayStore {
  return {
    kind: 'redis',
    async markIfFresh(userId, code) {
      const key = `mfa:replay:${userId}:${code}`;
      try {
        const res = await client.set(key, '1', { NX: true, EX: REPLAY_TTL_SECONDS });
        // node-redis returns 'OK' on first-write, null on NX-miss. ioredis is
        // identical. Any other shape is a protocol surprise — fail-open and
        // log so the platform team notices.
        if (res === null) return false;
        if (res === 'OK') return true;
        logger.warn({ res }, 'unexpected Redis SETNX response for MFA replay; failing open');
        return true;
      } catch (err) {
        logger.error({ err, userId }, 'Redis SETNX failed for MFA replay; failing open');
        return true;
      }
    },
    reset() {
      // No-op: Redis keys auto-expire after REPLAY_TTL_SECONDS and tests that
      // need a clean slate should swap the store via __setReplayStoreForTests.
    },
  };
}

// -------------------------------------------------------------------------
// Strategy selection.
// -------------------------------------------------------------------------

let storeInstance: ReplayStore = makeInProcessReplayStore();
let storeInitPromise: Promise<void> | null = null;

/**
 * Pure switch: returns the strategy that should be used given the current
 * environment. Exported for tests / observability — the active strategy
 * is the one stored in module-scope `storeInstance`, which is updated
 * asynchronously after the first Redis connection attempt resolves.
 *
 * The asynchronous upgrade is intentional: we don't block module import on
 * a Redis handshake. Until the upgrade lands the in-process fallback is
 * used, which is functionally equivalent for a single replica. Production
 * deployments with multiple replicas MUST set REDIS_URL AND install `redis`;
 * the server.ts boot warning surfaces the gap.
 */
export async function chooseReplayStore(): Promise<ReplayStore> {
  if (!storeInitPromise) {
    storeInitPromise = (async () => {
      const client = await getRedisClient();
      if (client) {
        storeInstance = makeRedisReplayStore(client);
        logger.info({ kind: storeInstance.kind }, 'MFA replay store initialised');
      }
    })();
  }
  await storeInitPromise;
  return storeInstance;
}

// Kick off the upgrade attempt eagerly so the first request doesn't pay the
// connection cost. Errors are swallowed inside getRedisClient.
void chooseReplayStore();

/** Test-only helper — wipes the replay cache between tests. Not exported in prod usage. */
export function __resetMfaReplayCacheForTests(): void {
  storeInstance.reset();
}

/** Test-only helper — swap in a custom store (e.g. a Redis mock). */
export function __setReplayStoreForTests(store: ReplayStore): void {
  storeInstance = store;
  // Mark init as resolved so chooseReplayStore returns the injected store
  // without trying to upgrade to Redis again.
  storeInitPromise = Promise.resolve();
}

/** Test-only helper — restore the default in-process store. */
export function __resetReplayStoreForTests(): void {
  storeInstance = makeInProcessReplayStore();
  storeInitPromise = null;
}

/**
 * Options accepted by the {@link requireMfa} factory form.
 *
 * - `enrollmentRequired: true` switches to STRICT mode: when the acting user
 *   does not have MFA enabled the request is rejected 403
 *   `code: 'mfa_enrollment_required'` instead of passing through. Use this on
 *   routes whose blast radius makes "MFA optional" unacceptable (admin user
 *   mutations, billing money-movers). The default (false / unset) preserves
 *   the legacy pass-through behaviour for routine flows like change-password
 *   and PATCH /me where an MFA prompt would surprise non-enrolled users.
 */
export type RequireMfaOptions = {
  enrollmentRequired?: boolean;
};

async function runRequireMfa(
  req: Request,
  _res: Response,
  next: NextFunction,
  opts: RequireMfaOptions,
): Promise<void> {
  try {
    if (!req.user) return next(Unauthorized());

    const userId = req.user.sub;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, tenant_id: true, role: true, mfa_enabled: true, mfa_secret_enc: true },
    });
    if (!user) return next(Unauthorized('Invalid session'));

    // SVT-SEC-MFA-ENROLMENT-2026-05 (P1-6) — STRICT variant: the routine
    // pass-through ("no MFA enrolled → nothing to step up against") leaks a
    // privilege-escalation pivot when applied to high-blast routes (admin
    // user mutations, refund/void/cancel-plan). With `enrollmentRequired`
    // set, an account without MFA enabled is rejected outright with a
    // dedicated error code the FE renders as an "enrol MFA before
    // continuing" prompt. Default behaviour (option unset) is preserved so
    // change-password and PATCH /me keep their MFA-optional flow.
    if (!user.mfa_enabled) {
      if (opts.enrollmentRequired) {
        return next(
          Object.assign(Unauthorized('MFA enrolment required for this action'), {
            status: 403,
            title: 'Forbidden',
            code: 'mfa_enrollment_required',
          }),
        );
      }
      // SVT-SEC-MFA-ADMIN-POLICY-2026-05 (P1-A6) — tenant opt-in: when
      // `tenants.require_mfa_for_admins=true`, every ADMIN role user MUST
      // have MFA enrolled before they can touch a requireMfa route. This is
      // the operator-controlled hard stop on top of the per-route
      // enrollmentRequired flag — flipping it forces every admin to enrol
      // without us having to re-wire individual routes.
      if (user.role === 'ADMIN') {
        let policyOn = false;
        try {
          const tenant = await prisma.tenant.findUnique({
            where: { id: user.tenant_id },
            select: { require_mfa_for_admins: true },
          });
          policyOn = tenant?.require_mfa_for_admins === true;
        } catch (err) {
          // Defensive: if the column isn't present yet (migration not
          // applied) or the lookup fails, fall back to the legacy
          // pass-through. We still log loudly so operators notice.
          logger.warn(
            { err, userId, tenantId: user.tenant_id },
            'requireMfa: tenant policy lookup failed — defaulting to legacy pass-through',
          );
        }
        if (policyOn) {
          return next(
            Object.assign(Unauthorized('MFA enrolment required by tenant policy'), {
              status: 403,
              title: 'Forbidden',
              code: 'mfa_required_for_admin',
            }),
          );
        }
        // Pass-through but make NOISE: an ADMIN acting on a MFA-gated route
        // without MFA enrolled is a future audit finding waiting to happen.
        // WARN log + Sentry breadcrumb so operators see the pattern and can
        // flip require_mfa_for_admins. We dispatch the breadcrumb via the
        // existing captureException sink (which is a no-op when Sentry is
        // disabled) using a synthetic Error tagged for the dashboard.
        logger.warn(
          {
            userId,
            tenantId: user.tenant_id,
            route: req.originalUrl,
            method: req.method,
          },
          'requireMfa: admin action by user without MFA enrolled (P1-A6)',
        );
        try {
          captureException(
            new Error('admin action by user without MFA enrolled'),
            {
              type: 'mfa.admin_without_mfa',
              user_id: userId,
              tenant_id: user.tenant_id,
              route: req.originalUrl,
              method: req.method,
            },
          );
        } catch {
          // captureException already swallows internal errors; this catch
          // is defensive against the import surface.
        }
      }
      return next();
    }

    const headerVal = req.header('x-mfa-code');
    if (!headerVal) {
      return next(Unauthorized('MFA step-up required', 'mfa_required'));
    }

    // P0-WB2 (2026-05) — per-user throttle BEFORE the (expensive) decrypt +
    // HMAC verify, so a flooded user can't keep us busy doing crypto. The
    // throttle increments on every header-bearing attempt regardless of
    // whether the code shape is valid; an attacker spamming garbage codes
    // burns their budget exactly the same as a real guess.
    if (!recordMfaAttempt(userId)) {
      return next(
        Object.assign(Unauthorized('Too many MFA attempts; try again shortly.'), {
          status: 429,
          title: 'Too Many Requests',
          code: 'mfa_throttled',
        }),
      );
    }

    const code = headerVal.trim();
    // Code must be exactly 6 digits to even be considered. Saves a decrypt +
    // HMAC round trip on obviously-malformed input.
    if (!/^\d{6}$/.test(code)) {
      return next(Unauthorized('Invalid MFA code', 'mfa_invalid'));
    }

    // Defensive: mfa_enabled=true with no secret stored is a misconfiguration
    // (matches the same branch in auth.service login flow). Refuse rather
    // than silently bypass.
    if (!user.mfa_secret_enc) {
      return next(Unauthorized('MFA misconfigured for account', 'mfa_invalid'));
    }

    const secret = await decryptField(Buffer.from(user.mfa_secret_enc));
    if (!verifyTotp(secret, code)) {
      return next(Unauthorized('Invalid MFA code', 'mfa_invalid'));
    }

    // Atomic "claim this code" — true = first use, false = replay. The
    // check + set is done inside the store so two replicas racing the same
    // TOTP cannot both pass under the Redis strategy.
    const store = await chooseReplayStore();
    const fresh = await store.markIfFresh(userId, code);
    if (!fresh) {
      return next(Unauthorized('MFA code already used; wait for a fresh one', 'mfa_replay'));
    }

    req.mfaVerifiedAt = new Date();

    // Fire-and-forget audit row. Never fail the request on audit-write hiccup
    // (writeAudit already swallows errors but we keep the .catch for clarity).
    void writeAudit({
      action: 'auth.mfa.step_up',
      entity_type: 'user',
      entity_id: userId,
      actor_id: userId,
      tenant_id: user.tenant_id,
      request_id: req.requestId ?? null,
      metadata: { route: req.originalUrl, method: req.method, strict: !!opts.enrollmentRequired },
    }).catch((err) =>
      logger.warn({ err, userId }, 'mfa step-up audit write failed (non-fatal)'),
    );

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Express middleware that requires a fresh TOTP step-up for the wrapped route.
 *
 * Two usage shapes (legacy bare-function for backwards compatibility, and a
 * factory that takes an options object):
 *
 *   // Routine (pass-through when no MFA enrolled):
 *   router.post('/payments/:id/refunds', authenticate, tenantContext,
 *               requireRole('ADMIN'), requireMfa, uuidParam('id'), ...);
 *
 *   // Strict (reject 403 mfa_enrollment_required if not enrolled):
 *   router.post('/users/:id', requireRole('ADMIN'),
 *               requireMfa({ enrollmentRequired: true }), ...);
 *
 * Pre-conditions: `authenticate` must have populated `req.user`. If not we
 * return 401 (defensive — the route wiring is the real guard).
 */
export function requireMfa(req: Request, res: Response, next: NextFunction): Promise<void>;
export function requireMfa(
  opts: RequireMfaOptions,
): (req: Request, res: Response, next: NextFunction) => Promise<void>;
export function requireMfa(
  reqOrOpts: Request | RequireMfaOptions,
  res?: Response,
  next?: NextFunction,
):
  | Promise<void>
  | ((req: Request, res: Response, next: NextFunction) => Promise<void>) {
  // Heuristic: a Request object always carries `header`/`headers` while an
  // options bag does not. Choose the form based on arity + shape.
  if (typeof next === 'function' && res !== undefined) {
    return runRequireMfa(reqOrOpts as Request, res, next, {});
  }
  const opts = (reqOrOpts as RequireMfaOptions) ?? {};
  return (req: Request, r: Response, n: NextFunction) => runRequireMfa(req, r, n, opts);
}
