// Routes for /api/v1/expiries — read-only triaged inbox of expiring artefacts.
//
// All authenticated roles (ADMIN / COUNSELLOR / VIEWER) can read. There are
// no mutations here; the surface is a denormalised view aggregated from the
// owning modules. Mutations belong on the source rows themselves.

import { Router } from 'express';

import { ExpiriesListQuery } from '@spv/zod-schemas';

import { requireRole } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';

import * as ctl from './controller.js';

export const expiriesRouter: Router = Router();

// authenticate + tenantContext are applied at the mount point in app.ts.

expiriesRouter.get(
  '/',
  requireRole('ADMIN', 'COUNSELLOR', 'VIEWER'),
  validate(ExpiriesListQuery, 'query'),
  ctl.listHandler,
);
