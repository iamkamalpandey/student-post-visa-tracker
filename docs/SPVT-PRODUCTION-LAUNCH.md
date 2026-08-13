# SPVT production launch runbook

Goal: a live production system. This is the ordered path, what is already done,
and the exact commands for the steps only a human can run.

**Read this before touching production.** Step 1 is DONE — the P3009 blockage
was cleared on 2026-08-13 and deploys now succeed. Step 2 (`SENTRY_DSN`) is
still open: the variable is not present in the live spec at all, so the app runs
with error tracking silently disabled.

---

## Live as of 2026-08-13

The app is deployed and serving: `GET /api/v1/health/readyz` → 200
`{"status":"ready","db":"ok"}`, 58 migrations applied, and the runtime role
verified RLS-enforced by the readiness gate.

**But it has never served a real user session.** Production holds 1 tenant and
1 user, and `audit_logs` contains 3,567 rows of which **zero** are tenant-scoped
— only cron rows and 18 `auth.login.failed`. There has never been a successful
login.

That matters for how much the green ticks below are worth. The T0-7 and T0-8
fixes are proven against a real de-privileged Postgres **locally**, not by
production traffic, because there is no production traffic to prove them with.
The first real login is still a genuine test: a tenant-scoped
`auth.login.success` row appearing in `audit_logs` is the confirmation that
tenant-scoped audit writes work end to end in this environment.

Two live-spec items remain open and are called out under Step 2 and Step 4.

## Status at a glance

| Gate | State |
|---|---|
| Code builds and tests | **GREEN** — 155 backend files / 1489 tests, 89 frontend, 0 failed |
| Frontend production build | **GREEN** — `next build` compiles all routes |
| Typecheck (backend + frontend) | **GREEN** |
| Lint | **GREEN** (0 errors, 49 warnings) |
| Migration chain replays from empty | **GREEN** — verified again on a virgin PostgreSQL 18.3 |
| **App works under the de-privileged role** | **GREEN** — see below; this was never tested before and hid two P0s |
| CI runs real migrations | **GREEN** |
| Deploy pipeline can run | **LIVE** — P3009 cleared, 58 migrations applied, deploys succeeding |
| Error tracking receives events | **STILL BLOCKED** — `SENTRY_DSN` is absent from the live spec entirely (verified 2026-08-13) |
| Health check detects a bad deploy | **NO** — live spec still probes `/livez`; confirmed in runtime logs. Operator declined the change; see Step 4 |
| Rate limiting honest about Redis | **LIVE** — dummy `REDIS_URL` removed from the live spec; `/readyz` reports `redis: not_configured` |
| Restore from backup tested | **DONE 2026-08-13** — RTO 429s, RPO 0 rows (step 6) |
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

**The platform health check still probes `/api/v1/health/livez`**, which returns
200 unconditionally. Verified in the live spec and in runtime logs
(`kube-probe` hitting `/livez` every 10s). `.do/app.yaml` in this repo says
`/readyz`, but the live spec is managed in the DigitalOcean console and does not
track that file — see the warning in the QA register's Tier 4.

So a deploy with a bad `DATABASE_URL`, or one whose RLS role cannot be verified,
would still be promoted as healthy. The `/readyz` readiness gate is real and
passing, but it is an application-level control the platform does not consult.

Changing it was offered and **deliberately declined by the operator** on
2026-08-13, on the grounds that `/readyz` 503s on DB failure *and* on an
unproven RLS role, so a transient blip could cycle instances rather than merely
log. That is a legitimate trade. To adopt it later, set
`services[].health_check.http_path` to `/api/v1/health/readyz` in the live
spec.

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

## Step 6 — Backup and restore — **DRILL PERFORMED 2026-08-13, MEASURED**

Executed end to end: a real restore into a separate cluster, verified against
the source, then destroyed. Numbers below are measured, not estimated.

| Metric | Measured |
|---|---|
| **RTO** (request → online, verified cluster) | **429 s ≈ 7 min 9 s** |
| **RPO** (data lost vs. the moment of request) | **0 rows** |

**Method** (repeat with these exact commands):

```bash
doctl databases create spvt-restoredrill --engine pg --version 16 \
  --size db-s-1vcpu-1gb --region blr1 --num-nodes 1 \
  --restore-from-cluster-name spvt-db
```

Then compare source vs restored and destroy:

```bash
doctl databases delete <restored-cluster-id> --force
```

**Verified equal** between source and restored: applied migrations (58),
tables (114), RLS policies (105), tenants, users, and the presence of
`pgcrypto`. `audit_logs` differed by 4 rows — all four written **after** the
fork was requested, and nothing at all was written between the restored
high-water mark (05:09:52Z) and the request (05:22:29Z). So the fork captured
everything that existed when it was asked for.

**Correction to an earlier estimate in this document.** I first read RPO off the
daily backup list (13:11 UTC) and called it "~16 hours". That was wrong:
`--restore-from-cluster-name` performs a point-in-time fork from continuous WAL,
not a restore of last night's snapshot. The observed recovery point was current
to the second the request was made.

**Still not proven by this drill:** that the *application* boots against a
restored cluster. The drill verified the data; pointing a staging deploy at it
is a separate step and remains untested.

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
