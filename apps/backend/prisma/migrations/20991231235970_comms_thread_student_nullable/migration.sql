-- ============================================================================
-- comms_threads.student_id: NOT NULL → NULL
--
-- System-wide IN_APP notification fan-out (super-agent FSM transitions,
-- commission claim status flips, enrollment status transitions) needs a per-
-- tenant synthetic thread that isn't tied to a specific student. The original
-- schema required student_id, forcing a fake-student workaround.
--
-- We also relax the FK to ON DELETE CASCADE on the relation side (Prisma's
-- @relation already cascades) — the column-nullable change is what unlocks the
-- system-thread pattern.
--
-- Adds (tenant_id, channel) composite index for the system-thread lookup path.
-- ============================================================================

-- 1. Make column nullable.
ALTER TABLE comms_threads
  ALTER COLUMN student_id DROP NOT NULL;

-- 2. Supporting index for the per-tenant synthetic-thread lookup pattern.
CREATE INDEX IF NOT EXISTS comms_threads_tenant_id_channel_idx
  ON comms_threads (tenant_id, channel);
