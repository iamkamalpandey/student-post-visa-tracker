-- ============================================================================
-- BreachIncident: GDPR Art. 33 / UK DPA / India DPDP §8 require notification
-- to the supervisory authority within 72 hours of becoming aware of a breach.
-- Without a tracked `due_by` clock, ops + legal teams have no visible signal
-- when a row is approaching or past the deadline.
--
-- Adds:
--   * due_by Timestamptz NOT NULL  (= detected_at + 72h for new + existing rows)
--   * partial index on (due_by) restricted to open incidents (closed_at IS NULL)
--     so the overdue dashboard query is index-only and tiny.
--
-- Backfill: existing rows get due_by = detected_at + 72h applied in-line.
-- ============================================================================

-- Add column as nullable so existing rows don't violate NOT NULL during backfill.
ALTER TABLE breach_incidents
  ADD COLUMN IF NOT EXISTS due_by timestamptz;

-- Backfill: every existing row inherits a 72h SLA from its detected_at.
UPDATE breach_incidents
   SET due_by = detected_at + INTERVAL '72 hours'
 WHERE due_by IS NULL;

-- Tighten to NOT NULL now that no rows are NULL.
ALTER TABLE breach_incidents
  ALTER COLUMN due_by SET NOT NULL;

-- Index for overdue queries: WHERE closed_at IS NULL AND due_by < now().
-- Partial covers only open incidents — the only ones the SLA matters for.
CREATE INDEX IF NOT EXISTS breach_incidents_due_by_open_idx
  ON breach_incidents (due_by)
  WHERE closed_at IS NULL;
