// Commissions HTTP controller. State-machine endpoints + admin patch + summary.
//
// Idempotency: invoice + mark-paid both go through `withIdempotency` so that
// an accidental double-click (network retry, browser back-button) cannot
// allocate two invoice numbers or recognise the payment twice.

import type { NextFunction, Request, Response } from 'express';
import { createHash } from 'node:crypto';

import {
  CommissionListQuery,
  DisputeRequest,
  InvoiceRequest,
  MarkPaidRequest,
  ResolveDisputeRequest,
  UpdateCommissionRequest,
} from '@spv/zod-schemas';

import { BadRequest, PreconditionFailed, Unauthorized } from '../../shared/errors.js';
import { withIdempotency, type PrismaLike } from '../../shared/idempotency.js';

import * as svc from './service.js';

function ensureUser(req: Request) {
  if (!req.user) throw Unauthorized();
  return req.user;
}

function readIdempotencyKey(req: Request): string {
  const raw = req.header('idempotency-key');
  if (!raw) throw BadRequest('Idempotency-Key header required');
  const key = raw.trim();
  if (key.length < 8 || key.length > 128) {
    throw BadRequest('Idempotency-Key must be 8-128 characters');
  }
  return key;
}

/**
 * Parse the optional If-Match header into a numeric version. Returns
 * `undefined` when the header is missing — callers treat that as "skip the
 * optimistic-concurrency check" for backwards compatibility. A malformed
 * header is rejected with 412 (RFC 7232 §3.1: a syntactically invalid
 * If-Match is treated as a precondition failure).
 */
function readIfMatch(req: Request): number | undefined {
  const raw = req.header('If-Match');
  if (!raw) return undefined;
  const stripped = raw.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  const n = Number.parseInt(stripped, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw PreconditionFailed('If-Match must be a numeric version (e.g. "3").');
  }
  return n;
}

function hashBody(scope: string, id: string, body: unknown): string {
  return createHash('sha256').update(JSON.stringify({ scope, id, body })).digest('hex');
}

function dbForIdem(req: Request): PrismaLike {
  // The idempotency_records reads/writes MUST run through the RLS-scoped
  // client so the per-request app.tenant_id GUC is set. Falling back to the
  // singleton would silently bypass tenant isolation.
  if (!req.db) throw new Error('tenantContext middleware not applied');
  return req.db as unknown as PrismaLike;
}

// ---------------------------------------------------------------------------
// list / get
// ---------------------------------------------------------------------------

export async function listHandler(req: Request, res: Response, next: NextFunction) {
  try {
    ensureUser(req);
    const q = req.query as unknown as CommissionListQuery;
    const result = await svc.list(req, q);
    res.json({ data: result.data, page: { total: result.total } });
  } catch (err) {
    next(err);
  }
}

export async function getByIdHandler(req: Request, res: Response, next: NextFunction) {
  try {
    ensureUser(req);
    const id = req.params['id']!;
    const row = await svc.getById(req, id);
    if (row && typeof (row as { version?: number }).version === 'number') {
      res.setHeader('ETag', `"${(row as { version: number }).version}"`);
    }
    res.json(row);
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------------------------------------
// state-machine
// ---------------------------------------------------------------------------

export async function claimHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const user = ensureUser(req);
    const id = req.params['id']!;
    const idem = readIdempotencyKey(req);
    // SVT-FIN-2026-08 — the route already REQUIRED an Idempotency-Key here via
    // moneyMoverGuards, but requireIdempotencyKey only asserts the header is
    // present; it does not cache anything. This handler called the service
    // directly, so a retry re-executed a money transition instead of replaying
    // the original response. Its siblings (invoice / mark-paid /
    // resolve-dispute) were already wrapped; these three were not.
    const result = await withIdempotency<unknown>(
      {
        db: dbForIdem(req),
        tenantId: user.tid,
        scope: 'commissions.claim',
        key: idem,
        requestHash: hashBody('commissions.claim', id, null),
      },
      async () => ({ status: 200, body: await svc.claim(req, id) }),
    );
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(result.status).json(result.body);
  } catch (err) {
    next(err);
  }
}

export async function invoiceHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const user = ensureUser(req);
    const id = req.params['id']!;
    const body = req.body as InvoiceRequest;
    const idem = readIdempotencyKey(req);

    const result = await withIdempotency<unknown>(
      {
        db: dbForIdem(req),
        tenantId: user.tid,
        scope: 'commissions.invoice',
        key: idem,
        requestHash: hashBody('commissions.invoice', id, body),
      },
      async () => ({ status: 200, body: await svc.invoice(req, id, body) }),
    );
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(result.status).json(result.body);
  } catch (err) {
    next(err);
  }
}

export async function markPaidHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const user = ensureUser(req);
    const id = req.params['id']!;
    const body = req.body as MarkPaidRequest;
    const idem = readIdempotencyKey(req);

    const result = await withIdempotency<unknown>(
      {
        db: dbForIdem(req),
        tenantId: user.tid,
        scope: 'commissions.mark_paid',
        key: idem,
        requestHash: hashBody('commissions.mark_paid', id, body),
      },
      async () => ({ status: 200, body: await svc.markPaid(req, id, body) }),
    );
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(result.status).json(result.body);
  } catch (err) {
    next(err);
  }
}

export async function disputeHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const user = ensureUser(req);
    const id = req.params['id']!;
    const body = req.body as Record<string, unknown>;
    const idem = readIdempotencyKey(req);
    // SVT-FIN-2026-08 — the route already REQUIRED an Idempotency-Key here via
    // moneyMoverGuards, but requireIdempotencyKey only asserts the header is
    // present; it does not cache anything. This handler called the service
    // directly, so a retry re-executed a money transition instead of replaying
    // the original response. Its siblings (invoice / mark-paid /
    // resolve-dispute) were already wrapped; these three were not.
    const result = await withIdempotency<unknown>(
      {
        db: dbForIdem(req),
        tenantId: user.tid,
        scope: 'commissions.dispute',
        key: idem,
        requestHash: hashBody('commissions.dispute', id, body),
      },
      async () => ({ status: 200, body: await svc.dispute(req, id, body as never) }),
    );
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(result.status).json(result.body);
  } catch (err) {
    next(err);
  }
}

export async function resolveDisputeHandler(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const user = ensureUser(req);
    const id = req.params['id']!;
    const body = req.body as ResolveDisputeRequest;
    const idem = readIdempotencyKey(req);

    // Wrapped in idempotency for parity with /invoice + /mark-paid: a duplicate
    // click while the request is in-flight must not double-audit or attempt to
    // resolve twice (the second pass would 409 once status flips to INVOICED).
    const result = await withIdempotency<unknown>(
      {
        db: dbForIdem(req),
        tenantId: user.tid,
        scope: 'commissions.resolve_dispute',
        key: idem,
        requestHash: hashBody('commissions.resolve_dispute', id, body),
      },
      async () => ({ status: 200, body: await svc.resolveDispute(req, id, body) }),
    );
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(result.status).json(result.body);
  } catch (err) {
    next(err);
  }
}

export async function waiveHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const user = ensureUser(req);
    const id = req.params['id']!;
    const idem = readIdempotencyKey(req);
    // SVT-FIN-2026-08 — the route already REQUIRED an Idempotency-Key here via
    // moneyMoverGuards, but requireIdempotencyKey only asserts the header is
    // present; it does not cache anything. This handler called the service
    // directly, so a retry re-executed a money transition instead of replaying
    // the original response. Its siblings (invoice / mark-paid /
    // resolve-dispute) were already wrapped; these three were not.
    const result = await withIdempotency<unknown>(
      {
        db: dbForIdem(req),
        tenantId: user.tid,
        scope: 'commissions.waive',
        key: idem,
        requestHash: hashBody('commissions.waive', id, null),
      },
      async () => ({ status: 200, body: await svc.waive(req, id) }),
    );
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(result.status).json(result.body);
  } catch (err) {
    next(err);
  }
}

export async function patchHandler(req: Request, res: Response, next: NextFunction) {
  try {
    ensureUser(req);
    const expected = readIfMatch(req);
    const after = await svc.patch(
      req,
      req.params['id']!,
      req.body as UpdateCommissionRequest,
      expected,
    );
    if (after && typeof (after as { version?: number }).version === 'number') {
      res.setHeader('ETag', `"${(after as { version: number }).version}"`);
    }
    res.json(after);
  } catch (err) {
    next(err);
  }
}

export async function summaryHandler(req: Request, res: Response, next: NextFunction) {
  try {
    ensureUser(req);
    const result = await svc.summary(req);
    res.json(result);
  } catch (err) {
    next(err);
  }
}
