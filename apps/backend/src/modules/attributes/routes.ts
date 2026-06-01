import { Router } from 'express';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { tenantContext } from '../../middlewares/tenantContext.js';
import { uuidParam } from '../../middlewares/uuidParam.js';
import { validate } from '../../middlewares/validate.js';
import {
  CreateAttributeDefinitionRequest,
  UpdateAttributeDefinitionRequest,
  AttributeDefinitionListQuery,
  CreateEntityAttributeRequest,
  UpdateEntityAttributeRequest,
  EntityAttributeListQuery,
} from '@spv/zod-schemas';
import { attributeDefinitionController, entityAttributeController } from './controller.js';

// /api/v1/attribute-definitions  (admin only — they govern the schema)
export const attributeDefinitionRouter: Router = Router();
attributeDefinitionRouter.use(authenticate, tenantContext);
attributeDefinitionRouter.get('/', validate(AttributeDefinitionListQuery, 'query'), attributeDefinitionController.list);
attributeDefinitionRouter.get('/:id', uuidParam('id'), attributeDefinitionController.get);
attributeDefinitionRouter.post('/', requireRole('ADMIN'), validate(CreateAttributeDefinitionRequest), attributeDefinitionController.create);
attributeDefinitionRouter.patch('/:id', uuidParam('id'), requireRole('ADMIN'), validate(UpdateAttributeDefinitionRequest), attributeDefinitionController.update);
attributeDefinitionRouter.delete('/:id', uuidParam('id'), requireRole('ADMIN'), attributeDefinitionController.remove);

// /api/v1/entity-attributes  (any authenticated tenant user — they consume values)
export const entityAttributeRouter: Router = Router();
entityAttributeRouter.use(authenticate, tenantContext);
entityAttributeRouter.post('/', requireRole('ADMIN', 'COUNSELLOR'), validate(CreateEntityAttributeRequest), entityAttributeController.create);
entityAttributeRouter.get('/', validate(EntityAttributeListQuery, 'query'), entityAttributeController.list);
entityAttributeRouter.get('/:id', uuidParam('id'), entityAttributeController.get);
entityAttributeRouter.patch('/:id', uuidParam('id'), requireRole('ADMIN', 'COUNSELLOR'), validate(UpdateEntityAttributeRequest), entityAttributeController.update);
entityAttributeRouter.delete('/:id', uuidParam('id'), requireRole('ADMIN'), entityAttributeController.remove);
