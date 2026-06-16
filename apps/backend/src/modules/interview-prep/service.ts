import type { PrismaClient } from '@prisma/client';
import type {
  CreateInterviewQuestionRequest,
  UpdateInterviewQuestionRequest,
  InterviewQuestionListQuery,
  InterviewAttemptListQuery,
  InterviewPrepStartRequest,
  InterviewPrepSubmitAnswerRequest,
} from '@spv/zod-schemas';
import { Conflict, NotFound, UnprocessableEntity } from '../../shared/errors.js';

type DB = PrismaClient;

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === 'P2002';
}

// ---------------------------------------------------------------------------
// Admin — question bank CRUD
// ---------------------------------------------------------------------------

export async function listQuestions(db: DB, tenantId: string, q: InterviewQuestionListQuery) {
  const where: Record<string, unknown> = { tenant_id: tenantId, deleted_at: null };
  if (q.country_code) where.country_code = q.country_code;
  if (q.category) where.category = q.category;
  if (q.institution_id) where.institution_id = q.institution_id;
  if (q.academic_level) where.academic_level = q.academic_level;
  if (q.is_active !== undefined) where.is_active = q.is_active;

  return db.interviewQuestion.findMany({
    where,
    include: { institution: { select: { id: true, display_name: true } } },
    orderBy: [{ country_code: 'asc' }, { category: 'asc' }, { sort_order: 'asc' }, { created_at: 'asc' }],
  });
}

export async function getQuestion(db: DB, tenantId: string, id: string) {
  const row = await db.interviewQuestion.findFirst({
    where: { id, tenant_id: tenantId, deleted_at: null },
    include: { institution: { select: { id: true, display_name: true } } },
  });
  if (!row) throw NotFound('Interview question not found');
  return row;
}

export async function createQuestion(db: DB, tenantId: string, input: CreateInterviewQuestionRequest) {
  try {
    return await db.interviewQuestion.create({
      data: {
        tenant_id: tenantId,
        country_code: input.country_code,
        academic_level: input.academic_level ?? null,
        institution_id: input.institution_id ?? null,
        category: input.category,
        question_text: input.question_text,
        model_answer: input.model_answer ?? null,
        tips: input.tips ?? null,
        sort_order: input.sort_order ?? 0,
        is_active: input.is_active ?? true,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw Conflict('Duplicate interview question');
    throw err;
  }
}

export async function updateQuestion(
  db: DB,
  tenantId: string,
  id: string,
  input: UpdateInterviewQuestionRequest,
) {
  const existing = await db.interviewQuestion.findFirst({
    where: { id, tenant_id: tenantId, deleted_at: null },
  });
  if (!existing) throw NotFound('Interview question not found');

  const data: Record<string, unknown> = {};
  if (input.country_code !== undefined) data.country_code = input.country_code;
  if (input.academic_level !== undefined) data.academic_level = input.academic_level ?? null;
  if (input.institution_id !== undefined) data.institution_id = input.institution_id ?? null;
  if (input.category !== undefined) data.category = input.category;
  if (input.question_text !== undefined) data.question_text = input.question_text;
  if (input.model_answer !== undefined) data.model_answer = input.model_answer ?? null;
  if (input.tips !== undefined) data.tips = input.tips ?? null;
  if (input.sort_order !== undefined) data.sort_order = input.sort_order;
  if (input.is_active !== undefined) data.is_active = input.is_active;

  try {
    const wr = await db.interviewQuestion.updateMany({
      where: { id, tenant_id: tenantId, deleted_at: null },
      data,
    });
    if (wr.count !== 1) throw NotFound('Interview question not found');
    return db.interviewQuestion.findFirstOrThrow({ where: { id, tenant_id: tenantId } });
  } catch (err) {
    if (isUniqueViolation(err)) throw Conflict('Duplicate interview question');
    throw err;
  }
}

export async function softDeleteQuestion(db: DB, tenantId: string, id: string) {
  const existing = await db.interviewQuestion.findFirst({
    where: { id, tenant_id: tenantId, deleted_at: null },
    select: { id: true },
  });
  if (!existing) throw NotFound('Interview question not found');

  const wr = await db.interviewQuestion.updateMany({
    where: { id, tenant_id: tenantId, deleted_at: null },
    data: { deleted_at: new Date(), is_active: false },
  });
  if (wr.count !== 1) throw NotFound('Interview question not found');
}

// ---------------------------------------------------------------------------
// Admin — attempt listing + detail
// ---------------------------------------------------------------------------

export async function listAttempts(db: DB, tenantId: string, q: InterviewAttemptListQuery) {
  const where: Record<string, unknown> = { tenant_id: tenantId };
  if (q.status) where.status = q.status;
  if (q.country_code) where.country_code = q.country_code;
  if (q.candidate_email) where.candidate_email = q.candidate_email;

  const limit = q.limit ?? 25;
  const cursor = q.cursor;

  const items = await db.interviewAttempt.findMany({
    where,
    orderBy: { started_at: 'desc' },
    take: limit + 1,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
  });

  const hasMore = items.length > limit;
  if (hasMore) items.pop();

  return {
    data: items,
    next_cursor: hasMore ? items[items.length - 1]?.id : null,
  };
}

export async function getAttempt(db: DB, tenantId: string, id: string) {
  const row = await db.interviewAttempt.findFirst({
    where: { id, tenant_id: tenantId },
    include: {
      answers: {
        include: { question: { select: { question_text: true, model_answer: true, tips: true, category: true } } },
        orderBy: { answered_at: 'asc' },
      },
    },
  });
  if (!row) throw NotFound('Interview attempt not found');
  return row;
}

// ---------------------------------------------------------------------------
// Public — student-facing
// ---------------------------------------------------------------------------

export async function buildQuestionSet(db: DB, tenantId: string, input: InterviewPrepStartRequest) {
  const where: Record<string, unknown> = {
    tenant_id: tenantId,
    country_code: input.country_code,
    is_active: true,
    deleted_at: null,
  };

  const questions = await db.interviewQuestion.findMany({
    where: {
      ...where,
      OR: [
        { academic_level: null },
        { academic_level: input.academic_level },
      ],
    },
    select: {
      id: true,
      category: true,
      question_text: true,
      sort_order: true,
      institution_id: true,
    },
    orderBy: [{ category: 'asc' }, { sort_order: 'asc' }],
    take: 200,
  });

  // Try to match institution by name for institution-specific questions
  const institution = await db.institution.findFirst({
    where: {
      tenant_id: tenantId,
      deleted_at: null,
      OR: [
        { display_name: { equals: input.institution_name, mode: 'insensitive' as const } },
        { legal_name: { equals: input.institution_name, mode: 'insensitive' as const } },
        { short_name: { equals: input.institution_name, mode: 'insensitive' as const } },
      ],
    },
    select: { id: true },
  });

  // Filter: include general questions + matched institution questions
  // Exclude institution-specific questions for OTHER institutions
  const filtered = questions.filter((q) => {
    if (!q.institution_id) return true;
    if (institution && q.institution_id === institution.id) return true;
    return false;
  });

  // Filter out I20_ANALYSIS if student didn't opt in
  const final = filtered.filter((q) => {
    if (q.category === 'I20_ANALYSIS' && !input.has_i20) return false;
    return true;
  });

  return { questions: final, institution_id: institution?.id ?? null };
}

export async function createAttempt(
  db: DB,
  tenantId: string,
  input: InterviewPrepStartRequest,
  questionCount: number,
  institutionId: string | null,
) {
  return db.interviewAttempt.create({
    data: {
      tenant_id: tenantId,
      candidate_name: input.candidate_name,
      candidate_email: input.candidate_email,
      country_code: input.country_code,
      institution_name: input.institution_name,
      institution_id: institutionId,
      course_name: input.course_name,
      academic_level: input.academic_level,
      intake_label: input.intake_label,
      has_i20: input.has_i20 ?? false,
      question_count: questionCount,
      status: 'IN_PROGRESS',
    },
  });
}

export async function submitAnswers(
  db: DB,
  tenantId: string,
  attemptId: string,
  answers: InterviewPrepSubmitAnswerRequest[],
) {
  const attempt = await db.interviewAttempt.findFirst({
    where: { id: attemptId, tenant_id: tenantId },
  });
  if (!attempt) throw NotFound('Attempt not found');
  if (attempt.status !== 'IN_PROGRESS') {
    throw UnprocessableEntity('Attempt is already completed or abandoned');
  }

  const upserts = answers.map((a) =>
    db.interviewAnswer.upsert({
      where: { attempt_id_question_id: { attempt_id: attemptId, question_id: a.question_id } },
      create: {
        attempt_id: attemptId,
        question_id: a.question_id,
        answer_text: a.answer_text,
        time_spent_seconds: a.time_spent_seconds ?? null,
      },
      update: {
        answer_text: a.answer_text,
        time_spent_seconds: a.time_spent_seconds ?? null,
        answered_at: new Date(),
      },
    }),
  );

  await db.$transaction(upserts);

  const answeredCount = await db.interviewAnswer.count({ where: { attempt_id: attemptId } });
  await db.interviewAttempt.update({
    where: { id: attemptId },
    data: { answered_count: answeredCount },
  });

  return { answered_count: answeredCount };
}

export async function completeAttempt(db: DB, tenantId: string, attemptId: string) {
  const attempt = await db.interviewAttempt.findFirst({
    where: { id: attemptId, tenant_id: tenantId },
  });
  if (!attempt) throw NotFound('Attempt not found');
  if (attempt.status !== 'IN_PROGRESS') {
    throw UnprocessableEntity('Attempt is already completed or abandoned');
  }

  await db.interviewAttempt.update({
    where: { id: attemptId },
    data: { status: 'COMPLETED', completed_at: new Date() },
  });

  return db.interviewAttempt.findFirst({
    where: { id: attemptId, tenant_id: tenantId },
    include: {
      answers: {
        include: {
          question: {
            select: { question_text: true, model_answer: true, tips: true, category: true },
          },
        },
        orderBy: { answered_at: 'asc' },
      },
    },
  });
}
