-- SVT-WAVE-KMS-PROVIDER-2026-05 — audit chain timestamp locale fix.
--
-- Background
-- ----------
-- The original audit_logs_hash_chain trigger and the audit_logs_verify
-- function (see migration 20991231235959_init_rls_and_triggers) both folded
-- `NEW.created_at::text` and `rec.created_at::text` into the canonical
-- payload. `::text` on a TIMESTAMPTZ renders in the session's DateStyle GUC
-- — e.g. 'ISO, MDY' (default), 'SQL, DMY', 'German, DMY'. A psql client that
-- happened to set DateStyle differently when running verify would compute a
-- DIFFERENT canonical payload than the trigger did at insert time, and
-- audit_logs_verify would falsely report the chain broken.
--
-- The app-side writer (apps/backend/src/shared/audit.ts) already serialises
-- with `row.created_at.toISOString()` ('YYYY-MM-DDTHH:MM:SS.sssZ'), so this
-- migration converts both DB functions to the same shape using:
--
--   to_char(NEW.created_at AT TIME ZONE 'UTC',
--           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
--
-- The US specifier emits microseconds (6 digits); we widen from JavaScript's
-- millisecond ISO format to microseconds because Postgres stores microsecond
-- precision and silently truncating to ms would re-introduce the same
-- "two clients disagree on the canonical payload" failure mode.
--
-- Back-compatibility
-- ------------------
-- Existing rows were hashed with the old `::text` format. audit_logs_verify
-- now tries the NEW format first; on mismatch, falls back to the OLD format
-- before declaring the chain broken. This compat path runs until the next
-- audit_anchors anchor cycle re-roots the chain at a row written with the
-- new format, after which the fallback is dead code (kept as a defence in
-- depth — removing it is a separate, post-anchor-cycle migration).
--
-- App-side note: shared/audit.ts uses toISOString() (millisecond precision)
-- and joins with \\x1f (UNIT SEPARATOR). The TRIGGER computes its own
-- canonical payload and overwrites whatever the app wrote — the trigger is
-- the source of truth. The app-side computation is only consumed by the
-- offline replay verifier (audit-chain.ts), not by audit_logs_verify, so the
-- two need not be byte-identical.

-- ----------------------------------------------------------------------------
-- 1. Hash-chain trigger function (UTC-normalised timestamp)
-- ----------------------------------------------------------------------------
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
    LIMIT 1;

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

-- ----------------------------------------------------------------------------
-- 2. Verification helper — try NEW canonical payload first, fall back to OLD
-- ----------------------------------------------------------------------------
--
-- The OLD-format fallback recomputes with `rec.created_at::text` AT THE
-- SESSION DateStyle. Because verify may run from a session with any
-- DateStyle, we explicitly SET LOCAL DateStyle = 'ISO, MDY' (Postgres
-- default at install) so the fallback is deterministic and matches what the
-- original trigger produced under default-config Postgres clusters.
-- Operators who installed audit_logs on a non-default DateStyle cluster
-- should run the legacy verifier from psql with DateStyle = '<their setting>'.
CREATE OR REPLACE FUNCTION audit_logs_verify(p_tenant uuid) RETURNS TABLE (broken_id uuid)
LANGUAGE plpgsql AS $$
DECLARE
  prev text := NULL;
  rec RECORD;
  payload_new text;
  payload_old text;
  hash_new text;
  hash_old text;
  ts_old text;
BEGIN
  -- Fallback path needs a known DateStyle. SET LOCAL only affects this txn.
  SET LOCAL DateStyle = 'ISO, MDY';

  FOR rec IN
    SELECT * FROM audit_logs
      WHERE tenant_id IS NOT DISTINCT FROM p_tenant
      ORDER BY created_at, id
  LOOP
    -- New canonical payload — UTC-normalised ISO-8601 with microseconds.
    payload_new := COALESCE(prev, '') || '|'
      || rec.id::text || '|'
      || COALESCE(rec.tenant_id::text, '') || '|'
      || COALESCE(rec.actor_id::text, '') || '|'
      || COALESCE(rec.action, '') || '|'
      || COALESCE(rec.entity_type, '') || '|'
      || COALESCE(rec.entity_id::text, '') || '|'
      || COALESCE(rec.entity_version::text, '') || '|'
      || COALESCE(encode(rec.before_enc, 'hex'), '') || '|'
      || COALESCE(encode(rec.after_enc, 'hex'), '') || '|'
      || COALESCE(rec.request_id, '') || '|'
      || to_char(rec.created_at AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
    hash_new := encode(digest(payload_new, 'sha256'), 'hex');

    IF hash_new = rec.entry_hash AND COALESCE(rec.prev_hash, '') = COALESCE(prev, '') THEN
      prev := rec.entry_hash;
      CONTINUE;
    END IF;

    -- Fallback: legacy payload used `rec.created_at::text` at session DateStyle.
    ts_old := rec.created_at::text;
    payload_old := COALESCE(prev, '') || '|'
      || rec.id::text || '|'
      || COALESCE(rec.tenant_id::text, '') || '|'
      || COALESCE(rec.actor_id::text, '') || '|'
      || COALESCE(rec.action, '') || '|'
      || COALESCE(rec.entity_type, '') || '|'
      || COALESCE(rec.entity_id::text, '') || '|'
      || COALESCE(rec.entity_version::text, '') || '|'
      || COALESCE(encode(rec.before_enc, 'hex'), '') || '|'
      || COALESCE(encode(rec.after_enc, 'hex'), '') || '|'
      || COALESCE(rec.request_id, '') || '|'
      || ts_old;
    hash_old := encode(digest(payload_old, 'sha256'), 'hex');

    IF hash_old = rec.entry_hash AND COALESCE(rec.prev_hash, '') = COALESCE(prev, '') THEN
      prev := rec.entry_hash;
      CONTINUE;
    END IF;

    -- Neither format matched: chain is broken at this row.
    broken_id := rec.id;
    RETURN NEXT;
    RETURN;
  END LOOP;
  RETURN;
END $$;
