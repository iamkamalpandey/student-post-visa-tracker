# Runbook — Onboard a new tenant (founder-only)

Audience: founders / DBA / platform ops with database access.

Background: there is intentionally **no public `POST /tenants`** endpoint. The
tenants router (`apps/backend/src/modules/tenants/routes.ts`) only exposes
`GET /me` and `PATCH /me` for the **already-signed-in admin** of an existing
tenant. New tenants must be provisioned out-of-band. This is by design — a
self-serve "create my SaaS tenant" surface would expand the attack surface
(spam tenants, automated abuse) without serving any of our channels (we sell
to consultancies and schools, not impulse sign-ups).

This runbook documents the only two supported provisioning paths.

---

## Option A (recommended) — the onboarding script

A single transactional, idempotent script wraps everything: tenant row,
lifecycle stages, admin user. Fails fast on a `legal_name` collision.

```bash
# from the repo root
pnpm --filter backend tsx scripts/onboard-tenant.ts \
  --name           "Acme Education" \
  --legal-name     "Acme Education Ltd." \
  --admin-email    founder@acme.com \
  --admin-password "$(cat /tmp/admin-pass)" \
  --admin-given-name  "Founder" \
  --admin-family-name "User" \
  --locale   en \
  --timezone Europe/London \
  --currency GBP \
  --region   eu-west-1
```

Notes:

- **Never paste the password as a literal arg in a shared shell** — it ends up
  in shell history. Read from a file (`$(cat …)`) or stdin / CI secret.
- `--legal-name` defaults to `--name` when omitted, but you should set it to
  the registered legal entity (used by GDPR Art. 30 / RoPA exports).
- `--locale` / `--timezone` / `--currency` / `--region` default to
  `en` / `UTC` / `USD` / `eu-west-1`.
- The script aborts with exit 2 if any tenant already exists with the same
  `legal_name`. This is the deliberate fail-fast — duplicate legal entities
  almost always indicate operator error.
- Argon2id hashing happens via `apps/backend/src/shared/passwords.ts` (same
  parameters as the seed script: 64MB / t=3 / p=1).

---

## Option B — direct SQL

Use only if the Node toolchain is unavailable on the bastion. Three statements
in one transaction. Generate the Argon2id hash separately (see below).

### Step 1: hash the admin password

The Postgres server has no Argon2 implementation. Generate the hash from any
host with the backend dependencies installed:

```bash
pnpm --filter backend tsx -e "
  import { hashPassword } from './src/shared/passwords.ts';
  hashPassword(process.argv[1]).then(h => { console.log(h); process.exit(0); });
" "$(cat /tmp/admin-pass)"
# → $argon2id$v=19$m=65536,t=3,p=1$<salt>$<hash>
```

Paste the resulting `$argon2id$…` string into the SQL below.

### Step 2: insert tenant + admin + stages

```sql
-- psql: connect with the migration role (has BYPASSRLS).
-- All-or-nothing transaction. Aborts on legal_name collision.
BEGIN;

WITH new_tenant AS (
  INSERT INTO tenants (
    id, name, legal_name,
    default_locale, default_timezone, default_currency,
    data_residency_region,
    is_active, created_at, updated_at
  )
  SELECT
    gen_random_uuid(),
    'Acme Education',
    'Acme Education Ltd.',
    'en', 'Europe/London', 'GBP',
    'eu-west-1',
    true, now(), now()
  WHERE NOT EXISTS (
    SELECT 1 FROM tenants WHERE legal_name = 'Acme Education Ltd.'
  )
  RETURNING id
)
SELECT id AS tenant_id FROM new_tenant \gset

-- Bail loudly if the tenant already existed.
DO $$
BEGIN
  IF :'tenant_id' IS NULL OR :'tenant_id' = '' THEN
    RAISE EXCEPTION 'Tenant with legal_name "Acme Education Ltd." already exists. Aborting.';
  END IF;
END$$;

-- The next two inserts touch RLS-protected tables. Bind the per-request GUC
-- so the lifecycle_stages / users policies match the tenant we're inserting
-- into (mirrors the runtime tenantContext middleware).
SELECT set_config('app.tenant_id', :'tenant_id', true);

-- Admin user (paste the Argon2id hash from Step 1).
INSERT INTO users (
  id, tenant_id, email, password_hash,
  given_name, family_name, role, is_active,
  password_changed_at, created_at, updated_at
) VALUES (
  gen_random_uuid(),
  :'tenant_id',
  'founder@acme.com',
  '$argon2id$v=19$m=65536,t=3,p=1$REPLACE_ME_SALT$REPLACE_ME_HASH',
  'Founder', 'User', 'ADMIN', true,
  now(), now(), now()
);

-- 8 default lifecycle stages (key/label/sequence/category/is_initial/is_terminal
-- mirror apps/backend/prisma/data/default-stages.json — keep in sync if the
-- seed file changes).
INSERT INTO lifecycle_stages (
  id, tenant_id, key, label, sequence, category,
  is_initial, is_terminal, color_hex, icon, sla_hours,
  created_at, updated_at
) VALUES
  (gen_random_uuid(), :'tenant_id', 'visa_approved',           'Visa Approved',           1, 'PRE_DEPARTURE', true,  false, '#1976d2', 'VerifiedUser', NULL, now(), now()),
  (gen_random_uuid(), :'tenant_id', 'pre_departure_briefing',  'Pre-departure Briefing',  2, 'PRE_DEPARTURE', false, false, '#0288d1', 'Campaign',     168,  now(), now()),
  (gen_random_uuid(), :'tenant_id', 'ticket_booked',           'Ticket Booked',           3, 'PRE_DEPARTURE', false, false, '#00897b', 'FlightTakeoff',240,  now(), now()),
  (gen_random_uuid(), :'tenant_id', 'departed',                'Departed',                4, 'IN_TRANSIT',    false, false, '#fbc02d', 'Flight',       NULL, now(), now()),
  (gen_random_uuid(), :'tenant_id', 'arrived',                 'Arrived',                 5, 'POST_ARRIVAL',  false, false, '#f57c00', 'FlightLand',   24,   now(), now()),
  (gen_random_uuid(), :'tenant_id', 'accommodation_confirmed', 'Accommodation Confirmed', 6, 'POST_ARRIVAL',  false, false, '#7b1fa2', 'Home',         72,   now(), now()),
  (gen_random_uuid(), :'tenant_id', 'university_registered',   'University Registered',   7, 'ENROLLED',      false, false, '#5d4037', 'School',       168,  now(), now()),
  (gen_random_uuid(), :'tenant_id', 'enrolled',                'Enrolled',                8, 'ENROLLED',      false, true,  '#388e3c', 'CheckCircle',  NULL, now(), now());

COMMIT;
```

---

## Verification

1. **Sign in.** Open `/login` in the frontend and use the admin email +
   password you just provisioned. The login should succeed and you should
   land on the empty dashboard for the new tenant.

2. **Confirm the 8 stages.** Navigate to `Settings → Lifecycle Stages` (or
   `GET /api/v1/stages` with the admin's access token). You should see
   exactly the 8 defaults above, in sequence 1-8.

3. **Confirm RLS isolation.** This is the most important check and it is
   **impossible by design to switch tenants** within a single user session:

   - The access-token `tid` claim is signed at login and bound to the admin's
     home tenant.
   - Every authenticated request runs through `tenantContext` middleware,
     which calls `SELECT set_config('app.tenant_id', <tid>, true)` inside
     the request transaction.
   - Every business table has a Postgres RLS policy that filters by
     `tenant_id = current_setting('app.tenant_id')::uuid`.
   - The Prisma client connects as a non-superuser role (`spv_app`) that
     does **not** have `BYPASSRLS`.

   The acceptance test: query `GET /api/v1/students` with the new admin's
   token and confirm an empty list, even if other tenants in the same
   database have students. (You cannot "see" them — the RLS policy hides
   them, and there is no API to claim a different `tid`.)

4. **Audit row.** The script does not currently write an explicit audit
   row for the onboarding event. If you need one for compliance, insert
   manually after the script:

   ```sql
   -- For SOC2 / GDPR onboarding evidence. tenant_id NULL because the
   -- event is platform-scoped (founder-actor on the host platform).
   INSERT INTO audit_logs (id, tenant_id, action, entity_type, entity_id, entry_hash, created_at)
   SELECT gen_random_uuid(), NULL, 'tenant.onboarded', 'tenant', id,
          encode(sha256(id::text::bytea), 'hex'), now()
   FROM tenants WHERE legal_name = 'Acme Education Ltd.';
   ```

---

## Rollback

Both Option A and Option B run in a single transaction; a mid-flight crash
leaves the database unchanged. If you need to delete a tenant **after**
commit (e.g. wrong email entered, customer cancelled before go-live):

```sql
-- DESTRUCTIVE. Cascades delete users / students / everything for the tenant.
-- Run only with founder approval. Take a logical backup of the row first.
BEGIN;
COPY (SELECT * FROM tenants WHERE id = '<tenant_id>') TO '/tmp/tenant-backup.csv' CSV HEADER;
DELETE FROM tenants WHERE id = '<tenant_id>';
COMMIT;
```
