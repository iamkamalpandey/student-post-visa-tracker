import type { NextFunction, Request, Response } from 'express';
import type { PrismaClient } from '@prisma/client';
import type {
  CreateInterviewQuestionRequest,
  UpdateInterviewQuestionRequest,
  InterviewQuestionListQuery,
  InterviewAttemptListQuery,
  InterviewPrepStartRequest,
  InterviewPrepSubmitBatchRequest,
} from '@spv/zod-schemas';

import { Unauthorized, BadRequest } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import { runIdempotent } from '../../shared/idempotencyHandler.js';
import { withTenantTx } from '../../shared/tenantTx.js';
import * as service from './service.js';
import { verifyPrepToken } from './token.js';

function requireUser(req: Request) {
  if (!req.user) throw Unauthorized();
  return req.user;
}

function dbFor(req: Request): PrismaClient {
  const db = req.db as unknown as PrismaClient | undefined;
  if (!db) throw new Error('tenantContext middleware not applied');
  return db;
}

// ---------------------------------------------------------------------------
// Admin — question bank
// ---------------------------------------------------------------------------

export async function listQuestions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const data = await service.listQuestions(dbFor(req), user.tid, req.query as InterviewQuestionListQuery);
    res.json({ data });
  } catch (err) { next(err); }
}

export async function getQuestion(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const row = await service.getQuestion(dbFor(req), user.tid, req.params['id']!);
    res.json(row);
  } catch (err) { next(err); }
}

export async function createQuestion(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const body = req.body as CreateInterviewQuestionRequest;
    await runIdempotent(req, res, { scope: 'interview-questions.create' }, async () => {
      const created = await service.createQuestion(dbFor(req), user.tid, body);
      const id = (created as { id: string }).id;
      await writeAudit(req, {
        action: 'interview_question.created',
        entity_type: 'InterviewQuestion',
        entity_id: id,
        after: created,
      });
      res.setHeader('Location', `/api/v1/interview-questions/${id}`);
      return created;
    });
  } catch (err) { next(err); }
}

export async function updateQuestion(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    const body = req.body as UpdateInterviewQuestionRequest;
    const updated = await service.updateQuestion(dbFor(req), user.tid, id, body);
    await writeAudit(req, {
      action: 'interview_question.updated',
      entity_type: 'InterviewQuestion',
      entity_id: id,
      after: updated,
    });
    res.json(updated);
  } catch (err) { next(err); }
}

export async function deleteQuestion(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const id = req.params['id']!;
    await service.softDeleteQuestion(dbFor(req), user.tid, id);
    await writeAudit(req, {
      action: 'interview_question.deleted',
      entity_type: 'InterviewQuestion',
      entity_id: id,
    });
    res.status(204).end();
  } catch (err) { next(err); }
}

// ---------------------------------------------------------------------------
// Admin — attempt listing
// ---------------------------------------------------------------------------

export async function listAttempts(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const result = await service.listAttempts(dbFor(req), user.tid, req.query as unknown as InterviewAttemptListQuery);
    res.json(result);
  } catch (err) { next(err); }
}

export async function getAttempt(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const row = await service.getAttempt(dbFor(req), user.tid, req.params['id']!);
    res.json(row);
  } catch (err) { next(err); }
}

// ---------------------------------------------------------------------------
// Admin — generate shareable link
// ---------------------------------------------------------------------------

export async function generateLink(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const user = requireUser(req);
    const { createPrepToken } = await import('./token.js');
    const token = await createPrepToken(user.tid);
    res.json({ token, url: `/interview-prep?t=${token}` });
  } catch (err) { next(err); }
}

// ---------------------------------------------------------------------------
// Public — student-facing (no auth)
// ---------------------------------------------------------------------------

export async function publicValidateToken(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = req.query['t'] as string | undefined;
    if (!token) throw BadRequest('Missing access token');
    const payload = await verifyPrepToken(token);

    // SVT-SEC-2026-08 (T0-7) — public token route: there is no session and so
    // no tenantContext, but the token names its tenant. Scope to it rather than
    // using the GUC-less singleton, which returned null under the production
    // role and made every valid prep link report "Invalid access token".
    const tenant = await withTenantTx(payload.tid, (tx) => tx.tenant.findUnique({
      where: { id: payload.tid },
      select: { id: true, name: true },
    }));
    if (!tenant) throw BadRequest('Invalid access token');

    res.json({ tenant_id: tenant.id, tenant_name: tenant.name });
  } catch (err) { next(err); }
}

export async function publicStartTest(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = req.query['t'] as string | undefined;
    if (!token) throw BadRequest('Missing access token');
    const payload = await verifyPrepToken(token);

    const body = req.body as InterviewPrepStartRequest;
    // SVT-SEC-2026-08 (T0-7) — the interview_* tables are RLS-scoped and this
    // is a public token route with no session, so nothing sets the GUC. Passing
    // the bare singleton meant every question set came back empty under the
    // production role and the page reported "No questions available".
    const { questions, institution_id } = await withTenantTx(payload.tid, (tx) =>
      service.buildQuestionSet(tx, payload.tid, body),
    );

    if (questions.length === 0) {
      res.json({ attempt: null, questions: [], message: 'No questions available for this configuration.' });
      return;
    }

    const attempt = await withTenantTx(payload.tid, (tx) =>
      service.createAttempt(tx, payload.tid, body, questions.length, institution_id),
    );

    // Return questions without revealing institution_id (proprietary system stance)
    const sanitized = questions.map((q) => ({
      id: q.id,
      category: q.category,
      question_text: q.question_text,
    }));

    res.status(201).json({ attempt_id: attempt.id, questions: sanitized });
  } catch (err) { next(err); }
}

export async function publicSubmitAnswers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = req.query['t'] as string | undefined;
    if (!token) throw BadRequest('Missing access token');
    const payload = await verifyPrepToken(token);

    const attemptId = req.params['attemptId']!;
    const body = req.body as InterviewPrepSubmitBatchRequest;
    const result = await withTenantTx(payload.tid, (tx) =>
      service.submitAnswers(tx, payload.tid, attemptId, body.answers),
    );
    res.json(result);
  } catch (err) { next(err); }
}

export async function publicCompleteAttempt(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = req.query['t'] as string | undefined;
    if (!token) throw BadRequest('Missing access token');
    const payload = await verifyPrepToken(token);

    const attemptId = req.params['attemptId']!;
    const result = await withTenantTx(payload.tid, (tx) =>
      service.completeAttempt(tx, payload.tid, attemptId),
    );
    res.json(result);
  } catch (err) { next(err); }
}
