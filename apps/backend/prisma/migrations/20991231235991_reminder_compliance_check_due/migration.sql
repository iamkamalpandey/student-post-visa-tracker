-- SVT-COMPLIANCE-REMINDERS-2026-06 — new ReminderType for compliance-check
-- deadlines (biometrics / police registration / BRP / CAS / medical). The
-- reminder scanner now chases ComplianceCheck.scheduled_at for checks not yet
-- completed. ADD VALUE IF NOT EXISTS is idempotent (Postgres 12+).

ALTER TYPE "ReminderType" ADD VALUE IF NOT EXISTS 'COMPLIANCE_CHECK_DUE';
