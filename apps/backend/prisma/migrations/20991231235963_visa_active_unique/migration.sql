-- ============================================================================
-- SVT-FSM-2026-05: Partial unique index enforcing "at most one active visa
-- per student". Prisma's @@unique cannot express partial predicates so we own
-- the SQL.
--
-- Idempotent: IF NOT EXISTS keeps the migration re-runnable in dev DBs that
-- may already carry the index. The student_visas table has no `deleted_at`
-- column today (rows are hard-deleted via DELETE) so the predicate is the
-- single boolean is_active = true.
--
-- Pair with the service-side guard in modules/visas/service.ts which
-- transactionally deactivates sibling visas before flipping a new one to
-- active — the unique index is a backstop against races.
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_student_visas_active_unique
  ON student_visas (student_id) WHERE is_active = true;
