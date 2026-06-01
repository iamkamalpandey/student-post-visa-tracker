-- RENAMED 2026-05-19: directory was `20991231235982_perf_indexes_v2`
--   (prefix collided with audit_anchor_delta_watermark — filesystem-sort
--   dependent apply order). Operators with an existing dev DB MUST run:
--     UPDATE _prisma_migrations
--        SET migration_name = '20991231235982b_perf_indexes_v2'
--      WHERE migration_name = '20991231235982_perf_indexes_v2';
--   See infra/docs/runbooks/migration-rename-2026-05-19.md.
--
-- SVT-PERF-INDEXES-V2 — perf audit P0/P1 missing indexes (v1 beta-DB safe).
--
-- Adds five separate composite indexes the perf audit flagged as missing.
-- One P0 (audit_logs) and four P1 (finance_items, payments, refunds,
-- documents). Each is independent — none supersedes another and all five
-- back distinct query shapes:
--   (a) P0 #4  audit_logs(tenant_id, created_at DESC, id DESC)
--               — tenant audit list & hash-chain verify keyset pagination
--   (b) P1     finance_items(tenant_id, status, due_on)
--               — reminder scanner + finance dashboards
--   (c) P1     payments(tenant_id, status, received_on)
--               — 30d payment dashboard aggregates
--   (d) P1     refunds(tenant_id, status, refunded_on)
--               — 30d refund dashboard aggregates (symmetric with payments)
--   (e) P1 #5  documents(tenant_id, retention_until)
--               — retentionErasure scanner keyset pagination
--
-- LARGE-PROD OPERATIONAL NOTE:
--   These statements use CREATE INDEX (NOT CONCURRENTLY) because Prisma's
--   migration runner wraps each migration in a transaction, which is
--   incompatible with CONCURRENTLY. On the current beta deployment the
--   target tables are small enough that the short ACCESS EXCLUSIVE lock is
--   acceptable.
--
--   On a large prod DB (>~1M rows in any of these tables) the operator MUST
--   instead:
--     1. Run each `CREATE INDEX CONCURRENTLY IF NOT EXISTS ...` statement
--        manually against the live DB, OUTSIDE any transaction.
--     2. Mark this migration as applied with
--        `prisma migrate resolve --applied 20991231235982b_perf_indexes_v2`.
--   The `IF NOT EXISTS` guard below makes the in-transaction re-run a no-op
--   once the indexes already exist, so the resolve step is safe.

-- P0 #4 — AuditLog tenant timeline keyset pagination + hash-chain verify.
CREATE INDEX IF NOT EXISTS "audit_logs_tenant_id_created_at_id_idx"
  ON "audit_logs" ("tenant_id", "created_at" DESC, "id" DESC);

-- P1 #2 — FinanceItem reminder scan + per-tenant finance dashboards.
CREATE INDEX IF NOT EXISTS "finance_items_tenant_id_status_due_on_idx"
  ON "finance_items" ("tenant_id", "status", "due_on");

-- P1 #3 — Payment 30d aggregates (tenant + status + received_on window).
CREATE INDEX IF NOT EXISTS "payments_tenant_id_status_received_on_idx"
  ON "payments" ("tenant_id", "status", "received_on");

-- P1 #3 — Refund 30d aggregates (symmetric with payments).
CREATE INDEX IF NOT EXISTS "refunds_tenant_id_status_refunded_on_idx"
  ON "refunds" ("tenant_id", "status", "refunded_on");

-- P1 #5 — Document retentionErasure keyset pagination.
CREATE INDEX IF NOT EXISTS "documents_tenant_id_retention_until_idx"
  ON "documents" ("tenant_id", "retention_until");
