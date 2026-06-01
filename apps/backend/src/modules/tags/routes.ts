import { Router } from 'express';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { tenantContext } from '../../middlewares/tenantContext.js';
import { uuidParam } from '../../middlewares/uuidParam.js';
import { validate } from '../../middlewares/validate.js';
import {
  CreateTagRequest,
  UpdateTagRequest,
  TagListQuery,
  CreateEntityTagRequest,
  EntityTagListQuery,
} from '@spv/zod-schemas';
import { tagController, entityTagController } from './controller.js';

// /api/v1/tags
export const tagRouter: Router = Router();
tagRouter.use(authenticate, tenantContext);
tagRouter.post('/', requireRole('ADMIN'), validate(CreateTagRequest), tagController.create);
tagRouter.get('/', validate(TagListQuery, 'query'), tagController.list);
tagRouter.get('/:id', uuidParam('id'), tagController.get);
tagRouter.patch('/:id', uuidParam('id'), requireRole('ADMIN'), validate(UpdateTagRequest), tagController.update);
tagRouter.delete('/:id', uuidParam('id'), requireRole('ADMIN'), tagController.remove);

// /api/v1/entity-tags  (POST + DELETE only; GET list helper)
export const entityTagRouter: Router = Router();
entityTagRouter.use(authenticate, tenantContext);
entityTagRouter.post('/', requireRole('ADMIN', 'COUNSELLOR'), validate(CreateEntityTagRequest), entityTagController.create);
entityTagRouter.get('/', validate(EntityTagListQuery, 'query'), entityTagController.list);
entityTagRouter.delete('/:id', uuidParam('id'), requireRole('ADMIN', 'COUNSELLOR'), entityTagController.remove);
