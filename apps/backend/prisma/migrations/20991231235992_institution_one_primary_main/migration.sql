-- SVT-DQ-2026-06 — enforce at most one primary contact / one main campus per
-- institution. The service now auto-demotes the prior primary/main; this is the
-- concurrent-race safety net. Existing data may already hold duplicates (the bug
-- being fixed), so demote all-but-the-earliest before creating the unique index,
-- or the CREATE would fail. Idempotent.

-- Keep the earliest (lowest id) primary contact per institution; demote the rest.
UPDATE "institution_contacts" SET "is_primary" = false
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", row_number() OVER (PARTITION BY "institution_id" ORDER BY "id") AS rn
    FROM "institution_contacts" WHERE "is_primary" = true
  ) t WHERE t.rn > 1
);

-- Keep the earliest main campus per institution; demote the rest.
UPDATE "campuses" SET "is_main" = false
WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", row_number() OVER (PARTITION BY "institution_id" ORDER BY "id") AS rn
    FROM "campuses" WHERE "is_main" = true
  ) t WHERE t.rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS "institution_contacts_one_primary_per_inst"
  ON "institution_contacts" ("institution_id") WHERE "is_primary" = true;

CREATE UNIQUE INDEX IF NOT EXISTS "campuses_one_main_per_inst"
  ON "campuses" ("institution_id") WHERE "is_main" = true;
