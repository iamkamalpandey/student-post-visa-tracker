// /api/v1/jobs router.
//
// Mounted in app.ts behind `authenticate` + `tenantContext`. Every route
// here is gated by requireRole('ADMIN') — scheduler health is operational
// data and should not be exposed to counsellors.
import { Router } from 'express';

import { JobRunListQuery } from '@spv/zod-schemas';

import { requireRole } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';

import * as ctl from './controller.js';

export const jobsRouter: Router = Router();

jobsRouter.use(requireRole('ADMIN'));

// GET /api/v1/jobs/recent?limit=20[&job_name=reminder.dispatcher]
//   -> { data: JobRunRow[] }
jobsRouter.get('/recent', validate(JobRunListQuery, 'query'), ctl.listRecentHandler);
