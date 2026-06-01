import { Router } from 'express';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { tenantContext } from '../../middlewares/tenantContext.js';
import { uuidParam } from '../../middlewares/uuidParam.js';
import { validate } from '../../middlewares/validate.js';
import {
  CreateSavedViewRequest,
  UpdateSavedViewRequest,
  SavedViewListQuery,
} from '@spv/zod-schemas';
import { savedViewController as c } from './controller.js';

export const savedViewRouter: Router = Router();
savedViewRouter.use(authenticate, tenantContext);
// SVT-AUDIT-SEC-2026-05 — explicit role gates on every write so a VIEWER
// (read-only role) can't persist or modify saved views. List + get remain
// open to all authenticated users since a saved-view is essentially a
// bookmarked query.
savedViewRouter.post(
  '/',
  requireRole('ADMIN', 'COUNSELLOR'),
  validate(CreateSavedViewRequest),
  c.create,
);
savedViewRouter.get('/', validate(SavedViewListQuery, 'query'), c.list);
savedViewRouter.get('/:id', uuidParam('id'), c.get);
savedViewRouter.patch(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  validate(UpdateSavedViewRequest),
  c.update,
);
savedViewRouter.delete(
  '/:id',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  c.remove,
);
