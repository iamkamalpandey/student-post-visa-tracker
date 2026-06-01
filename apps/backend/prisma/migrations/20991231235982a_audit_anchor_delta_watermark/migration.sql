-- RENAMED 2026-05-19: directory was `20991231235982_audit_anchor_delta_watermark`
--   (prefix collided with perf_indexes_v2 — filesystem-sort dependent
--   apply order). Operators with an existing dev DB MUST run:
--     UPDATE _prisma_migrations
--        SET migration_name = '20991231235982a_audit_anchor_delta_watermark'
--      WHERE migration_name = '20991231235982_audit_anchor_delta_watermark';
--   See infra/docs/runbooks/migration-rename-2026-05-19.md.
--
-- SVT-PERF-AUDIT-ANCHOR-DELTA-2026-05 — Incremental hash anchor.
--
-- The original computeTenantRoots() read the ENTIRE per-tenant audit chain on
-- every nightly run (tens of MB into Node). We now fold only the delta on top
-- of the previous anchor's root_hash, but to do that safely we need a
-- watermark on each anchor that names the last audit_logs row it covered.
--
-- (created_at, id) is the same ordering computeTenantRoots already uses to
-- compute the root, so a tuple watermark survives concurrent inserts at the
-- same timestamp.
--
-- audit_anchors is append-only at the DB layer (immutable trigger from
-- 20991231235979_audit_anchors). Adding columns via ALTER TABLE is a DDL op
-- and bypasses the row trigger — safe.

ALTER TABLE "audit_anchors"
  ADD COLUMN IF NOT EXISTS "last_entry_id"         UUID,
  ADD COLUMN IF NOT EXISTS "last_entry_created_at" TIMESTAMPTZ;

-- Backfill the watermark for any existing anchor row so the next delta run
-- doesn't accidentally re-hash the whole chain. We pick the latest audit_logs
-- row whose created_at <= anchored_at within the same tenant scope.
-- Uses a correlated subquery (LATERAL would require a JOIN; this is simpler
-- and equivalent for a one-shot backfill).
UPDATE "audit_anchors" a
   SET "last_entry_id" = (
         SELECT al.id
           FROM "audit_logs" al
          WHERE ((a.tenant_id IS NULL AND al.tenant_id IS NULL)
              OR (a.tenant_id IS NOT NULL AND al.tenant_id = a.tenant_id))
            AND al.created_at <= a.anchored_at
          ORDER BY al.created_at DESC, al.id DESC
          LIMIT 1
       ),
       "last_entry_created_at" = (
         SELECT al.created_at
           FROM "audit_logs" al
          WHERE ((a.tenant_id IS NULL AND al.tenant_id IS NULL)
              OR (a.tenant_id IS NOT NULL AND al.tenant_id = a.tenant_id))
            AND al.created_at <= a.anchored_at
          ORDER BY al.created_at DESC, al.id DESC
          LIMIT 1
       )
 WHERE a."last_entry_id" IS NULL;
