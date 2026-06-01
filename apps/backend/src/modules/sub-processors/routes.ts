import { Router } from 'express';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { tenantContext } from '../../middlewares/tenantContext.js';
import { uuidParam } from '../../middlewares/uuidParam.js';
import { validate } from '../../middlewares/validate.js';
import {
  CreateSubProcessorRequest,
  UpdateSubProcessorRequest,
  SubProcessorListQuery,
} from '@spv/zod-schemas';
import { subProcessorController as c } from './controller.js';

export const subProcessorRouter: Router = Router();
subProcessorRouter.use(authenticate, tenantContext, requireRole('ADMIN'));
subProcessorRouter.post('/', validate(CreateSubProcessorRequest), c.create);
subProcessorRouter.get('/', validate(SubProcessorListQuery, 'query'), c.list);
subProcessorRouter.get('/:id', uuidParam('id'), c.get);
subProcessorRouter.patch('/:id', uuidParam('id'), validate(UpdateSubProcessorRequest), c.update);
subProcessorRouter.delete('/:id', uuidParam('id'), c.remove);
