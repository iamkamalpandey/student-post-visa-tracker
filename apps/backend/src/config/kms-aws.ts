// SVT-WAVE-KMS-PROVIDER-2026-05 — P0-K1 AWS KMS provider (extracted module).
//
// Re-exports AwsKmsKms from kms.ts under its own module path so the import
// surface matches the documented layout in deep-audit-findings.md
// (apps/backend/src/config/kms-aws.ts). The implementation lives in kms.ts
// alongside the Kms interface; keeping it there avoids a circular import while
// still letting external code use the by-provider filename. The lazy SDK load
// pattern (defer-install) is preserved — see AwsKmsKms.client() in kms.ts.

export { AwsKmsKms } from './kms.js';
export type { Kms } from './kms.js';
