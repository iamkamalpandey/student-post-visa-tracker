-- SVT-WAVE-AUDIT-FORENSIC-2026-06 — close the audit hash-chain forensic gap.
--
-- Background
-- ----------
-- The audit_logs_hash_chain() trigger (the authoritative source of truth that
-- OVERWRITES NEW.entry_hash on every insert — see 20991231235959 +
-- 20991231235984b) folded these fields into the canonical payload:
--
--   prev | id | tenant_id | actor_id | action | entity_type | entity_id |
--   entity_version | before_enc | after_enc | request_id | created_at
--
-- It OMITTED actor_email_hash, ip_hash and ua_hash. Those three are the
-- forensic "who / from-where / with-what" correlation tokens. Because they
-- were not part of entry_hash, a party with raw DML access to audit_logs
-- could rewrite the acting user's email-hash or the source IP/UA on any row
-- and audit_logs_verify() would STILL report the chain intact — the exact
-- tamper-evidence the chain exists to provide was absent for the most
-- investigation-relevant columns. (The app-side canonicalPayload() in
-- shared/audit.ts already listed these fields, but its hash is discarded by
-- the trigger, so it gave a false sense of coverage.)
--
-- Fix
-- ---
-- Add the three fields to the trigger's canonical payload. Changing the
-- payload changes every hash, so we VERSION the chain instead of re-hashing
-- history:
--   * New column hash_version (SMALLINT, DEFAULT 1). Existing rows backfill
--     to 1 (they were hashed under the old, forensic-omitting payload).
--   * The trigger now stamps NEW.hash_version := 2 and hashes the EXTENDED
--     payload (with actor_email_hash, ip_hash, ua_hash).
--   * audit_logs_verify() branches on each row's hash_version: v2 rows are
--     recomputed with the extended payload; v1 rows with the legacy payload
--     (UTC format first, then the pre-UTC ::text fallback from 984b).
--
-- The chain stays CONTINUOUS across the version boundary: prev_hash still
-- links a v2 row to its v1 predecessor, so NO re-anchor / re-root is needed —
-- verify simply applies the right payload per row. Once a tenant's chain is
-- entirely v2 (after enough new activity, or a future re-anchor cycle), the
-- v1 branch becomes dead code for that tenant.

-- ----------------------------------------------------------------------------
-- 1. Version column (idempotent). Postgres backfills the constant DEFAULT as a
--    metadata-only change, so this is instant even on large tables.
-- ----------------------------------------------------------------------------
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS hash_version SMALLINT NOT NULL DEFAULT 1;

-- ----------------------------------------------------------------------------
-- 2. Hash-chain trigger — extended payload (forensic fields), stamps v2.
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
  NEW.hash_version := 2;

  -- v2 canonical payload. Order is fixed and documented (shared/audit.ts
  -- mirrors the field set). The three forensic fields sit at their natural
  -- positions: actor_email_hash after actor_id; ip_hash/ua_hash after the
  -- snapshots, before request_id.
  payload := COALESCE(prev, '') || '|'
    || NEW.id::text || '|'
    || COALESCE(NEW.tenant_id::text, '') || '|'
    || COALESCE(NEW.actor_id::text, '') || '|'
    || COALESCE(NEW.actor_email_hash, '') || '|'
    || COALESCE(NEW.action, '') || '|'
    || COALESCE(NEW.entity_type, '') || '|'
    || COALESCE(NEW.entity_id::text, '') || '|'
    || COALESCE(NEW.entity_version::text, '') || '|'
    || COALESCE(encode(NEW.before_enc, 'hex'), '') || '|'
    || COALESCE(encode(NEW.after_enc, 'hex'), '') || '|'
    || COALESCE(NEW.ip_hash, '') || '|'
    || COALESCE(NEW.ua_hash, '') || '|'
    || COALESCE(NEW.request_id, '') || '|'
    || to_char(NEW.created_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');

  NEW.entry_hash := encode(digest(payload, 'sha256'), 'hex');
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS audit_logs_chain ON audit_logs;
CREATE TRIGGER audit_logs_chain
  BEFORE INSERT ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_hash_chain();

-- ----------------------------------------------------------------------------
-- 3. Verification — branch on hash_version.
--    v2: extended payload (forensic fields).
--    v1: legacy payload — UTC format first, then the pre-UTC ::text fallback
--        (preserves 20991231235984b back-compat for the oldest rows).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION audit_logs_verify(p_tenant uuid) RETURNS TABLE (broken_id uuid)
LANGUAGE plpgsql AS $$
DECLARE
  prev text := NULL;
  rec RECORD;
  payload text;
  hash_calc text;
  ts_old text;
BEGIN
  -- Deterministic DateStyle for the legacy ::text fallback path.
  SET LOCAL DateStyle = 'ISO, MDY';

  FOR rec IN
    SELECT * FROM audit_logs
      WHERE tenant_id IS NOT DISTINCT FROM p_tenant
      ORDER BY created_at, id
  LOOP
    IF rec.hash_version >= 2 THEN
      -- v2 extended payload — must mirror audit_logs_hash_chain() above.
      payload := COALESCE(prev, '') || '|'
        || rec.id::text || '|'
        || COALESCE(rec.tenant_id::text, '') || '|'
        || COALESCE(rec.actor_id::text, '') || '|'
        || COALESCE(rec.actor_email_hash, '') || '|'
        || COALESCE(rec.action, '') || '|'
        || COALESCE(rec.entity_type, '') || '|'
        || COALESCE(rec.entity_id::text, '') || '|'
        || COALESCE(rec.entity_version::text, '') || '|'
        || COALESCE(encode(rec.before_enc, 'hex'), '') || '|'
        || COALESCE(encode(rec.after_enc, 'hex'), '') || '|'
        || COALESCE(rec.ip_hash, '') || '|'
        || COALESCE(rec.ua_hash, '') || '|'
        || COALESCE(rec.request_id, '') || '|'
        || to_char(rec.created_at AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
      hash_calc := encode(digest(payload, 'sha256'), 'hex');

      IF hash_calc = rec.entry_hash AND COALESCE(rec.prev_hash, '') = COALESCE(prev, '') THEN
        prev := rec.entry_hash;
        CONTINUE;
      END IF;

      broken_id := rec.id;
      RETURN NEXT;
      RETURN;
    END IF;

    -- v1 legacy payload (forensic fields NOT included) — UTC format first.
    payload := COALESCE(prev, '') || '|'
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
    hash_calc := encode(digest(payload, 'sha256'), 'hex');

    IF hash_calc = rec.entry_hash AND COALESCE(rec.prev_hash, '') = COALESCE(prev, '') THEN
      prev := rec.entry_hash;
      CONTINUE;
    END IF;

    -- Oldest rows: pre-UTC payload used rec.created_at::text at session DateStyle.
    ts_old := rec.created_at::text;
    payload := COALESCE(prev, '') || '|'
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
    hash_calc := encode(digest(payload, 'sha256'), 'hex');

    IF hash_calc = rec.entry_hash AND COALESCE(rec.prev_hash, '') = COALESCE(prev, '') THEN
      prev := rec.entry_hash;
      CONTINUE;
    END IF;

    broken_id := rec.id;
    RETURN NEXT;
    RETURN;
  END LOOP;
  RETURN;
END $$;
