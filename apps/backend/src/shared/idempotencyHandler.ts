// Thin convenience wrapper around `withIdempotency` for POST creation handlers.
//
// The shared helper in ./idempotency.ts is the workhorse (DB-backed cache,
// race-safe via the (tenant_id, scope, key) UNIQUE constraint). This wrapper
// adapts it to the common controller pattern:
//
//   - If the client supplied an Idempotency-Key header, run the operation
//     under that key. A retry with the same key + same body replays the
//     cached response; a retry with a different body returns 409 Conflict.
//   - If the client did NOT supply a header, the operation runs normally.
//     We keep the header optional to avoid breaking existing FE callers.
//
// Callers pass the intended success status (typically 201 for create) and a
// thunk that does the work. The wrapper sets res.status / res.json itself,
// and adds an `Idempotent-Replayed: true` response header on a cache hit so
// clients (and tests) can tell first-attempt vs replay apart.
//
// Why a wrapper instead of forcing every caller to repeat ~20 lines: there
// are ~30 POST creation routes in this app. Centralising the header parse,
// hash construction, and replay-header logic in one place keeps controllers
// focused on the create itself.

import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

import { BadRequest, HttpError, Unauthorized } from './errors.js';
import { withIdempotency, type PrismaLike } from './idempotency.js';

/**
 * SVT-WAVE-IDEM-MONEY-MOVERS-2026-05 — middleware factory: hard-reject any
 * POST that omits Idempotency-Key. Mount it on the irreversible /
 * money-mover endpoints (record payment, refunds, plan regenerate, DSAR
 * intake, breach intake) so a flaky network or accidental double-click
 * can never mint a duplicate.
 *
 * Returns 400 `idempotency_key_required` (Problem Details JSON, via the
 * usual error middleware). Pairs with `runIdempotent` inside the handler —
 * the middleware guarantees the header is present, the handler hashes the
 * body and does the actual cache check.
 *
 * Why a separate middleware (rather than turning `runIdempotent`'s no-key
 * branch into a 400 always): many endpoints legitimately treat the header
 * as optional (e.g. create-student) — flipping the default would break a
 * dozen FE flows. Explicit opt-in via this middleware keeps the surface
 * area minimal.
 */
export function requireIdempotencyKey(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const raw = req.header('idempotency-key');
  if (!raw || raw.trim().length === 0) {
    next(
      new HttpError({
        status: 400,
        title: 'Bad Request',
        detail: 'Idempotency-Key header is required for this endpoint.',
        code: 'idempotency_key_required',
      }),
    );
    return;
  }
  next();
}

export type IdempotentCreateOpts = {
  scope: string;
  /** Default 201 for POST create. Pass another status (e.g. 200) if needed. */
  status?: number;
  /**
   * Optional parent-resource key to partition the body hash by parent id so
   * the same Idempotency-Key reused across two parents (e.g. revoke consent A
   * vs revoke consent B) is not cross-cached. Folded into the body hash.
   */
  parentKey?: string;
};

function readIdempotencyKey(req: Request): string | null {
  const raw = req.header('idempotency-key');
  if (!raw) return null;
  const key = raw.trim();
  if (key.length === 0) return null;
  // RFC draft caps the value at a sane length; stay well under 255.
  if (key.length > 255) {
    throw BadRequest('Idempotency-Key must be at most 255 characters');
  }
  return key;
}

function dbForIdem(req: Request): PrismaLike {
  if (!req.db) throw new Error('tenantContext middleware not applied');
  return req.db as unknown as PrismaLike;
}

function hashBody(scope: string, body: unknown, parentKey?: string): string {
  return createHash('sha256').update(JSON.stringify({ scope, parentKey, body })).digest('hex');
}

/**
 * Wraps a POST create handler with Idempotency-Key handling. If no key is
 * supplied, simply runs `run` and replies with the result. If a key is
 * supplied, routes through `withIdempotency`.
 *
 * `run` returns the response body; the wrapper assigns the status code itself
 * (defaults to 201). If the operation throws, the error bubbles to the
 * Express error handler exactly as if no wrapper was present.
 */
export async function runIdempotent<T>(
  req: Request,
  res: Response,
  opts: IdempotentCreateOpts,
  run: () => Promise<T>,
): Promise<void> {
  const status = opts.status ?? 201;

  const key = readIdempotencyKey(req);
  if (!key) {
    const body = await run();
    res.status(status).json(body);
    return;
  }

  if (!req.user) throw Unauthorized();
  const tenantId = req.user.tid;
  // SVT-WAVE-BILLING-SEC-P1-F5 — scope every record to the actor too. Two
  // different users posting the same Idempotency-Key on the same scope now
  // run as independent operations (previously UserB would replay UserA's
  // cached response — information disclosure + permissions bypass).
  const userId = req.user.sub;

  // Include the URL path (and any caller-supplied parentKey) in the hash so
  // the same key reused across two unrelated POSTs (e.g. POST /students vs
  // POST /reminders, or POST /consents/A/revoke vs POST /consents/B/revoke)
  // doesn't get cross-cached. The scope already differentiates, but this is
  // belt-and-braces.
  const parentKey = opts.parentKey
    ? `${opts.parentKey}|${req.originalUrl}`
    : req.originalUrl;
  const requestHash = hashBody(opts.scope, req.body, parentKey);

  const result = await withIdempotency<T>(
    {
      db: dbForIdem(req),
      tenantId,
      scope: opts.scope,
      key,
      requestHash,
      userId,
    },
    async () => ({ status, body: await run() }),
  );

  if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
  res.status(result.status).json(result.body);
}
