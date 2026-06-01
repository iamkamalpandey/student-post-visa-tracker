// SuperAgentCommissionRule CRUD nested under
// /super-agents/:id/commission-rules. Admin-only writes; reads open to any
// authenticated user (counsellors need to see effective rates while picking
// a super-agent during enrollment).

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';

import {
  CreateSuperAgentCommissionRuleRequest,
  UpdateSuperAgentCommissionRuleRequest,
  Uuid,
} from '@spv/zod-schemas';

import { requireRole } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { BadRequest, NotFound, Unauthorized, UnprocessableEntity } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';

function param(name: string, schema: z.ZodTypeAny) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const raw = req.params[name];
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return next(BadRequest(`Invalid path parameter: ${name}`));
    }
    req.params[name] = parsed.data as string;
    next();
  };
}

function requireUser(req: Request) {
  if (!req.user) throw Unauthorized();
  return req.user;
}

function dbFor(req: Request): PrismaClient {
  const db = req.db as unknown as PrismaClient | undefined;
  if (!db) {
    throw new Error('tenantContext middleware not applied to commission-rules route');
  }
  return db;
}

async function ensureSuperAgent(db: PrismaClient, tenantId: string, saId: string) {
  const sa = await db.superAgent.findFirst({
    where: { id: saId, tenant_id: tenantId, deleted_at: null },
    select: { id: true },
  });
  if (!sa) throw NotFound('Super-agent not found');
}

export const commissionRulesRouter: Router = Router({ mergeParams: true });

commissionRulesRouter.get(
  '/',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const db = dbFor(req);
      const saId = req.params['id']!;
      await ensureSuperAgent(db, user.tid, saId);
      const rows = await db.superAgentCommissionRule.findMany({
        where: { tenant_id: user.tid, super_agent_id: saId },
        orderBy: [{ effective_from: 'desc' }],
        include: {
          institution: { select: { id: true, display_name: true } },
        },
      });
      res.json({ data: rows });
    } catch (err) {
      next(err);
    }
  },
);

commissionRulesRouter.post(
  '/',
  requireRole('ADMIN'),
  validate(CreateSuperAgentCommissionRuleRequest),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const db = dbFor(req);
      const saId = req.params['id']!;
      await ensureSuperAgent(db, user.tid, saId);
      const body = req.body as typeof CreateSuperAgentCommissionRuleRequest._type;
      // If institution_id supplied, ensure it belongs to this tenant.
      if (body.institution_id) {
        const inst = await db.institution.findFirst({
          where: { id: body.institution_id, tenant_id: user.tid, deleted_at: null },
          select: { id: true },
        });
        if (!inst) throw UnprocessableEntity('institution_id not found in this tenant');
      }
      const created = await db.superAgentCommissionRule.create({
        data: {
          tenant_id: user.tid,
          super_agent_id: saId,
          institution_id: body.institution_id ?? null,
          program_level: body.program_level ?? null,
          commission_pct: body.commission_pct,
          currency: body.currency,
          effective_from: new Date(body.effective_from),
          effective_to: body.effective_to ? new Date(body.effective_to) : null,
          notes: body.notes ?? null,
          created_by_id: user.sub,
        },
      });
      await writeAudit(req, {
        action: 'super_agent_commission_rule.created',
        entity_type: 'SuperAgentCommissionRule',
        entity_id: created.id,
        after: {
          ...created,
          commission_pct: created.commission_pct.toString(),
          effective_from: created.effective_from.toISOString(),
          effective_to: created.effective_to?.toISOString() ?? null,
        },
      });
      res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  },
);

commissionRulesRouter.patch(
  '/:ruleId',
  param('ruleId', Uuid),
  requireRole('ADMIN'),
  validate(UpdateSuperAgentCommissionRuleRequest),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const db = dbFor(req);
      const saId = req.params['id']!;
      const ruleId = req.params['ruleId']!;
      const body = req.body as typeof UpdateSuperAgentCommissionRuleRequest._type;
      const data: Record<string, unknown> = {};
      if (body.institution_id !== undefined) data['institution_id'] = body.institution_id ?? null;
      if (body.program_level !== undefined) data['program_level'] = body.program_level ?? null;
      if (body.commission_pct !== undefined) data['commission_pct'] = body.commission_pct;
      if (body.currency !== undefined) data['currency'] = body.currency;
      if (body.effective_from !== undefined) data['effective_from'] = new Date(body.effective_from);
      if (body.effective_to !== undefined) {
        data['effective_to'] = body.effective_to ? new Date(body.effective_to) : null;
      }
      if (body.notes !== undefined) data['notes'] = body.notes ?? null;

      const wr = await db.superAgentCommissionRule.updateMany({
        where: { id: ruleId, tenant_id: user.tid, super_agent_id: saId },
        data,
      });
      if (wr.count !== 1) throw NotFound('Commission rule not found');
      const updated = await db.superAgentCommissionRule.findFirstOrThrow({
        where: { id: ruleId, tenant_id: user.tid },
      });
      await writeAudit(req, {
        action: 'super_agent_commission_rule.updated',
        entity_type: 'SuperAgentCommissionRule',
        entity_id: ruleId,
        after: {
          commission_pct: updated.commission_pct.toString(),
          effective_from: updated.effective_from.toISOString(),
          effective_to: updated.effective_to?.toISOString() ?? null,
        },
      });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  },
);

commissionRulesRouter.delete(
  '/:ruleId',
  param('ruleId', Uuid),
  requireRole('ADMIN'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = requireUser(req);
      const db = dbFor(req);
      const saId = req.params['id']!;
      const ruleId = req.params['ruleId']!;
      const wr = await db.superAgentCommissionRule.deleteMany({
        where: { id: ruleId, tenant_id: user.tid, super_agent_id: saId },
      });
      if (wr.count !== 1) throw NotFound('Commission rule not found');
      await writeAudit(req, {
        action: 'super_agent_commission_rule.deleted',
        entity_type: 'SuperAgentCommissionRule',
        entity_id: ruleId,
      });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  },
);
