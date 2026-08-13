# SPVT production launch runbook

Goal: a live production system. This is the ordered path, what is already done,
and the exact commands for the steps only a human can run.

**Read this before touching production.** Steps 1 and 2 are blocking — the
deploy pipeline currently cannot succeed, and skipping straight to "deploy" will
fail at the PRE_DEPLOY job.

---

## Status at a glance

| Gate | State |
|---|---|
| Code builds and tests | **GREEN** — 155 backend files / 1489 tests, 89 frontend, 0 failed |
| Typecheck (backend + frontend) | **GREEN** |
| Lint | **GREEN** (0 errors, 49 warnings) |
| Migration chain replays from empty | **GREEN** — verified again on a virgin PostgreSQL 18.3 |
| **App works under the de-privileged role** | **GREEN** — see below; this was never tested before and hid two P0s |
| CI runs real migrations | **GREEN** |
| Deploy pipeline can run | **BLOCKED** — step 1 |
| Error tracking receives events | **BLOCKED** — step 2 |
| Health check detects a bad deploy | **FIXED** — was probing `/livez`, now `/readyz` |
| Rate limiting honest about Redis | **FIXED** — dummy `REDIS_URL` removed |
| Restore from backup tested | **NOT DONE** — step 6 |
| Alerting / on-call | **NOT DONE** — step 7 |

---

## Step 1 — Unblock the deploy pipeline (BLOCKING, human only)

`.do/app.yaml` runs `prisma migrate deploy` as a **PRE_DEPLOY job**, and a failed
PRE_DEPLOY aborts the deployment. Migration
`20991231235995_rls_institution_program_children` shipped broken on 2026-08-03
and has since been fixed, but production's `_prisma_migrations` table may still
carry the failed row, which makes every subsequent deploy fail with P3009 until
it is cleared.

**First, check whether you are actually affected:**

```bash
psql "$DATABASE_MIGRATE_URL" -c "SELECT migration_name, started_at, finished_at, rolled_back_at FROM _prisma_migrations WHERE finished_at IS NULL ORDER BY started_at;"
```

Empty result → not affected, go to step 2.

If it lists `20991231235995_rls_institution_program_children`, clear it. The
migration is transactional and applied nothing, so this is bookkeeping only:

```bash
pnpm --filter backend exec prisma migrate resolve --rolled-back 20991231235995_rls_institution_program_children
```

Then apply the corrected chain:

```bash
pnpm --filter backend prisma:migrate:deploy
```

Ten migrations are stranded behind it — full list and rationale in
[SPVT-MIGRATION-RECOVERY.md](SPVT-MIGRATION-RECOVERY.md).

**Verify tenant isolation actually landed** (this is the one that matters most,
because `program_fees` has no `tenant_id` of its own and RLS is its only
protection):

```bash
psql "$DATABASE_MIGRATE_URL" -c "SELECT tablename, policyname FROM pg_policies WHERE tablename = 'program_fees';"
```

No row means the migration did not apply and the table is readable across
tenants. Do not launch until this returns a `tenant_isolation` policy.

## Step 2 — Set SENTRY_DSN (BLOCKING, human only)

`@sentry/node` is installed and wired with PII scrubbing and tenant/user/
request-id scoping. `SENTRY_DSN` is declared as a SECRET in `.do/app.yaml` and
must be given a value, or `initSentry()` logs one line and disables itself —
which is indistinguishable from working.

Set it in the DigitalOcean app settings for **both** the `backend` service and
the `migrate` job, then confirm an event actually arrives before believing it.

## Step 3 — Confirm the runtime DB role is NOT a superuser

Tenant isolation is enforced by Postgres RLS, and **Postgres does not apply RLS
to superusers or BYPASSRLS roles**. If `DATABASE_URL` points at the DigitalOcean
admin role (`doadmin`), every tenant boundary in the product is inert.

```bash
psql "$DATABASE_URL" -c "SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;"
```

Both flags must be `f`.

This is now enforced automatically as well, on two levels: `config/db.ts` refuses
to start in production when it *detects* a privileged role, and `/readyz`
refuses to report ready until the role has been positively **proven**
RLS-enforced. Previously the check was skipped whenever its probe threw — so a
deploy racing a database failover could serve indefinitely with tenant isolation
never verified. An unverified instance now simply never receives traffic and the
platform keeps the previous version serving.

Run the query anyway. An automated gate that has never been observed failing is
an assumption, not a control.

### Step 3b — The de-privileged role is now actually exercised, not assumed

Until 2026-08-13 nothing verified that the application **works** under that role.
The existing integration test proved tenant A cannot read tenant B; nothing
proved the app can still read its **own** rows once RLS is real. That single gap
hid two P0 defects — **T0-7** (jobs, the audit writer and a dozen request-path
files read through a connection with no tenant GUC, matching zero rows and
failing every insert, silently) and **T0-8** (the audit chain calls `digest()`
from pgcrypto, which no migration installed).

Both are fixed, and `tests/rls-tenant-guc.integration.spec.ts` now connects the
real application client as a `NOSUPERUSER NOBYPASSRLS` role and exercises the
real helpers. To run the whole suite that way against any database:

```bash
pnpm --filter backend exec vitest run
```

with `DATABASE_URL` pointing at a de-privileged role and `DATABASE_MIGRATE_URL`
at the owner. Verified locally on PostgreSQL 18.3: 155 files / 1489 tests, all
passing, with the app connected as a role RLS genuinely applies to.

Note for anyone writing fixtures: the migrations apply **FORCE ROW LEVEL
SECURITY**, so the policies bind the table *owner* as well. Plain RLS exempts
the owner; FORCE does not. DDL is unaffected — which is why `prisma migrate
deploy` runs fine as the owner while its DML would not.

`DATABASE_URL` = runtime role (`spv_app`, non-superuser).
`DATABASE_MIGRATE_URL` = owner role (`spv`), used only by the PRE_DEPLOY job.

## Step 4 — Deploy and watch

Deploy from `main`. The PRE_DEPLOY job runs migrations first; if it fails, the
deployment aborts and the previous version keeps serving — that is the intended
behaviour and the reason step 1 matters.

The platform health check now probes `/api/v1/health/readyz`, which executes
`SELECT 1` and returns 503 on failure. Previously it probed `/livez`, which
returns 200 unconditionally, so a deploy with a bad `DATABASE_URL` would have
been promoted as healthy while every request 500'd.

**Rollback** is the DigitalOcean "Rollback" action to the previous deployment.
Migrations are forward-only — a rollback of the app does NOT revert schema, so
any migration must be backwards-compatible with the previous app version. All
migrations in this release are additive.

## Step 5 — Smoke test before announcing

Do these against production, in order. Each one has failed at some point in this
codebase, which is why they are on the list.

- [ ] `GET /api/v1/health/readyz` returns 200 with `db: ok`
- [ ] Log in as the seeded admin; MFA enrolment is reachable at /settings
- [ ] Create a student → **open it immediately** (this 403'd until recently)
- [ ] Page to page 2 of the students list and confirm the rows change
- [ ] Create a fee plan with a scholarship → the invoice's Net Payable equals
      the billed schedule
- [ ] Record a part payment on a CRM lead fee → the balance stays owed
- [ ] Mark a commission paid with a short amount → the variance shows
- [ ] Upload a document, then download it
- [ ] Confirm a Sentry event appears for a deliberately triggered error

## Step 6 — Backup and restore (NOT DONE — do not claim otherwise)

DigitalOcean managed Postgres takes automatic daily backups. **No restore has
ever been performed**, so the recovery time is unknown and the backups are
unverified. Untested backups are not backups.

Before carrying real customer data:
1. Restore the latest snapshot into a scratch database
2. Point a staging deploy at it and confirm the app boots and serves
3. Record the measured RPO and RTO here

## Step 7 — Alerting (NOT DONE)

Sentry will collect errors once step 2 is done, but nothing pages a human.
`/metrics` exposes Prometheus gauges including `db_up` and `redis_up`, and
nothing scrapes them. Decide an on-call path before the first real customer.

---

## Known limits to state honestly at launch

These are real and currently true. The full register with file:line evidence is
[SPVT-QA-PANEL-2026-08.md](SPVT-QA-PANEL-2026-08.md).

- **Single instance only.** `instance_count: 1` is required until a real Redis
  is provisioned. Scaling past 1 without it splits every rate limiter into
  per-process buckets (the 5/min auth brute-force cap becomes 5×N/min) and
  breaks TOTP anti-replay. The boot warning now fires correctly if anyone does.
- **`GET /students` returns every student in the tenant to any role**, while the
  detail route 403s the same records. Decision pending — see the QA register
  T6-2 and the expert panel synthesis.
- **`POST /auth/logout` does not revoke the access token**; the denylist is dead
  code and a stolen token survives logout for the remainder of its TTL.
- **Nepali is not translated** — the locale framework is wired, the content is
  English placeholders, and the switcher is deliberately unmounted.
- **Four complete backends have no UI**: saved views, notes, tags, student
  credits.
- **No formal certification** (SOC 2 / ISO 27001).
