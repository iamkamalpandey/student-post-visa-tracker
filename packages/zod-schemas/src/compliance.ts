import { z } from 'zod';
import { Iso8601Date, Iso8601DateTime, PaginationQuery, Uuid } from './common.js';

export const ComplianceTypeEnum = z.enum([
  'MEDICAL_EXAM',
  'BIOMETRICS',
  'POLICE_CLEARANCE',
  'TB_TEST',
  'IHS_PAID',
  'GTE_INTERVIEW',
  'OTHER',
]);
export type ComplianceType = z.infer<typeof ComplianceTypeEnum>;

export const CreateComplianceRequest = z
  .object({
    check_type: ComplianceTypeEnum,
    scheduled_at: Iso8601DateTime.optional(),
    completed_at: Iso8601DateTime.optional(),
    result: z.string().max(500).optional(),
    expires_on: Iso8601Date.optional(),
    document_id: Uuid.optional(),
    notes: z.string().max(2000).optional(),
  })
  .strict();
export type CreateComplianceRequest = z.infer<typeof CreateComplianceRequest>;

export const UpdateComplianceRequest = CreateComplianceRequest.partial().strict();
export type UpdateComplianceRequest = z.infer<typeof UpdateComplianceRequest>;

export const ComplianceListQuery = PaginationQuery.extend({
  check_type: ComplianceTypeEnum.optional(),
}).strict();
export type ComplianceListQuery = z.infer<typeof ComplianceListQuery>;
