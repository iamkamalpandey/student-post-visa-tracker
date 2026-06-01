-- ============================================================================
-- Wave 14 — per-user EMAIL delivery cadence.
--
-- PER_EVENT — send every transition/reminder immediately (default; matches
--             existing behavior pre-Wave 14)
-- DAILY     — collapse a day's queued EMAILs into a single summary; the
--             daily digest job picks PER user = 'DAILY' rows, builds one
--             summary EMAIL per user, marks the originals SENT (digested).
-- OFF       — backstop alongside notifications_email_enabled=false.
-- ============================================================================

CREATE TYPE "NotificationDigest" AS ENUM ('PER_EVENT', 'DAILY', 'OFF');

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS notifications_digest "NotificationDigest" NOT NULL DEFAULT 'PER_EVENT';
