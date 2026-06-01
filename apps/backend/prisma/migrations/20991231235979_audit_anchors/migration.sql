-- SVT-AUDIT-WORM-2026-05 — Persist daily Merkle roots so the audit chain
-- can be verified across log rotations + replicated to external WORM storage.

CREATE TABLE IF NOT EXISTS "audit_anchors" (
  "id"            UUID        NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"     UUID,
  "root_hash"     CHAR(64)    NOT NULL,
  "entries_count" INTEGER     NOT NULL,
  "anchored_at"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "audit_anchors_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "audit_anchors_tenant_fk"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL,
  CONSTRAINT "audit_anchors_entries_nonneg" CHECK ("entries_count" >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS "audit_anchors_tenant_time_uniq"
  ON "audit_anchors" ("tenant_id", "anchored_at");
CREATE INDEX IF NOT EXISTS "audit_anchors_anchored_at_idx"
  ON "audit_anchors" ("anchored_at" DESC);

-- Append-only at the DB layer: anchors are evidence and must NEVER be
-- mutated or removed once written.
CREATE OR REPLACE FUNCTION audit_anchors_immutable() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_anchors is append-only'; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_anchors_no_update ON "audit_anchors";
CREATE TRIGGER audit_anchors_no_update
  BEFORE UPDATE OR DELETE ON "audit_anchors"
  FOR EACH ROW EXECUTE FUNCTION audit_anchors_immutable();

ALTER TABLE "audit_anchors" ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'audit_anchors'
      AND policyname = 'audit_anchors_tenant_read'
  ) THEN
    CREATE POLICY "audit_anchors_tenant_read" ON "audit_anchors" FOR SELECT
      USING (tenant_id IS NULL OR tenant_id = current_setting('app.tenant_id', true)::uuid);
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'spv_app') THEN
    EXECUTE 'GRANT SELECT, INSERT ON audit_anchors TO spv_app';
  END IF;
END $$;
