// SuperAgent HTTP controller — thin handlers; the service contains the rules.
//
// `req.db` is the RLS-scoped Prisma client populated by tenantContext middleware.
// We intentionally do NOT fall back to the unscoped singleton: every endpoint
// here is mutational or admin-only and must run inside the tenant policy
// boundary. If `req.db` is missing it's a wiring bug and we fail loudly.

import type { NextFunction, Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import type {
  CreateSuperAgentRequest,
  SuperAgentListQuery,
  UpdateSuperAgentRequest,
} from '@spv/zod-schemas';

import { BadRequest, Unauthorized } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import { readIfMatch } from '../../shared/ifMatch.js';
import { notifyStatusTransition } from '../../shared/transitionNotify.js';
import { runIdempotent } from '../../shared/idempotencyHandler.js';
import * as service from './service.js';
import { resolveCommissionRate } from './commission-resolver.js';

function requireUser(req: Request) {
  if (!req.user) throw Unauthorized();
  return req.user;
}

function dbFor(req: Request): PrismaClient {
  const db = req.db as unknown as PrismaClient | undefined;
  if (!db) {
    // Missing RLS-scoped client — refuse rather than silently bypassing tenant policy.
    throw new Error('tenantContext middleware not applied to /super-agents route');
  }
  return db;
}

export async function listHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = requireUser(req);
    const data = await service.list(
      dbFor(req),
      user.tid,
      req.query as SuperAgentListQuery,
    );
    res.json({ data });
  } catch (err) {
    next(err);
  }
}

export async function getHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const row = await service.getById(dbFor(req), user.tid, id);
    if (row && typeof (row as { version?: number }).version === 'number') {
      res.setHeader('ETag', `"${(row as { version: number }).version}"`);
    }
    res.json(row);
  } catch (err) {
    next(err);
  }
}

export async function createHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = requireUser(req);
    const body = req.body as CreateSuperAgentRequest;
    await runIdempotent(req, res, { scope: 'super-agents.create' }, async () => {
      const created = await service.create(dbFor(req), user.tid, user.sub, body);
      const id = (created as { id: string }).id;
      await writeAudit(req, {
        action: 'super_agent.created',
        entity_type: 'SuperAgent',
        entity_id: id,
        after: created,
      });
      res.setHeader('Location', `/api/v1/super-agents/${id}`);
      if (typeof (created as { version?: number }).version === 'number') {
        res.setHeader('ETag', `"${(created as { version: number }).version}"`);
      }
      return created;
    });
  } catch (err) {
    next(err);
  }
}

export async function updateHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const body = req.body as UpdateSuperAgentRequest & { reason_code?: string };
    const expected = readIfMatch(req);
    // SVT-WAVE5-TXN-NOTIFY: capture before-status so we can fire an in-app
    // notification when the FSM transitions (PAUSED, RESUMED, TERMINATED).
    const before = await dbFor(req).superAgent.findFirst({
      where: { id, tenant_id: user.tid },
      select: { status: true, name: true },
    });
    const updated = await service.update(
      dbFor(req),
      user.tid,
      user.sub,
      id,
      body,
      expected,
      user.role,
      body.reason_code,
    );
    await writeAudit(req, {
      action: 'super_agent.updated',
      entity_type: 'SuperAgent',
      entity_id: id,
      after: updated,
    });
    if (before && body.status !== undefined && before.status !== body.status) {
      const after = updated as { name: string; status: string };
      void notifyStatusTransition({
        tenantId: user.tid,
        entityId: id,
        title: `Super-agent ${after.name} → ${after.status}`,
        body: body.reason_code ? `Reason: ${body.reason_code}` : undefined,
        href: `/super-agents/${id}`,
        actorId: user.sub,
        source: 'super_agent',
      });
    }
    if (typeof (updated as { version?: number }).version === 'number') {
      res.setHeader('ETag', `"${(updated as { version: number }).version}"`);
    }
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

export async function deleteHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    await service.softDelete(dbFor(req), user.tid, user.sub, id);
    await writeAudit(req, {
      action: 'super_agent.deleted',
      entity_type: 'SuperAgent',
      entity_id: id,
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

export async function metricsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const data = await service.metrics(dbFor(req), user.tid, id);
    res.json(data);
  } catch (err) {
    next(err);
  }
}

// GET /super-agents/:id/resolve-commission
//   ?institution_id=<uuid> & program_level=<string?> & as_of=<ISO8601?>
//
// Mirrors the resolver used by the commissions module so the FE can preview
// the rate that *will* be applied when the enrolment lands in CommissionClaim.
// Returns { rule_id, commission_pct, currency, source } where `source` tells
// the caller whether the rate came from a rule, the super-agent default, or
// the institution default (so the helper text can describe it accurately).
export async function resolveCommissionHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const institutionId = String(req.query['institution_id'] ?? '');
    if (!institutionId) {
      throw BadRequest('institution_id query parameter is required');
    }
    const programLevel = req.query['program_level']
      ? String(req.query['program_level'])
      : null;
    const asOfRaw = req.query['as_of'] ? String(req.query['as_of']) : null;
    const asOf = asOfRaw ? new Date(asOfRaw) : new Date();
    if (Number.isNaN(asOf.getTime())) {
      throw BadRequest('as_of must be a valid ISO 8601 date');
    }
    const db = dbFor(req);
    // Confirm super-agent + institution belong to this tenant. The resolver
    // doesn't re-check; callers (commissions module) gate upstream.
    const sa = await db.superAgent.findFirst({
      where: { id, tenant_id: user.tid, deleted_at: null },
      select: { id: true, default_commission_pct: true, default_currency: true },
    });
    if (!sa) {
      // 404 — match the rest of the module's "not found" surface.
      res.status(404).json({ title: 'Super-agent not found' });
      return;
    }
    const inst = await db.institution.findFirst({
      where: { id: institutionId, tenant_id: user.tid, deleted_at: null },
      select: { id: true, commission_pct: true },
    });
    if (!inst) {
      res.status(404).json({ title: 'Institution not found' });
      return;
    }

    const resolved = await resolveCommissionRate(db, user.tid, {
      superAgentId: id,
      institutionId,
      programLevel,
      asOf,
    });
    if (resolved) {
      res.json({
        rule_id: resolved.ruleId,
        commission_pct: resolved.commissionPct,
        currency: resolved.currency,
        source: 'rule',
      });
      return;
    }
    if (sa.default_commission_pct != null) {
      res.json({
        rule_id: null,
        commission_pct: Number(sa.default_commission_pct.toString()),
        currency: sa.default_currency,
        source: 'super_agent_default',
      });
      return;
    }
    if (inst.commission_pct != null) {
      res.json({
        rule_id: null,
        commission_pct: Number(inst.commission_pct.toString()),
        currency: null,
        source: 'institution_default',
      });
      return;
    }
    res.json({
      rule_id: null,
      commission_pct: null,
      currency: null,
      source: 'none',
    });
  } catch (err) {
    next(err);
  }
}

// GET /super-agents/:id/institutions — list institutions linked to this
// super-agent (mirrors the inverse list at /institutions/:id/super-agents).
// Read-only; reuses the m:n pivot. Used by the per-agent "Linked institutions"
// tab so the FE doesn't have to scan the whole institutions catalogue.
export async function listLinkedInstitutionsHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const db = dbFor(req);
    const sa = await db.superAgent.findFirst({
      where: { id, tenant_id: user.tid, deleted_at: null },
      select: { id: true },
    });
    if (!sa) {
      res.status(404).json({ title: 'Super-agent not found' });
      return;
    }
    const rows = await db.institutionSuperAgent.findMany({
      where: { tenant_id: user.tid, super_agent_id: id, deleted_at: null },
      orderBy: [{ is_preferred: 'desc' }, { created_at: 'asc' }],
      include: {
        institution: {
          select: {
            id: true,
            display_name: true,
            legal_name: true,
            short_name: true,
            country_code: true,
            type: true,
            commission_pct: true,
          },
        },
      },
    });
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
}
