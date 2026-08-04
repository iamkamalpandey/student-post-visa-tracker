import { z } from 'zod';
import { CurrencyCode, Iso8601Date, PaginationQuery, Uuid } from './common.js';

export const FinanceCategoryEnum = z.enum([
  'TUITION',
  'ACCOMMODATION',
  'TRAVEL',
  'INSURANCE',
  'LIVING_COST',
  'CONSULTANCY',
  'COMMISSION',
  'OTHER',
]);
export type FinanceCategory = z.infer<typeof FinanceCategoryEnum>;

export const FinanceStatusEnum = z.enum(['PENDING', 'PAID', 'OVERDUE', 'WAIVED', 'REFUNDED']);
export type FinanceStatus = z.infer<typeof FinanceStatusEnum>;

const Money = z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]);

export const CreateFinanceRequest = z
  .object({
    enrollment_id: Uuid.optional(),
    sponsor_id: Uuid.optional(),
    category: FinanceCategoryEnum,
    description: z.string().min(1).max(500),
    amount_minor: Money,
    currency: CurrencyCode,
    exchange_rate_to_base: z.union([z.number().positive(), z.string()]).optional(),
    invoice_no: z.string().max(80).optional(),
    due_on: Iso8601Date.optional(),
    paid_on: Iso8601Date.optional(),
    // SVT-QA-2026-08 (LEAD-H5) — how much was ACTUALLY collected, when that
    // differs from `amount_minor`. A PAID item with a lower paid_amount_minor
    // is a partial settlement; leaving it implicit is how the lead→student
    // convert used to lose the shortfall.
    paid_amount_minor: Money.optional(),
    status: FinanceStatusEnum.default('PENDING'),
    reference: z.string().max(120).optional(),
  })
  .strict();
export type CreateFinanceRequest = z.infer<typeof CreateFinanceRequest>;

export const UpdateFinanceRequest = CreateFinanceRequest.partial().strict();
export type UpdateFinanceRequest = z.infer<typeof UpdateFinanceRequest>;

export const FinanceListQuery = PaginationQuery.extend({
  status: FinanceStatusEnum.optional(),
  category: FinanceCategoryEnum.optional(),
}).strict();
export type FinanceListQuery = z.infer<typeof FinanceListQuery>;
