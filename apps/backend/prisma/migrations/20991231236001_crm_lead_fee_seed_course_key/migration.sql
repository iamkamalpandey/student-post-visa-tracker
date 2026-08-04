-- SVT-QA-2026-08 (LEAD-H7) — seed fees dedup on course identity, not course NAME.
--
-- The V2 fee auto-seed composed `session_label = "<course.name> — Session 1"`
-- and relied on a partial unique index over (lead_id, session_label) to make
-- re-sync idempotent (createMany skipDuplicates).
--
-- That key is unstable: renaming a Course in V2 ("MBA" → "Master of Business
-- Administration") changes session_label, so the next daily sync no longer
-- matches the existing row, skipDuplicates does not skip, and a SECOND seeded
-- fee is created for the same lead+course. Both then surface as OVERDUE and
-- both drive reminder scaffolding — duplicate money rows created by an
-- unrelated cosmetic edit in the upstream system.
--
-- Fix: carry the V2 course id on seeded rows and dedup on (lead_id,
-- v2_course_id). That identity is stable across renames.
--
-- Backfill: existing seeded rows get their v2_course_id resolved through the
-- lead's visa-accepted lead-course. Rows we cannot resolve keep NULL and
-- remain covered by the legacy session_label index (kept for exactly that
-- reason), so no historical row is orphaned or duplicated by this migration.

ALTER TABLE crm_lead_fees
  ADD COLUMN IF NOT EXISTS v2_course_id INTEGER;

-- Backfill from the lead's visa-accepted lead-course when it is unambiguous
-- (exactly one visa-accepted course for that lead).
UPDATE crm_lead_fees f
SET v2_course_id = sub.v2_course_id
FROM (
  SELECT lc.lead_id, MIN(lc.v2_course_id) AS v2_course_id
  FROM crm_lead_courses lc
  WHERE lc.state_v2 = 'visa_accepted'
    AND lc.deleted_at IS NULL
  GROUP BY lc.lead_id
  HAVING COUNT(DISTINCT lc.v2_course_id) = 1
) AS sub
WHERE f.lead_id = sub.lead_id
  AND f.seeded_from_v2 = true
  AND f.v2_course_id IS NULL
  AND f.deleted_at IS NULL;

-- New stable dedup key. Partial so only seeded, live rows participate:
-- manually-added fees (seeded_from_v2 = false) are never deduped, and a
-- soft-deleted seed does not block a fresh one.
CREATE UNIQUE INDEX IF NOT EXISTS crm_lead_fees_seed_course_uq
  ON crm_lead_fees (lead_id, v2_course_id)
  WHERE seeded_from_v2 = true AND deleted_at IS NULL AND v2_course_id IS NOT NULL;
