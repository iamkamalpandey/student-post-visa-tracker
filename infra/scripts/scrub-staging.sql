-- Scrub a logical copy of the production database before promoting it to staging.
-- Run inside a fresh staging branch only. NEVER run against production.

BEGIN;

-- 1. Replace contact PII on students with deterministic per-id placeholders.
UPDATE students
SET email_primary = 'staging+' || id || '@example.invalid',
    email_secondary = NULL,
    phone_primary_e164 = '+10000' || lpad((abs(hashtext(id::text)) % 1000000)::text, 6, '0'),
    phone_secondary_e164 = NULL,
    notes = NULL;

-- 2. Replace user PII (preserve role + tenant so login flows still work for QA).
UPDATE users
SET email = 'staging+u' || id || '@example.invalid',
    given_name = 'Staging',
    family_name = 'User-' || left(id::text, 8),
    display_name = NULL,
    last_login_at = NULL,
    failed_login_count = 0,
    locked_until = NULL,
    mfa_secret_enc = NULL,
    mfa_enabled = false;

-- 3. Drop encrypted columns — they were wrapped under the prod KEK and would not decrypt
--    under the staging KEK. The rewrap script will re-encrypt placeholders next.
UPDATE students SET name_in_passport_enc = decode('00', 'hex');
UPDATE student_identifications SET document_number_enc = decode('00', 'hex');
UPDATE student_visas SET visa_number_enc = decode('00', 'hex');
UPDATE student_regulator_identifiers SET value_enc = decode('00', 'hex');
UPDATE student_dependents SET passport_number_enc = NULL;
UPDATE student_contacts SET annual_income_minor_enc = NULL;
UPDATE insurance_records SET policy_number_enc = decode('00', 'hex');

-- 4. Wipe operational artifacts that should not survive into staging.
TRUNCATE access_token_denylist;
TRUNCATE refresh_tokens;
TRUNCATE audit_logs;
TRUNCATE student_lifecycle_events RESTART IDENTITY;
TRUNCATE consent_records, dsar_requests, breach_incidents;
TRUNCATE comms_messages, comms_threads;
TRUNCATE export_jobs, import_jobs, import_mapping_templates;

-- 5. Clear document blobs (object storage prefix is wiped separately by the script).
DELETE FROM documents;

COMMIT;
