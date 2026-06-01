import { z } from 'zod';
import { Iso8601Date, PaginationQuery } from './common.js';

export const LanguageTestEnum = z.enum([
  'IELTS',
  'PTE',
  'TOEFL',
  'DUOLINGO',
  'OET',
  'CAMBRIDGE',
  'SAT',
  'GRE',
  'GMAT',
  'OTHER',
]);
export type LanguageTest = z.infer<typeof LanguageTestEnum>;

const Score = z.union([z.number().min(0).max(999), z.string()]);

export const CreateLanguageTestRequest = z
  .object({
    test_type: LanguageTestEnum,
    overall_score: Score,
    listening: Score.optional(),
    reading: Score.optional(),
    writing: Score.optional(),
    speaking: Score.optional(),
    test_date: Iso8601Date,
    expires_on: Iso8601Date.optional(),
    certificate_no: z.string().max(80).optional(),
  })
  .strict();
export type CreateLanguageTestRequest = z.infer<typeof CreateLanguageTestRequest>;

export const UpdateLanguageTestRequest = CreateLanguageTestRequest.partial().strict();
export type UpdateLanguageTestRequest = z.infer<typeof UpdateLanguageTestRequest>;

export const LanguageTestListQuery = PaginationQuery.extend({
  test_type: LanguageTestEnum.optional(),
}).strict();
export type LanguageTestListQuery = z.infer<typeof LanguageTestListQuery>;
