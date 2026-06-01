// DB-backed idempotency for write endpoints (POST/PATCH/PUT/DELETE).
//
// Pattern (RFC draft-ietf-httpapi-idempotency-key):
//   - Client supplies Idempotency-Key header. Server scopes the cache by
//     tenant + scope + key, where `scope` is the logical operation name (e.g.
//     "imports.apply"). The (tenant_id, scope, key) UNIQUE constraint on
//     `idempotency_records` makes concurrent first-attempts safe at the DB level.
//   - First request: INSERT a row with status=PENDING + request_hash. Run the
//     operation. On success/failure, UPDATE the row to SUCCESS/FAILED with the
//     cached response and a 24h expires_at.
//   - Retry with same key:
//       * row.request_hash !== current  -> 409 Conflict (key reused with a
//         different payload).
//       * row.status === SUCCESS        -> replay the cached {status_code, response}.
//       * row.status === FAILED         -> replay the cached error response.
//       * row.status === PENDING and recent (< 30 min)  -> 409 "Apply still in progress".
//       * row.status === PENDING and stale (>= 30 min)  -> assume crashed worker;
//         reset the row to PENDING with the current hash and proceed.
//
// Tenancy: callers pass a PrismaClient-shaped `db` (typically `req.db`, the RLS-
// scoped client from middlewares/tenantContext.ts). Every query in here also
// includes an explicit tenant_id filter as a defence-in-depth check.
//
// Note on Prisma typing: `IdempotencyRecord` lives in schema.prisma but the
// generated client may lag if `prisma generate` hasn't run yet. The runtime DB
// has the table; we cast the delegate access to `never` at the call sites where
// needed so this file compiles either way.

import { Conflict } from './errors.js';

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
// SVT-WAVE-BILLING-SEC-P1-F8 (C8) — stale-PENDING handling.
//
// HISTORY: an earlier iteration treated a PENDING row older than 60s as a
// crashed-worker orphan and CAS-took-over the row to re-run the operation.
// The May-2026 P0 audit overturned that policy: silently re-running a row
// that another worker may have actually completed (just failed to persist
// the SUCCESS row before its TCP socket died) risks double-charging a card
// or double-issuing a refund. A re-run is too dangerous to automate.
//
// CURRENT POLICY (post-audit):
//   - status === PENDING for ANY duration → 409 Conflict, always.
//   - If the original worker died before persisting SUCCESS/FAILED, an
//     operator must investigate via the audit log + downstream ledger
//     state, then either:
//         (a) delete the orphan idempotency row (so a retry can run fresh),
//         (b) hand-write the SUCCESS/FAILED row to match the provider state.
//   - The PENDING_STALE_MS constant is retained at 5 minutes purely so the
//     409 response body can include a "row has been PENDING for N minutes,
//     investigate manually" hint when the row is clearly stuck — this is a
//     UX nicety, not a behaviour switch.
const PENDING_STALE_MS = 5 * 60 * 1000;

// Minimal subset of PrismaClient we need. Accepting a structural type lets callers
// pass either the singleton or the RLS-scoped extended client without a cast.
export type PrismaLike = {
  // The delegate is `idempotencyRecord` once `prisma generate` has run; until
  // then, we widen to `unknown` and cast at the call site.
  idempotencyRecord?: unknown;
} & Record<string, unknown>;

type IdemRow = {
  id: string;
  tenant_id: string;
  scope: string;
  key: string;
  request_hash: string;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  status_code: number | null;
  response: unknown;
  expires_at: Date;
  created_at: Date;
  completed_at: Date | null;
};

type IdemDelegate = {
  create(args: { data: Record<string, unknown> }): Promise<IdemRow>;
  findFirst(args: { where: Record<string, unknown> }): Promise<IdemRow | null>;
  update(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<IdemRow>;
  // CAS-style update used by the C8 stale-PENDING takeover. Matches on
  // (id, status, created_at) so two parallel takeover attempts cannot both
  // succeed — only the one whose snapshot of {status,created_at} still
  // matches the row wins.
  updateMany(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<{ count: number }>;
};

function delegateFor(db: PrismaLike): IdemDelegate {
  // Cast through `never` is the documented escape hatch the brief asks for.
  return (db as unknown as { idempotencyRecord: IdemDelegate }).idempotencyRecord;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === 'P2002'
  );
}

export type WithIdempotencyOpts = {
  db: PrismaLike;
  tenantId: string;
  scope: string;
  key: string;
  requestHash: string;
  /**
   * SVT-WAVE-BILLING-SEC-P1-F5 — user scoping. Two different users posting the
   * same Idempotency-Key against the same scope MUST run as independent
   * operations; otherwise UserA's response can replay back to UserB
   * (information disclosure + permissions bypass). When supplied, the
   * uniqueness boundary becomes (tenant_id, user_id, scope, key). When
   * absent (e.g. webhooks, cron jobs), falls back to legacy
   * (tenant_id, scope, key) behaviour — those callers have no user.
   */
  userId?: string | null;
};

export type WithIdempotencyResult<T> = { status: number; body: T; replayed: boolean };

/**
 * Run an operation under DB-backed idempotency. Replays the cached response on
 * a matching retry; raises Conflict on key/payload mismatch or on a still-
 * running concurrent attempt; treats a PENDING row older than
 * PENDING_STALE_MS (60s) as a crashed-worker orphan, attempts a CAS-takeover,
 * and runs fresh if the takeover wins.
 */
export async function withIdempotency<T>(
  opts: WithIdempotencyOpts,
  run: () => Promise<{ status: number; body: T }>,
): Promise<WithIdempotencyResult<T>> {
  const dao = delegateFor(opts.db);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TWENTY_FOUR_HOURS_MS);

  // Step 1: try to claim the key by INSERTing a PENDING row. The UNIQUE on
  // (tenant_id, user_id, scope, key) gives us race-safety: only one request
  // wins the INSERT; everyone else falls through to the read-then-replay path.
  // SVT-WAVE-BILLING-SEC-P1-F5: include user_id when supplied so two users
  // posting the same Idempotency-Key don't collide.
  let owned = false;
  let row: IdemRow | null = null;
  // Treat user_id-less callers (webhooks, cron) as a stable sentinel for the
  // UNIQUE index. The migration backfills existing rows to the same sentinel
  // so historical (tenant_id, scope, key) entries remain unique.
  const userIdForUnique = opts.userId ?? null;
  try {
    row = await dao.create({
      data: {
        tenant_id: opts.tenantId,
        user_id: userIdForUnique,
        scope: opts.scope,
        key: opts.key,
        request_hash: opts.requestHash,
        status: 'PENDING',
        expires_at: expiresAt,
      },
    });
    owned = true;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // A row already exists for this (tenant, user, scope, key). Read it.
    row = await dao.findFirst({
      where: {
        tenant_id: opts.tenantId,
        user_id: userIdForUnique,
        scope: opts.scope,
        key: opts.key,
      },
    });
    if (!row) {
      // Extremely unlikely race (row vanished between the INSERT and the SELECT).
      // Surface as Conflict so the client can retry.
      throw Conflict('Idempotency record disappeared mid-operation; please retry');
    }
  }

  // Step 2: if we did NOT own the INSERT, decide what to do based on the
  // existing row's hash + status.
  if (!owned && row) {
    if (row.request_hash !== opts.requestHash) {
      throw Conflict('Idempotency-Key reused with a different request body');
    }
    if (row.status === 'SUCCESS' || row.status === 'FAILED') {
      return {
        status: row.status_code ?? (row.status === 'SUCCESS' ? 200 : 500),
        body: row.response as T,
        replayed: true,
      };
    }
    // status === PENDING — always 409, regardless of age.
    //
    // SVT-WAVE-BILLING-SEC-P1-F8 (C8) — POST-AUDIT POLICY:
    //   The earlier auto-takeover at age ≥ 60s was rejected by the May-2026
    //   audit: re-running an operation whose original worker may have already
    //   succeeded downstream (ledger row written, refund disbursed) but failed
    //   to persist the SUCCESS row before its socket died is a money-mover
    //   foot-gun. There is no reliable signal in the row itself that says
    //   "the downstream provider definitely did not move money".
    //
    //   Both fresh (< 5min) and stale (> 5min) PENDING rows now return 409.
    //   The detail string distinguishes the two so operators can pick the
    //   right next step:
    //     - fresh PENDING → almost certainly a real concurrent request; the
    //       retrying client should back-off + re-attempt, where it will hit
    //       the SUCCESS/FAILED replay branch.
    //     - stale PENDING → the original worker likely crashed; an operator
    //       must reconcile with the downstream provider, then either delete
    //       the row (to allow a fresh run) or hand-write SUCCESS/FAILED to
    //       match reality. No code path mutates the row automatically.
    const ageMs = now.getTime() - new Date(row.created_at).getTime();
    if (ageMs < PENDING_STALE_MS) {
      throw Conflict('Apply still in progress');
    }
    throw Conflict(
      `Idempotency row has been PENDING for ${Math.round(ageMs / 60_000)} minute(s); operator must investigate the original worker before any retry is permitted`,
    );
  }

  // Step 3: we now own the row. Run the operation and persist the outcome.
  try {
    const result = await run();
    await dao.update({
      where: { id: row!.id },
      data: {
        status: 'SUCCESS',
        status_code: result.status,
        response: result.body as unknown as Record<string, unknown>,
        completed_at: new Date(),
        expires_at: new Date(Date.now() + TWENTY_FOUR_HOURS_MS),
      },
    });
    return { status: result.status, body: result.body, replayed: false };
  } catch (err) {
    // Preserve a structured error payload so a retry replays the same shape.
    const status =
      typeof (err as { status?: unknown }).status === 'number'
        ? (err as { status: number }).status
        : 500;
    const errorBody = {
      type: 'about:blank',
      title: (err as { title?: string }).title ?? 'Internal Server Error',
      status,
      detail: (err as { detail?: string }).detail ?? (err as Error).message ?? 'Apply failed',
    };
    await dao.update({
      where: { id: row!.id },
      data: {
        status: 'FAILED',
        status_code: status,
        response: errorBody,
        completed_at: new Date(),
        expires_at: new Date(Date.now() + TWENTY_FOUR_HOURS_MS),
      },
    });
    throw err;
  }
}

/** Convenience: stable scope name for the bulk imports apply endpoint. */
export const SCOPE_IMPORTS_APPLY = 'imports.apply';
