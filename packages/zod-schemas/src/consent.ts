import { z } from 'zod';
import { PaginationQuery, Uuid } from './common.js';

export const LawfulBasisEnum = z.enum([
  'CONSENT',
  'CONTRACT',
  'LEGAL_OBLIGATION',
  'VITAL_INTEREST',
  'PUBLIC_TASK',
  'LEGITIMATE_INTEREST',
]);
export type LawfulBasis = z.infer<typeof LawfulBasisEnum>;

export const CreateConsentRequest = z
  .object({
    subject_type: z.string().min(1).max(80),
    subject_id: Uuid,
    purpose: z.string().min(1).max(200),
    lawful_basis: LawfulBasisEnum,
    granted: z.boolean(),
    // GDPR Art. 6(1)(f) — relying on legitimate interests requires a documented
    // legitimate-interests assessment (the balancing test). Required by the
    // superRefine below whenever that basis is used.
    justification: z.string().min(1).max(4000).optional(),
    evidence: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.lawful_basis === 'LEGITIMATE_INTEREST' && !v.justification?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['justification'],
        message:
          'justification (legitimate-interests balancing test) is required when lawful_basis is LEGITIMATE_INTEREST',
      });
    }
  });
export type CreateConsentRequest = z.infer<typeof CreateConsentRequest>;

export const ConsentListQuery = PaginationQuery.extend({
  subject_type: z.string().min(1).max(80).optional(),
  subject_id: Uuid.optional(),
}).strict();
export type ConsentListQuery = z.infer<typeof ConsentListQuery>;
