import { z } from 'zod';
import { Iso8601Date, Uuid } from './common.js';

// ============================================================================
// Document upload metadata
// ----------------------------------------------------------------------------
// The actual file is delivered via multipart/form-data; this schema validates
// only the JSON-ish metadata fields that accompany the file part. Strict mode
// is mandatory: we never accept unknown fields on a document upload because
// they could be used to silently extend storage_key, bypass AV, etc.
// ============================================================================
export const UploadDocumentMetadata = z
  .object({
    document_type_id: Uuid,
    issued_on: Iso8601Date.optional(),
    expires_on: Iso8601Date.optional(),
  })
  .strict();
export type UploadDocumentMetadata = z.infer<typeof UploadDocumentMetadata>;

// ============================================================================
// Verification decision (admin only)
// ----------------------------------------------------------------------------
// The DocumentVerification enum on the wire is restricted to terminal
// decisions. PENDING is the default state assigned at upload time; admins
// move documents into VERIFIED, REJECTED, or EXPIRED only.
// ============================================================================
export const VerifyDocumentRequest = z
  .object({
    verification: z.enum(['VERIFIED', 'REJECTED', 'EXPIRED']),
    notes: z.string().max(2000).optional(),
    // SVT-FSM-2026-05: ADMIN escape hatch. When `force_override: true` the
    // service permits a transition out of any state (including the terminal
    // VERIFIED / REJECTED / EXPIRED) provided `reason` (>= 10 chars) is
    // supplied. The override is audited as `document.verification_force_override`.
    force_override: z.literal(true).optional(),
    reason: z.string().min(10).max(2000).optional(),
  })
  .strict();
export type VerifyDocumentRequest = z.infer<typeof VerifyDocumentRequest>;
