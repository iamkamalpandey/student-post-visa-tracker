-- ============================================================================
-- Wave 8 — email outbox + per-user opt-out.
--
-- Adds:
--   * users.notifications_email_enabled (bool, default true) — opt-out flag the
--     reminder dispatcher checks before fanning out an EMAIL alongside IN_APP.
--   * comms_messages.attempts (int, default 0) — retry counter
--   * comms_messages.last_attempt_at (timestamptz)
--   * comms_messages.next_retry_at (timestamptz) — backoff gate
--   * comms_messages (status, next_retry_at) index for the new comms.dispatcher
--     job to scan QUEUED + retryable FAILED rows efficiently.
-- ============================================================================

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS notifications_email_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE comms_messages
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_retry_at timestamptz;

CREATE INDEX IF NOT EXISTS comms_messages_status_next_retry_idx
  ON comms_messages (status, next_retry_at);
