import { Router } from 'express';
import { authenticate, requireRole } from '../../middlewares/auth.js';
import { tenantContext } from '../../middlewares/tenantContext.js';
import { uuidParam } from '../../middlewares/uuidParam.js';
import { validate } from '../../middlewares/validate.js';
import { CreateNoteRequest, UpdateNoteRequest, NoteListQuery } from '@spv/zod-schemas';
import { noteController as c } from './controller.js';

export const noteRouter: Router = Router();
noteRouter.use(authenticate, tenantContext);
noteRouter.post('/', requireRole('ADMIN', 'COUNSELLOR'), validate(CreateNoteRequest), c.create);
noteRouter.get('/', validate(NoteListQuery, 'query'), c.list);
noteRouter.get('/:id', uuidParam('id'), c.get);
noteRouter.patch('/:id', uuidParam('id'), requireRole('ADMIN', 'COUNSELLOR'), validate(UpdateNoteRequest), c.update);
noteRouter.delete('/:id', uuidParam('id'), requireRole('ADMIN'), c.remove);
