// SVT-WAVE-REPORTS-2026-05 — admin-only analytics endpoints.

import { Router, type Request } from 'express';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { tenantContext } from '../../middlewares/tenantContext.js';
import { heavyReadLimiter } from '../../middlewares/rateLimit.js';
import { Unauthorized } from '../../shared/errors.js';
import { reportsService } from './service.js';

export const reportsRouter: Router = Router();
reportsRouter.use(authenticate, tenantContext, requireRole('ADMIN'), heavyReadLimiter);

const DAY_MS = 86_400_000;

function parseDateRange(q: Record<string, unknown>): { from: Date; to: Date } {
  const nowDate = new Date();
  const toRaw = typeof q['to'] === 'string' ? new Date(q['to']) : nowDate;
  const fromRaw = typeof q['from'] === 'string'
    ? new Date(q['from'])
    : new Date(nowDate.getTime() - 365 * DAY_MS);
  const to = Number.isNaN(toRaw.getTime()) ? nowDate : toRaw;
  const from = Number.isNaN(fromRaw.getTime())
    ? new Date(nowDate.getTime() - 365 * DAY_MS)
    : fromRaw;
  const minFrom = new Date(to.getTime() - 3 * 365 * DAY_MS);
  return { from: from < minFrom ? minFrom : from, to };
}

function requireDb(req: Request) {
  const db = req.db;
  if (!db) throw new Error('tenantContext middleware not applied');
  const tid = req.user?.tid;
  if (!tid) throw Unauthorized();
  return { db, tid };
}

reportsRouter.get('/visa-funnel', async (req, res, next) => {
  try {
    const { db, tid } = requireDb(req);
    const filters = {
      visa_type_id: typeof req.query['visa_type_id'] === 'string' ? req.query['visa_type_id'] : null,
    };
    res.json(await reportsService.visaFunnel(db, tid, filters));
  } catch (err) { next(err); }
});

reportsRouter.get('/counsellor-load', async (req, res, next) => {
  try {
    const { db, tid } = requireDb(req);
    const filters = { include_inactive_users: req.query['include_inactive_users'] === 'true' };
    res.json(await reportsService.counsellorLoad(db, tid, filters));
  } catch (err) { next(err); }
});

reportsRouter.get('/commission-revenue', async (req, res, next) => {
  try {
    const { db, tid } = requireDb(req);
    const range = parseDateRange(req.query as Record<string, unknown>);
    const filters = {
      ...range,
      currency: typeof req.query['currency'] === 'string' ? req.query['currency'] : null,
    };
    res.json(await reportsService.commissionRevenue(db, tid, filters));
  } catch (err) { next(err); }
});

reportsRouter.get('/refund-rate', async (req, res, next) => {
  try {
    const { db, tid } = requireDb(req);
    const range = parseDateRange(req.query as Record<string, unknown>);
    res.json(await reportsService.refundRate(db, tid, range));
  } catch (err) { next(err); }
});

reportsRouter.get('/outstanding-by-age', async (req, res, next) => {
  try {
    const { db, tid } = requireDb(req);
    const filters = {
      currency: typeof req.query['currency'] === 'string' ? req.query['currency'] : null,
    };
    res.json(await reportsService.outstandingByAge(db, tid, filters));
  } catch (err) { next(err); }
});
