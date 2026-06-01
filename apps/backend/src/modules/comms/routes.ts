import { Router } from 'express';
import { authenticate, requireRole, requireStudentOwnership } from '../../middlewares/auth.js';
import { tenantContext } from '../../middlewares/tenantContext.js';
import { uuidParam } from '../../middlewares/uuidParam.js';
import { validate } from '../../middlewares/validate.js';
import { inboxMutationLimiter } from '../../middlewares/rateLimit.js';
import {
  CreateMessageTemplateRequest,
  UpdateMessageTemplateRequest,
  MessageTemplateListQuery,
  CreateMessageRequest,
  MessageListQuery,
  SendFromTemplateRequest,
} from '@spv/zod-schemas';
import { messageTemplateController, messageController, inboxController, outboxAdminController, commsThreadsController } from './controller.js';

// /api/v1/message-templates
export const messageTemplateRouter: Router = Router();
messageTemplateRouter.use(authenticate, tenantContext);
messageTemplateRouter.post('/', requireRole('ADMIN'), validate(CreateMessageTemplateRequest), messageTemplateController.create);
messageTemplateRouter.get('/', validate(MessageTemplateListQuery, 'query'), messageTemplateController.list);
messageTemplateRouter.get('/:id', uuidParam('id'), messageTemplateController.get);
messageTemplateRouter.patch('/:id', uuidParam('id'), requireRole('ADMIN'), validate(UpdateMessageTemplateRequest), messageTemplateController.update);
messageTemplateRouter.delete('/:id', uuidParam('id'), requireRole('ADMIN'), messageTemplateController.remove);

// /api/v1/students/:studentId/messages
// SVT-WAVE-BLOCKER-2-2026-05 — every per-student message route gates on
// requireStudentOwnership('studentId'). Without this a COUNSELLOR could
// list, send, render-from-template, or preview-from-template messages on
// any student in the tenant (not just their assigned caseload). ADMIN
// bypasses the check (see middlewares/auth.ts:135).
export const messageStudentRouter: Router = Router({ mergeParams: true });
messageStudentRouter.use(authenticate, tenantContext);
messageStudentRouter.get(
  '/',
  uuidParam('studentId'),
  requireStudentOwnership('studentId'),
  validate(MessageListQuery, 'query'),
  messageController.list,
);
messageStudentRouter.post(
  '/',
  uuidParam('studentId'),
  requireRole('ADMIN', 'COUNSELLOR'),
  requireStudentOwnership('studentId'),
  validate(CreateMessageRequest),
  messageController.create,
);
// SVT-WAVE16-TEMPLATE-2026-05 — send-from-template surface.
messageStudentRouter.post(
  '/from-template',
  uuidParam('studentId'),
  requireRole('ADMIN', 'COUNSELLOR'),
  requireStudentOwnership('studentId'),
  validate(SendFromTemplateRequest),
  messageController.createFromTemplate,
);
// SVT-WAVE18-PREVIEW-2026-05 — dry-render before send.
messageStudentRouter.post(
  '/from-template/preview',
  uuidParam('studentId'),
  requireRole('ADMIN', 'COUNSELLOR'),
  requireStudentOwnership('studentId'),
  validate(SendFromTemplateRequest),
  messageController.previewFromTemplate,
);

// SVT-WAVE19-THREADS-2026-05 — per-tenant thread browser (powers /inbox
// threads tab + student-detail messages). Available to every authenticated
// user; results are tenant-scoped via tenantContext.
export const commsThreadsRouter: Router = Router();
commsThreadsRouter.use(authenticate, tenantContext);
commsThreadsRouter.get('/', commsThreadsController.list);
commsThreadsRouter.get('/:id', uuidParam('id'), commsThreadsController.get);

// SVT-WAVE7-INBOX-2026-05 — per-user IN_APP inbox feeding the bell drawer.
// Auth required; tenant scoping handled by tenantContext + controller WHERE.
// No requireRole — every authenticated user has an inbox (intentional;
// see SVT-SEC-AUDIT-2026-05 — the mutations are protected by
// inboxMutationLimiter instead).
export const inboxRouter: Router = Router();
inboxRouter.use(authenticate, tenantContext);
inboxRouter.get('/messages', inboxController.list);
inboxRouter.post('/messages/read-all', inboxMutationLimiter, inboxController.markAllRead);
inboxRouter.post('/messages/:id/read', inboxMutationLimiter, uuidParam('id'), inboxController.markRead);

// SVT-WAVE9-OUTBOX-HEALTH-2026-05 — admin tooling for outbox observability.
export const outboxAdminRouter: Router = Router();
outboxAdminRouter.use(authenticate, tenantContext, requireRole('ADMIN'));
outboxAdminRouter.get('/health', outboxAdminController.health);
outboxAdminRouter.get('/trend', outboxAdminController.trend);
outboxAdminRouter.get('/metrics', outboxAdminController.metrics);
outboxAdminRouter.get('/messages', outboxAdminController.list);
outboxAdminRouter.post('/requeue-all', outboxAdminController.requeueAll);
outboxAdminRouter.post('/:id/requeue', uuidParam('id'), outboxAdminController.requeue);
