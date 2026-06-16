import { z } from 'zod';
import { Iso8601DateTime, PaginationQuery } from './common.js';

// GDPR Chapter V — the safeguard relied on for an international transfer to a
// sub-processor: ADEQUACY (Art. 45 decision), SCC (Art. 46 standard clauses),
// BCR (Art. 47 binding corporate rules), DEROGATION (Art. 49), or NONE (the
// processor is in-jurisdiction, so no transfer mechanism is needed).
export const TransferMechanismEnum = z.enum(['ADEQUACY', 'SCC', 'BCR', 'DEROGATION', 'NONE']);
export type TransferMechanism = z.infer<typeof TransferMechanismEnum>;

export const CreateSubProcessorRequest = z
  .object({
    name: z.string().min(1).max(200),
    purpose: z.string().min(1).max(500),
    region: z.string().min(1).max(80),
    // SVT-SEC-P1-FE1-2026-05 — require http(s) scheme so XSS schemes never persist.
    contract_url: z
      .string()
      .url()
      .max(500)
      .refine((v) => /^https?:/i.test(v), 'Must be an http(s) URL')
      .optional(),
    // GDPR Art. 28 — proof the Data Processing Agreement is in place.
    dpa_signed_at: Iso8601DateTime.optional(),
    // GDPR Chapter V — international-transfer safeguard (see enum above).
    transfer_mechanism: TransferMechanismEnum.optional(),
  })
  .strict();
export type CreateSubProcessorRequest = z.infer<typeof CreateSubProcessorRequest>;

export const UpdateSubProcessorRequest = CreateSubProcessorRequest.partial()
  .extend({ removed_at: Iso8601DateTime.optional() })
  .strict();
export type UpdateSubProcessorRequest = z.infer<typeof UpdateSubProcessorRequest>;

// SVT-WAVE-PRIV-C2-2026-05 — `include_removed=true` opts into seeing the
// historical (soft-deleted) sub-processor rows. Coerce via .preprocess so
// HTTP querystring ("true"/"false") parses cleanly into a boolean. ADMIN-
// only at the route gate; the audit register relies on this for Art. 30(2).
export const SubProcessorListQuery = PaginationQuery.extend({
  include_removed: z
    .preprocess(
      (v) => (typeof v === 'string' ? v === 'true' || v === '1' : v),
      z.boolean(),
    )
    .optional(),
}).strict();
export type SubProcessorListQuery = z.infer<typeof SubProcessorListQuery>;
