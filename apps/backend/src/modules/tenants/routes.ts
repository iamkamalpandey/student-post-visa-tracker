import { Router } from 'express';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { tenantContext } from '../../middlewares/tenantContext.js';
import { validate } from '../../middlewares/validate.js';
import { UpdateTenantSettingsRequest } from '@spv/zod-schemas';
import { tenantsController } from './controller.js';

// SVT-WAVE17-TENANT-2026-05 — admin-only self-service tenant settings.
export const tenantsRouter: Router = Router();
tenantsRouter.use(authenticate, tenantContext, requireRole('ADMIN'));
tenantsRouter.get('/me', tenantsController.getMe);
tenantsRouter.patch('/me', validate(UpdateTenantSettingsRequest), tenantsController.updateMe);
