import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import {
  CreateInterviewQuestionRequest,
  UpdateInterviewQuestionRequest,
  InterviewQuestionListQuery,
  InterviewAttemptListQuery,
  InterviewPrepStartRequest,
  InterviewPrepSubmitBatchRequest,
  Uuid,
} from '@spv/zod-schemas';
import { requireRole } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { BadRequest } from '../../shared/errors.js';
import * as ctl from './controller.js';

function param(name: string, schema: z.ZodTypeAny) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const raw = req.params[name];
    const parsed = schema.safeParse(raw);
    if (!parsed.success) return next(BadRequest(`Invalid path parameter: ${name}`));
    req.params[name] = parsed.data as string;
    next();
  };
}

const requireUuidId = param('id', Uuid);
const requireUuidAttemptId = param('attemptId', Uuid);

// ---------------------------------------------------------------------------
// Admin routes (mounted behind authenticate + tenantContext in app.ts)
// ---------------------------------------------------------------------------

export const interviewQuestionsRouter: Router = Router();

interviewQuestionsRouter.get('/', validate(InterviewQuestionListQuery, 'query'), ctl.listQuestions);
interviewQuestionsRouter.post(
  '/',
  requireRole('ADMIN'),
  validate(CreateInterviewQuestionRequest),
  ctl.createQuestion,
);
interviewQuestionsRouter.get('/:id', requireUuidId, ctl.getQuestion);
interviewQuestionsRouter.patch(
  '/:id',
  requireUuidId,
  requireRole('ADMIN'),
  validate(UpdateInterviewQuestionRequest),
  ctl.updateQuestion,
);
interviewQuestionsRouter.delete('/:id', requireUuidId, requireRole('ADMIN'), ctl.deleteQuestion);

// Admin — attempt management
export const interviewAttemptsRouter: Router = Router();

interviewAttemptsRouter.get('/', validate(InterviewAttemptListQuery, 'query'), ctl.listAttempts);
interviewAttemptsRouter.get('/:id', requireUuidId, ctl.getAttempt);

// Admin — generate shareable link
interviewQuestionsRouter.post('/generate-link', requireRole('ADMIN'), ctl.generateLink);

// ---------------------------------------------------------------------------
// Public routes (no auth — mounted before authenticate in app.ts)
// ---------------------------------------------------------------------------

const publicPrepLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    type: 'about:blank',
    title: 'Too Many Requests',
    status: 429,
    detail: 'Interview prep rate limit exceeded; try again later.',
  },
});

export const publicInterviewPrepRouter: Router = Router();

publicInterviewPrepRouter.use(publicPrepLimiter);

publicInterviewPrepRouter.get('/interview-prep/validate', ctl.publicValidateToken);

publicInterviewPrepRouter.post(
  '/interview-prep/start',
  validate(InterviewPrepStartRequest),
  ctl.publicStartTest,
);

publicInterviewPrepRouter.post(
  '/interview-prep/attempts/:attemptId/answers',
  requireUuidAttemptId,
  validate(InterviewPrepSubmitBatchRequest),
  ctl.publicSubmitAnswers,
);

publicInterviewPrepRouter.post(
  '/interview-prep/attempts/:attemptId/complete',
  requireUuidAttemptId,
  ctl.publicCompleteAttempt,
);
