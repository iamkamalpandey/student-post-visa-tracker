import { Router } from 'express';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { tenantContext } from '../../middlewares/tenantContext.js';
import { uuidParam } from '../../middlewares/uuidParam.js';
import { validate } from '../../middlewares/validate.js';
import {
  CreateReminderRequest,
  ReminderListQuery,
  SnoozeReminderRequest,
  UpdateReminderRequest,
} from '@spv/zod-schemas';
import { reminderController as c } from './controller.js';

// Mounted at /api/v1/reminders. authenticate + tenantContext run for every
// route so handlers can rely on req.user / req.db being populated.
//
// Role policy:
//   - GET routes: any authenticated role (VIEWER is implicitly allowed read).
//   - POST/PATCH/lifecycle actions: ADMIN or COUNSELLOR (we exclude VIEWER
//     via requireRole — auth.ts already blocks VIEWER from non-GET methods,
//     but explicit is better than implicit).
//   - DELETE: ADMIN only — the service double-checks too.
export const remindersRouter: Router = Router();
remindersRouter.use(authenticate, tenantContext);

remindersRouter.get('/', validate(ReminderListQuery, 'query'), c.list);
remindersRouter.get('/:id', uuidParam('id'), c.get);

remindersRouter.post(
  '/',
  requireRole('ADMIN', 'COUNSELLOR'),
  validate(CreateReminderRequest),
  c.create,
);

remindersRouter.patch(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  validate(UpdateReminderRequest),
  c.update,
);

remindersRouter.post(
  '/:id/acknowledge',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  c.acknowledge,
);

remindersRouter.post(
  '/:id/snooze',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  validate(SnoozeReminderRequest),
  c.snooze,
);

remindersRouter.post(
  '/:id/dismiss',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  c.dismiss,
);

remindersRouter.delete('/:id', uuidParam('id'), requireRole('ADMIN'), c.remove);
