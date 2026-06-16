import { z } from 'zod';
import { CountryAlpha2, CurrencyCode, Iso8601Date, PaginationQuery, Uuid } from './common.js';
import { AcademicLevelEnum } from './qualifications.js';
export { AcademicLevelEnum } from './qualifications.js';
export type { AcademicLevel } from './qualifications.js';

export const DeliveryModeEnum = z.enum(['IN_PERSON', 'ONLINE', 'HYBRID', 'DISTANCE']);
export type DeliveryMode = z.infer<typeof DeliveryModeEnum>;

export const RequirementCategoryEnum = z.enum([
  'ACADEMIC',
  'LANGUAGE',
  'TEST',
  'WORK_EXPERIENCE',
  'PORTFOLIO',
  'INTERVIEW',
  'DOCUMENT',
  'FINANCIAL',
  'OTHER',
]);
export type RequirementCategory = z.infer<typeof RequirementCategoryEnum>;

export const FeeAudienceEnum = z.enum(['DOMESTIC', 'INTERNATIONAL', 'REGIONAL', 'OTHER']);
export type FeeAudience = z.infer<typeof FeeAudienceEnum>;

export const FeeTypeEnum = z.enum([
  'TUITION',
  'REGISTRATION',
  'APPLICATION',
  'DEPOSIT',
  'MATERIALS',
  'LIVING_COST_ESTIMATE',
  'OTHER',
]);
export type FeeType = z.infer<typeof FeeTypeEnum>;

export const FeePeriodEnum = z.enum(['TOTAL', 'YEAR', 'SEMESTER', 'TERM', 'MONTH', 'MODULE']);
export type FeePeriod = z.infer<typeof FeePeriodEnum>;

// Cadence pattern — mirrors Prisma `DurationPattern` enum. Drives the
// intake-label suggestions in the UI and informs `terms_per_year` defaults.
export const DurationPatternEnum = z.enum([
  'SEMESTER_2_PER_YEAR',
  'TRIMESTER_3_PER_YEAR',
  'QUARTER_4_PER_YEAR',
  'ANNUAL_COHORT',
  'BIANNUAL_2_YEARS',
  'CONTINUOUS_ENROLLMENT',
  'MONTHLY_INTAKE',
  'MODULAR',
]);
export type DurationPattern = z.infer<typeof DurationPatternEnum>;

// User-facing labels for the cadence enum.
export const DURATION_PATTERN_LABEL: Record<DurationPattern, string> = {
  SEMESTER_2_PER_YEAR: 'Semesters (2/year)',
  TRIMESTER_3_PER_YEAR: 'Trimesters (3/year)',
  QUARTER_4_PER_YEAR: 'Quarters (4/year)',
  ANNUAL_COHORT: 'Annual cohort (1/year)',
  BIANNUAL_2_YEARS: 'Biannual (1 every 2 years)',
  CONTINUOUS_ENROLLMENT: 'Continuous enrollment',
  MONTHLY_INTAKE: 'Monthly intake',
  MODULAR: 'Modular',
};

// Default terms_per_year per cadence. `null` means "no fixed cadence" — admins
// should leave terms_per_year blank in those cases.
export const DURATION_PATTERN_TERMS_PER_YEAR: Record<DurationPattern, number | null> = {
  SEMESTER_2_PER_YEAR: 2,
  TRIMESTER_3_PER_YEAR: 3,
  QUARTER_4_PER_YEAR: 4,
  ANNUAL_COHORT: 1,
  // Biannual = 1 cohort spread over 2 years -> 1 term in any given year.
  BIANNUAL_2_YEARS: 1,
  CONTINUOUS_ENROLLMENT: null,
  MONTHLY_INTAKE: 12,
  MODULAR: null,
};

// Decimal-as-string for credit hours, requirement min_value, etc.
const DecimalString = z
  .string()
  .regex(/^\d{1,8}(\.\d{1,2})?$/, 'must be a decimal like "12.50"');

// ============================================================================
// Program
// ============================================================================

export const ProgramBase = z
  .object({
    code: z.string().min(1).max(40).optional(),
    name: z.string().min(1).max(240),
    short_name: z.string().min(1).max(60).optional(),
    level: AcademicLevelEnum,
    field_of_study: z.string().min(1).max(160).optional(),
    // ISCED-F 2013 (UNESCO) detailed codes are 4 digits whose first two encode
    // one of the 11 broad fields (00 Generic … 10 Services). Enforce that
    // structure rather than accepting any 4 digits.
    isced_code: z
      .string()
      .regex(/^(0\d|10)\d{2}$/, 'isced_code must be a valid 4-digit ISCED-F 2013 code (broad field 00–10)')
      .optional(),
    delivery_mode: DeliveryModeEnum.default('IN_PERSON'),
    // BCP-47 language tag (primary subtag + optional script/region/variant),
    // e.g. en, en-GB, zh-Hans, pt-BR. Replaces a bare min/max length check.
    language_of_instruction: z
      .string()
      .min(2)
      .max(35)
      .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'must be a BCP-47 language tag (e.g. en, en-GB, zh-Hans)')
      .default('en'),
    duration_months: z.number().int().min(1).max(120),
    credit_hours: z.number().int().min(0).max(10000).optional(),
    description: z.string().max(8000).optional(),
    // SVT-SEC-P1-FE1-2026-05 — require http(s) scheme so XSS schemes never persist.
    url: z
      .string()
      .url()
      .max(1024)
      .refine((v) => /^https?:/i.test(v), 'Must be an http(s) URL')
      .optional(),
    // Cadence — both optional. `terms_per_year` may be derived from
    // `duration_pattern` via DURATION_PATTERN_TERMS_PER_YEAR but is stored
    // independently so admins can override (e.g. a 3-term semester program).
    duration_pattern: DurationPatternEnum.optional(),
    terms_per_year: z.number().int().min(1).max(12).optional(),
  })
  .strict();
export type ProgramBase = z.infer<typeof ProgramBase>;

export const CreateProgramRequest = ProgramBase.extend({
  institution_id: Uuid,
  school_id: Uuid.optional(),
  department_id: Uuid.optional(),
}).strict();
export type CreateProgramRequest = z.infer<typeof CreateProgramRequest>;

export const UpdateProgramRequest = ProgramBase.partial()
  .extend({
    school_id: Uuid.optional(),
    department_id: Uuid.optional(),
    is_active: z.boolean().optional(),
  })
  .strict();
export type UpdateProgramRequest = z.infer<typeof UpdateProgramRequest>;

export const ProgramListQuery = PaginationQuery.extend({
  institution_id: Uuid.optional(),
  level: AcademicLevelEnum.optional(),
  field_of_study: z.string().min(1).max(160).optional(),
  isced_code: z
    .string()
    .regex(/^\d{4}$/, 'isced_code must be a 4-digit ISCED-F code')
    .optional(),
  country_code: CountryAlpha2.optional(),
  q: z.string().min(1).max(120).optional(),
}).strict();
export type ProgramListQuery = z.infer<typeof ProgramListQuery>;

// ============================================================================
// Intakes
// ============================================================================

export const CreateProgramIntakeRequest = z
  .object({
    campus_id: Uuid.optional(),
    intake_year: z.number().int().min(2024).max(2050),
    intake_month: z.number().int().min(1).max(12),
    intake_label: z.string().min(1).max(60),
    application_open: Iso8601Date.optional(),
    application_close: Iso8601Date.optional(),
    decision_date: Iso8601Date.optional(),
    classes_start_on: Iso8601Date.optional(),
    classes_end_on: Iso8601Date.optional(),
    capacity: z.number().int().min(0).max(1_000_000).optional(),
    is_open: z.boolean().default(true),
    notes: z.string().max(2000).optional(),
  })
  .strict();
export type CreateProgramIntakeRequest = z.infer<typeof CreateProgramIntakeRequest>;

export const UpdateProgramIntakeRequest = CreateProgramIntakeRequest.partial().strict();
export type UpdateProgramIntakeRequest = z.infer<typeof UpdateProgramIntakeRequest>;

// ============================================================================
// Requirements / Modules
// ============================================================================

export const CreateProgramRequirementRequest = z
  .object({
    category: RequirementCategoryEnum,
    label: z.string().min(1).max(200),
    details: z.string().max(4000).optional(),
    min_value: DecimalString.optional(),
    unit: z.string().min(1).max(40).optional(),
    is_mandatory: z.boolean().default(true),
  })
  .strict();
export type CreateProgramRequirementRequest = z.infer<typeof CreateProgramRequirementRequest>;

export const UpdateProgramRequirementRequest = CreateProgramRequirementRequest.partial().strict();
export type UpdateProgramRequirementRequest = z.infer<typeof UpdateProgramRequirementRequest>;

export const CreateProgramModuleRequest = z
  .object({
    code: z.string().min(1).max(40),
    title: z.string().min(1).max(240),
    credits: DecimalString.optional(),
    semester: z.number().int().min(0).max(20).optional(),
    is_core: z.boolean().default(true),
    description: z.string().max(4000).optional(),
  })
  .strict();
export type CreateProgramModuleRequest = z.infer<typeof CreateProgramModuleRequest>;

export const UpdateProgramModuleRequest = CreateProgramModuleRequest.partial().strict();
export type UpdateProgramModuleRequest = z.infer<typeof UpdateProgramModuleRequest>;

// ============================================================================
// Fees — amount_minor coerced to BigInt so JSON numbers / strings both work
// ============================================================================

export const CreateProgramFeeRequest = z
  .object({
    audience: FeeAudienceEnum.default('INTERNATIONAL'),
    fee_type: FeeTypeEnum,
    amount_minor: z.coerce.bigint().nonnegative(),
    currency: CurrencyCode,
    per_period: FeePeriodEnum.default('YEAR'),
    is_estimated: z.boolean().default(false),
    effective_from: Iso8601Date.optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();
export type CreateProgramFeeRequest = z.infer<typeof CreateProgramFeeRequest>;

export const UpdateProgramFeeRequest = CreateProgramFeeRequest.partial().strict();
export type UpdateProgramFeeRequest = z.infer<typeof UpdateProgramFeeRequest>;
