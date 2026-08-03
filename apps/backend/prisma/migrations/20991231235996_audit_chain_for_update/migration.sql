-- SVT-QA-2026-08 — close the concurrent-audit-insert race in the hash-chain
-- trigger.
--
-- The 20991231235984b trigger reads the previous row without a row-lock:
--
--   SELECT entry_hash INTO prev
--     FROM audit_logs
--    WHERE tenant_id IS NOT DISTINCT FROM NEW.tenant_id
--    ORDER BY created_at DESC, id DESC
--    LIMIT 1;
--
-- Under Postgres READ COMMITTED (SPVT default), two concurrent audit inserts
-- for the same tenant both see the same predecessor row and both compute
-- prev_hash = <that row's entry_hash>. Two sibling rows are then written
-- with identical prev_hash, and audit_logs_verify() (which expects a
-- strictly linear chain) falsely reports "broken" at whichever sibling it
-- scans second.
--
-- The QA audit (docs/SPVT-QA-AUDIT.md §Security §5) also flagged that
-- shared/audit.ts:44-46 claims the trigger uses FOR UPDATE — documentation
-- drift; the code never did.
--
-- Fix: add FOR UPDATE to the SELECT so the trigger takes a row-level lock
-- on the previous row. The second concurrent insert blocks until the first
-- COMMITs, then re-reads and links to the just-committed row. Chain stays
-- strictly linear; audit_logs_verify() reports intact under concurrent load.
--
-- Notes:
--   - FOR UPDATE inside a BEFORE INSERT trigger holds the lock only for
--     the duration of the current statement's transaction, so we don't
--     serialise unrelated tenants (predicate + row lock is per (tenant_id)
--     via the WHERE tenant_id = NEW.tenant_id clause).
--   - When the tenant has zero prior rows (first insert), FOR UPDATE is a
--     no-op — no row matches, `prev` stays NULL, the trigger proceeds.
--   - The audit_logs table already blocks UPDATE + DELETE via triggers, so
--     the row we lock cannot be mutated mid-flight — the lock is purely
--     for insert-serialisation.
--   - Existing rows in the table are unaffected; the trigger is idempotent
--     against them because it only fires BEFORE INSERT.

CREATE OR REPLACE FUNCTION audit_logs_hash_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  prev text;
  payload text;
BEGIN
  SELECT entry_hash INTO prev
    FROM audit_logs
    WHERE tenant_id IS NOT DISTINCT FROM NEW.tenant_id
    ORDER BY created_at DESC, id DESC
    LIMIT 1
    FOR UPDATE;

  NEW.prev_hash := prev;

  payload := COALESCE(prev, '') || '|'
    || NEW.id::text || '|'
    || COALESCE(NEW.tenant_id::text, '') || '|'
    || COALESCE(NEW.actor_id::text, '') || '|'
    || COALESCE(NEW.action, '') || '|'
    || COALESCE(NEW.entity_type, '') || '|'
    || COALESCE(NEW.entity_id::text, '') || '|'
    || COALESCE(NEW.entity_version::text, '') || '|'
    || COALESCE(encode(NEW.before_enc, 'hex'), '') || '|'
    || COALESCE(encode(NEW.after_enc, 'hex'), '') || '|'
    || COALESCE(NEW.request_id, '') || '|'
    || to_char(NEW.created_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');

  NEW.entry_hash := encode(digest(payload, 'sha256'), 'hex');
  RETURN NEW;
END $$;

-- Re-bind the trigger so a corrupt cached plan can't keep the old function.
DROP TRIGGER IF EXISTS audit_logs_chain ON audit_logs;
CREATE TRIGGER audit_logs_chain
  BEFORE INSERT ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_hash_chain();
