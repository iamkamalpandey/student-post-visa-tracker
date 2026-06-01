import { z } from 'zod';
import { CurrencyCode, Iso8601Date, PaginationQuery } from './common.js';

export const CreateInsuranceRequest = z
  .object({
    provider: z.string().min(1).max(200),
    policy_number: z.string().min(1).max(120),
    coverage_type: z.string().min(1).max(120),
    starts_on: Iso8601Date,
    ends_on: Iso8601Date,
    premium_minor: z.union([z.number().int().nonnegative(), z.string().regex(/^\d+$/)]).optional(),
    premium_currency: CurrencyCode.optional(),
  })
  .strict();
export type CreateInsuranceRequest = z.infer<typeof CreateInsuranceRequest>;

export const UpdateInsuranceRequest = CreateInsuranceRequest.partial().strict();
export type UpdateInsuranceRequest = z.infer<typeof UpdateInsuranceRequest>;

export const InsuranceListQuery = PaginationQuery.strict();
export type InsuranceListQuery = z.infer<typeof InsuranceListQuery>;
