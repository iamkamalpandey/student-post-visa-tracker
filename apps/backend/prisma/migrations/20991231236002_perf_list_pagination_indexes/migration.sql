-- SVT-PERF-2026-08 — covering indexes for the highest-traffic list pages.
--
-- Every list endpoint in this app paginates with the same keyset shape:
--
--     WHERE tenant_id = $1 AND deleted_at IS NULL
--     ORDER BY created_at DESC, id DESC
--     LIMIT $2
--
-- `audit_logs` already has the matching index
-- (tenant_id, created_at DESC, id DESC) and is the precedent this migration
-- follows. The three tables below did not, so Postgres had to read every live
-- row for the tenant and sort it on EVERY page request — including page 1,
-- which is the request almost every session starts with. On the CRM lead table
-- that is a full sort of 10,000+ rows to return 25.
--
-- These are PARTIAL indexes (WHERE deleted_at IS NULL). Soft-deleted rows are
-- never listed, so excluding them keeps the index smaller than the table and
-- lets it stay hot in cache. The column order matches the query exactly:
-- equality column first, then the ORDER BY columns in their sort direction, so
-- the planner can satisfy both the filter and the ordering from one index scan
-- with no sort node at all.
--
-- CREATE INDEX (not CONCURRENTLY) because Prisma runs each migration inside a
-- transaction and CONCURRENTLY is not transaction-safe. These tables are small
-- enough that the brief ACCESS EXCLUSIVE lock is a non-event; for a very large
-- deployment, build them CONCURRENTLY out-of-band first and this migration
-- becomes a no-op thanks to IF NOT EXISTS.

-- 1) CRM leads list — the busiest screen in the product (the post-visa work
--    queue). Filters: tenant + not-deleted. Order: created_at DESC, id DESC.
CREATE INDEX IF NOT EXISTS crm_leads_tenant_created_id_live_idx
  ON crm_leads (tenant_id, created_at DESC, id DESC)
  WHERE deleted_at IS NULL;

-- NOTE: `students` deliberately gets NOTHING here. It already has an identical
-- index (students_tenant_created_at_active_idx, added in
-- 20991231235960_perf_indexes). A second index over the same columns would be
-- pure overhead — extra writes on every insert/update and more buffer cache
-- consumed — with zero read benefit. Verified before writing this migration.

-- 2) Per-student document list — `WHERE tenant_id, student_id, deleted_at IS
--    NULL ORDER BY id DESC`. The existing (student_id, document_type_id) index
--    does not serve the ordering, so this was also a sort-per-request. Every
--    student detail page hits it.
CREATE INDEX IF NOT EXISTS documents_tenant_student_id_live_idx
  ON documents (tenant_id, student_id, id DESC)
  WHERE deleted_at IS NULL;

-- 3) CRM lead fees are read as a nested relation on the leads list (open fees
--    per lead, ordered by due date). The existing (tenant_id, lead_id) index
--    stops short of the status filter and the ordering, so each of the 25 rows
--    on a page triggered its own sort. Adding due_on makes the nested read an
--    index-only range scan.
CREATE INDEX IF NOT EXISTS crm_lead_fees_tenant_lead_due_live_idx
  ON crm_lead_fees (tenant_id, lead_id, due_on)
  WHERE deleted_at IS NULL;
