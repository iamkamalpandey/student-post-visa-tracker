-- SVT-WAVE-KMS-PROVIDER-2026-05 — KEK re-wrap progress table.
--
-- Used by infra/scripts/rewrap-secrets.ts to record which (table, column,
-- row_id) tuples have already been re-wrapped under the new KEK. The script
-- consults this table on every batch so a crash mid-rotation can be
-- recovered from by simply re-running (idempotent).
--
-- Notes:
--   - row_id is TEXT to stay schema-agnostic; current callers always cast a
--     UUID PK to text. Adding numeric/composite PKs later would still fit.
--   - old_kek_id / new_kek_id are nullable so dry-runs / one-off rewraps
--     without a formal rotation event don't have to invent ids.
--   - Append-only by convention (the script never deletes); we don't enforce
--     immutability at the DB layer because operators may want to TRUNCATE
--     between unrelated rotation events.

CREATE TABLE IF NOT EXISTS "kek_rotation_progress" (
  "table_name"    TEXT NOT NULL,
  "column_name"   TEXT NOT NULL,
  "row_id"        TEXT NOT NULL,
  "old_kek_id"    TEXT,
  "new_kek_id"    TEXT,
  "rewrapped_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY ("table_name", "column_name", "row_id")
);

-- Helper index for "how many rows still left in this column" progress
-- queries the operator typically issues mid-rotation.
CREATE INDEX IF NOT EXISTS "kek_rotation_progress_col_idx"
  ON "kek_rotation_progress" ("table_name", "column_name");

GRANT SELECT, INSERT ON "kek_rotation_progress" TO spv_app;
