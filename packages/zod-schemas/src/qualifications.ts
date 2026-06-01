import { z } from 'zod';
import { CountryAlpha2, Iso8601Date, PaginationQuery } from './common.js';

// AcademicLevel — international study-abroad, ISCED-2011 aligned. Mirrors Prisma enum.
export const AcademicLevelEnum = z.enum([
  'PRIMARY',
  'LOWER_SECONDARY',
  'UPPER_SECONDARY',
  'POST_SECONDARY_NON_TERTIARY',
  'FOUNDATION',
  'ASSOCIATE',
  'DIPLOMA',
  'ADVANCED_DIPLOMA',
  'BACHELORS',
  'GRADUATE_CERTIFICATE',
  'GRADUATE_DIPLOMA',
  'POSTGRADUATE_CERTIFICATE',
  'POSTGRADUATE_DIPLOMA',
  'MASTERS',
  'MPHIL',
  'DOCTORATE',
  'PROFESSIONAL',
  'CERTIFICATE',
  'OTHER',
]);
export type AcademicLevel = z.infer<typeof AcademicLevelEnum>;

// Display labels for UI dropdowns. Single source of truth.
export const ACADEMIC_LEVEL_LABEL: Record<z.infer<typeof AcademicLevelEnum>, string> = {
  PRIMARY: 'Primary',
  LOWER_SECONDARY: 'Lower secondary',
  UPPER_SECONDARY: 'Upper secondary (A-level / IB / +2)',
  POST_SECONDARY_NON_TERTIARY: 'Post-secondary (non-tertiary)',
  FOUNDATION: 'Foundation / pathway',
  ASSOCIATE: 'Associate',
  DIPLOMA: 'Diploma',
  ADVANCED_DIPLOMA: 'Advanced diploma',
  BACHELORS: "Bachelor's",
  GRADUATE_CERTIFICATE: 'Graduate certificate',
  GRADUATE_DIPLOMA: 'Graduate diploma',
  POSTGRADUATE_CERTIFICATE: 'Postgraduate certificate',
  POSTGRADUATE_DIPLOMA: 'Postgraduate diploma',
  MASTERS: "Master's",
  MPHIL: 'MPhil',
  DOCTORATE: 'Doctorate (PhD)',
  PROFESSIONAL: 'Professional (MBBS / JD / etc.)',
  CERTIFICATE: 'Certificate',
  OTHER: 'Other',
};

// Backwards-compat: legacy SAARC labels mapped to closest international tier.
// Used by import mappers so old CSV exports still parse.
export const LEGACY_LEVEL_ALIAS: Record<string, z.infer<typeof AcademicLevelEnum>> = {
  SLC: 'UPPER_SECONDARY',
  SECONDARY: 'LOWER_SECONDARY',
  HIGHER_SECONDARY: 'UPPER_SECONDARY',
};

export const CreateQualificationRequest = z
  .object({
    level: AcademicLevelEnum,
    institution: z.string().min(1).max(200),
    board_or_university: z.string().max(200).optional(),
    country_code: CountryAlpha2.optional(),
    field_of_study: z.string().max(200).optional(),
    isced_code: z.string().length(4).optional(),
    started_on: Iso8601Date.optional(),
    completed_on: Iso8601Date.optional(),
    grade_value: z.string().max(40).optional(),
    grade_scale: z.string().max(40).optional(),
    is_highest: z.boolean().default(false),
  })
  .strict();
export type CreateQualificationRequest = z.infer<typeof CreateQualificationRequest>;

export const UpdateQualificationRequest = CreateQualificationRequest.partial().strict();
export type UpdateQualificationRequest = z.infer<typeof UpdateQualificationRequest>;

export const QualificationListQuery = PaginationQuery.extend({
  level: AcademicLevelEnum.optional(),
}).strict();
export type QualificationListQuery = z.infer<typeof QualificationListQuery>;
