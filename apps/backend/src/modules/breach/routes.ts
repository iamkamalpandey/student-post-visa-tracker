import { Router } from 'express';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { heavyReadLimiter } from '../../middlewares/rateLimit.js';
import { requireIdempotencyKey } from '../../shared/idempotencyHandler.js';
import { tenantContext } from '../../middlewares/tenantContext.js';
import { uuidParam } from '../../middlewares/uuidParam.js';
import { validate } from '../../middlewares/validate.js';
import { CreateBreachRequest, UpdateBreachRequest, BreachListQuery } from '@spv/zod-schemas';
import { breachController as c } from './controller.js';

export const breachRouter: Router = Router();
breachRouter.use(authenticate, tenantContext, requireRole('ADMIN'));
// SVT-WAVE-IDEM-MONEY-MOVERS-2026-05 — breach intake is a regulator-clock
// record; a retry on a flaky network must not create a duplicate.
breachRouter.post('/', requireIdempotencyKey, validate(CreateBreachRequest), c.create);
breachRouter.get('/', validate(BreachListQuery, 'query'), c.list);
// SVT-WAVE36-BREACH-DASH-2026-05 — admin dashboard widget counts. Declared
// before the :id route so the literal segment doesn't get swallowed as a UUID.
// SVT-WAVE-MED-2026-05 — heavyReadLimiter (60/min) caps polling abuse.
breachRouter.get('/dashboard-summary', heavyReadLimiter, c.dashboardSummary);
breachRouter.get('/:id', uuidParam('id'), c.get);
breachRouter.patch('/:id', uuidParam('id'), validate(UpdateBreachRequest), c.update);
// SVT-SEC-2026-05 — DELETE explicitly blocked. GDPR Art. 33 + national
// regulators (UK ICO, EU DPAs, India DPDPB) require breach records to be
// retained 5–10 years for evidence. A misclicked DELETE erases regulator-
// facing evidence with no recovery. Use PATCH status='CLOSED' instead.
breachRouter.delete('/:id', (_req, res) => {
  res.status(405).json({
    type: 'about:blank',
    title: 'Method Not Allowed',
    status: 405,
    detail: 'BreachIncident records are append-only for regulatory evidence. Use PATCH status=CLOSED instead.',
  });
});
