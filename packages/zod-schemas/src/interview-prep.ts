import { z } from 'zod';
import { CountryAlpha2, Email, Uuid } from './common.js';
import { AcademicLevelEnum } from './qualifications.js';

// ---------------------------------------------------------------------------
// Interview Prep — visa interview mock test question bank + attempt tracking
// ---------------------------------------------------------------------------

export const InterviewQuestionCategoryEnum = z.enum([
  'GENERAL',
  'ACADEMIC',
  'FINANCIAL',
  'TIES_TO_HOME',
  'FUTURE_PLANS',
  'PERSONAL',
  'I20_ANALYSIS',
  'DOCUMENT',
]);
export type InterviewQuestionCategory = z.infer<typeof InterviewQuestionCategoryEnum>;

export const INTERVIEW_QUESTION_CATEGORY_LABEL: Record<InterviewQuestionCategory, string> = {
  GENERAL: 'General',
  ACADEMIC: 'Academic',
  FINANCIAL: 'Financial',
  TIES_TO_HOME: 'Ties to Home Country',
  FUTURE_PLANS: 'Future Plans',
  PERSONAL: 'Personal',
  I20_ANALYSIS: 'I-20 Analysis',
  DOCUMENT: 'Document',
};

export const InterviewAttemptStatusEnum = z.enum([
  'IN_PROGRESS',
  'COMPLETED',
  'ABANDONED',
]);
export type InterviewAttemptStatus = z.infer<typeof InterviewAttemptStatusEnum>;

// ---------------------------------------------------------------------------
// Admin CRUD — question bank management
// ---------------------------------------------------------------------------

export const CreateInterviewQuestionRequest = z
  .object({
    country_code: CountryAlpha2,
    academic_level: AcademicLevelEnum.nullable().optional(),
    institution_id: Uuid.nullable().optional(),
    category: InterviewQuestionCategoryEnum,
    question_text: z.string().min(1).max(2000),
    model_answer: z.string().max(4000).nullable().optional(),
    tips: z.string().max(2000).nullable().optional(),
    sort_order: z.number().int().min(0).max(9999).default(0),
    is_active: z.boolean().default(true),
  })
  .strict();
export type CreateInterviewQuestionRequest = z.infer<typeof CreateInterviewQuestionRequest>;

export const UpdateInterviewQuestionRequest = CreateInterviewQuestionRequest.partial().strict();
export type UpdateInterviewQuestionRequest = z.infer<typeof UpdateInterviewQuestionRequest>;

export const InterviewQuestionListQuery = z
  .object({
    country_code: CountryAlpha2.optional(),
    category: InterviewQuestionCategoryEnum.optional(),
    institution_id: Uuid.optional(),
    academic_level: AcademicLevelEnum.optional(),
    is_active: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
      .optional(),
  })
  .strict();
export type InterviewQuestionListQuery = z.infer<typeof InterviewQuestionListQuery>;

// ---------------------------------------------------------------------------
// Admin — attempt listing / detail
// ---------------------------------------------------------------------------

export const InterviewAttemptListQuery = z
  .object({
    status: InterviewAttemptStatusEnum.optional(),
    country_code: CountryAlpha2.optional(),
    candidate_email: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    cursor: z.string().optional(),
  })
  .strict();
export type InterviewAttemptListQuery = z.infer<typeof InterviewAttemptListQuery>;

// ---------------------------------------------------------------------------
// Public — student-facing (no auth required)
// ---------------------------------------------------------------------------

export const InterviewPrepStartRequest = z
  .object({
    candidate_name: z.string().min(1).max(200),
    candidate_email: Email,
    country_code: CountryAlpha2,
    institution_name: z.string().min(1).max(300),
    course_name: z.string().min(1).max(300),
    academic_level: AcademicLevelEnum,
    intake_label: z.string().min(1).max(100),
    has_i20: z.boolean().default(false),
  })
  .strict();
export type InterviewPrepStartRequest = z.infer<typeof InterviewPrepStartRequest>;

export const InterviewPrepSubmitAnswerRequest = z
  .object({
    question_id: Uuid,
    answer_text: z.string().min(1).max(5000),
    time_spent_seconds: z.number().int().min(0).max(7200).optional(),
  })
  .strict();
export type InterviewPrepSubmitAnswerRequest = z.infer<typeof InterviewPrepSubmitAnswerRequest>;

export const InterviewPrepSubmitBatchRequest = z
  .object({
    answers: z.array(InterviewPrepSubmitAnswerRequest).min(1).max(100),
  })
  .strict();
export type InterviewPrepSubmitBatchRequest = z.infer<typeof InterviewPrepSubmitBatchRequest>;
