# Student Post-Visa Tracker (SPVT) — Complete Guide

Multi-tenant SaaS for tracking international students after visa approval. Backend: Express + Prisma + PostgreSQL. Frontend: Next.js 14 + MUI v5. Data source: read-only mirror of the external V2 MIS (TheNextMis) CRM, scoped to visa-accepted leads.

Last verified against commit `2e2f658` (2026-08-03).

## Table of contents

1. What is SPVT?
2. Who uses it? (Roles + permissions)
3. Core concepts (tenant, RLS, V2 mirror, post-visa scope)
4. Features (top-level nav walkthrough)
5. User flows (step-by-step)
6. Data model (Prisma entities)
7. V2 sync — post-visa scope in detail
8. Security
9. Deployment (DigitalOcean App Platform)
10. Operational runbook
11. API endpoints (grouped)
12. Frontend architecture
13. Known caveats + gotchas
14. Troubleshooting

---

## 1. What is SPVT?

The **Student Post-Visa Tracker (SPVT)** is a multi-tenant SaaS application that consultancies use to track international students **after** their study visa has been approved. It replaces the ad-hoc spreadsheets and email threads that traditionally cover the "visa-accepted → arrived → enrolled → graduated" window.

Grounded in `README.md:1-6`:

> Multi-tenant SaaS for tracking international students after visa approval. Express + Prisma + PostgreSQL backend, Next.js 14 + MUI v5 frontend. Postgres RLS + RS256 JWT + audit hash-chain for tenant isolation, authn/z, and tamper-evident history.

**What it does not do:** SPVT does **not** manage the whole application funnel (documents collection → offer → visa lodgement → visa accepted). That lives upstream in the **V2 MIS** (TheNextMis) CRM. SPVT mirrors only the visa-accepted subset from V2, then owns the post-visa lifecycle (fee schedules, arrival, enrolment, engagement, expiries, offboarding) as its own data.

Grounded in `apps/backend/src/integrations/v2-mis/queries.ts:2-8`:

> read the V2 MIS CRM, scoped to visa-accepted leads. One READ ONLY pass returns a structured dump the ingest upserts.
> Scope rule: a lead is in scope if it has >=1 LeadCourses row at stateV2='visa_accepted' (not deleted). For those leads we mirror the FULL person record...

Grounded in the deployment readiness memo (`DEPLOYMENT-READINESS.md:6-11`), the application is functionally complete:

> Navigation: all 17 sidebar items → real routes; 0 broken links; 0 placeholder/stub pages... Actions: 50+ buttons/forms across students, leads, imports, admin, billing, settings, inbox — all wired to real endpoints + handlers. No dead/no-op actions. Documents: end-to-end (upload → MIME-sniff → ClamAV → encrypt-at-rest → list → signed download → verify → soft-delete).

The design is finance-grade: every write is audit-logged into a per-tenant SHA-256 hash chain (`README.md:59-60`), sensitive PII columns are envelope-encrypted, and tenant isolation is enforced at the database layer (Postgres RLS) rather than the application layer.

---

## 2. Who uses it?

Three built-in roles (`packages/zod-schemas/src/common.ts:98`):

```ts
export const RoleEnum = z.enum(['ADMIN', 'COUNSELLOR', 'VIEWER']);
```

| Role | Purpose | Typical actions |
|---|---|---|
| `ADMIN` | Operator, tenant owner | Configure stages / visa types / users, run V2 sync, manage billing plans, review audit log, run reports, convert leads → students, force-disable MFA, manage message templates |
| `COUNSELLOR` | Frontline staff | View + edit their own assigned students/leads, mark fees paid/waived, add notes, transition lifecycle stages, add contacts/qualifications, send messages |
| `VIEWER` | Read-only observer | GET-only across every route; middleware forbids all non-GET verbs regardless of route (`apps/backend/src/middlewares/auth.ts:63-65`) |

### Enforcement layers

1. **Global** (`apps/backend/src/middlewares/auth.ts:63-65`):

   ```ts
   if (claims.role === 'VIEWER' && !READ_METHODS.has(req.method)) {
     return next(Forbidden('Viewer role is read-only'));
   }
   ```

2. **Per-route** via `requireRole(...roles)` (`apps/backend/src/middlewares/auth.ts:73-79`).
3. **Per-record** via `requireStudentOwnership` and `requireStudentOwnershipViaChild` — a COUNSELLOR can only mutate students where `assigned_to_id = self`; ADMIN bypasses (`apps/backend/src/middlewares/auth.ts:150-210`). Applied to every PII-mutation endpoint (patch student, add contact, log employment, etc.).

### Illustrative access matrix (grounded in route files)

| Area | ADMIN | COUNSELLOR | VIEWER |
|---|---|---|---|
| List / view students, leads, applications | Yes | Yes (own) | Yes (own) |
| Create student, add fee, mark fee paid | Yes | Yes (own lead) | No |
| PATCH student, transitions | Yes | Yes (own) | No |
| DELETE student, delete document | Yes | No | No |
| Users CRUD, reset password, revoke sessions | Yes (MFA required) | No | No |
| Convert CRM lead → student | Yes (idempotency-key + MFA) | No | No |
| POST `/leads/sync` (V2 sync) | Yes (rate-limited) | No | No |
| Message templates CRUD | Yes (write) | Yes (read) | Yes (read) |
| Audit log read + verify hash chain | Yes | No | No |
| Reports (visa-funnel, counsellor-load, ...) | Yes | No | No |
| Breach incidents, DSAR, sub-processors | Yes | No | No |
| Billing plans + admin | Yes | Yes (mutations for fees) | No |
| Tenant settings `/tenants/me` | Yes | No | No |

For MFA-required routes the caller must have MFA enrolled AND supply an `X-MFA-Code` header on every request; enforced via `requireMfa({enrollmentRequired: true})` (`apps/backend/src/modules/users/users.routes.ts:33-62`).

---

## 3. Core concepts

### 3.1 Tenant

Every business row carries a `tenant_id` UUID. A tenant models a single consultancy (or business unit) and owns its users, students, leads, catalog data, audit log, and billing state (`apps/backend/prisma/schema.prisma:24-105`).

Tenant defaults include locale, timezone, currency (`default_currency`), data residency region, per-tenant FROM email address, and feature flags: `billing_enabled` (school/college billing) and `require_mfa_for_admins`.

Tenant records are themselves RLS-protected (`apps/backend/prisma/migrations/20991231235959_init_rls_and_triggers/migration.sql:51-57`) — a session can only read its own `tenants` row.

### 3.2 Postgres Row-Level Security (RLS)

Tenant isolation is enforced in the **database**, not the application. Every tenant-scoped table has a policy of the shape:

```sql
CREATE POLICY tenant_isolation ON <table>
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
```

Where `app_current_tenant()` reads the per-connection session GUC `app.tenant_id`. If the GUC is unset the policy blocks — the earlier "escape hatch" (`OR app_current_tenant() IS NULL`) was removed by migration `20991231235983_rls_remove_escape_hatch` (`.../migration.sql:1-50`). This means a single forgotten `req.db` no longer leaks across tenants.

**How the GUC gets set** — `apps/backend/src/middlewares/tenantContext.ts:22-53`:

```ts
function makeScopedClient(tenantId: string): typeof prisma {
  return prisma.$extends({
    name: 'tenantScope',
    query: {
      async $allOperations({ args, model, operation, query }) {
        return prisma.$transaction(async (tx) => {
          await tx.$executeRaw(
            Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
          );
          // ... dispatch on tx.<model>.<operation>(args)
        });
      },
    },
  }) as unknown as typeof prisma;
}
```

The `set_config(..., true)` third-arg `true` = local scope; the GUC auto-resets at transaction end so pooled connections never leak the previous tenant.

**Runtime role assertion** (`apps/backend/src/config/db.ts:69-102`): at boot, the backend queries `pg_roles` and refuses to start in production if `DATABASE_URL` connects as a superuser or BYPASSRLS role. Postgres silently disables RLS for such roles, so a `doadmin`-based DATABASE_URL would nuke isolation entirely with no other symptom.

Two Prisma clients coexist:
- `prisma` — RLS-enforced app role (`spv_app`). Used by `req.db` after `tenantContext`.
- `prismaAdmin` — superuser (`DATABASE_MIGRATE_URL`). Only for authentication-time cross-tenant lookups (login by email, password reset, refresh token by hash, logout) — see `apps/backend/src/config/db.ts:22-50`.

### 3.3 V2 MIS mirror + post-visa scope

V2 MIS (TheNextMis) is a separate Postgres running the whole application funnel: documents collection, offer received, offer accepted, visa lodgement, **visa accepted**, visa refused. SPVT reads V2 **read-only** in one pass and mirrors only leads that have at least one visa-accepted `LeadCourses` row (`apps/backend/src/integrations/v2-mis/queries.ts:1-8`). Once in scope, the entire person record is mirrored — every application/course/history/payment/activity/profile — because "mirror the lead" means the person, not just the visa-accepted course.

Once a lead is mirrored, SPVT owns the post-visa work queue and finance columns; V2 stays authoritative for identity + funnel + history.

### 3.4 The v2_* dedup pattern

Every mirrored table has three column groups:

1. **V2 SOURCE** — fields copied from V2 verbatim.
2. **V2 EXTERNAL KEY** — the source system's integer id (`v2_lead_id`, `v2_application_id`, `v2_course_id`, `v2_payment_id`, …) plus `source_system` = `"v2_mis"` and `synced_at` timestamp. A unique constraint like `@@unique([tenant_id, v2_lead_id], name: "crm_lead_v2_dedup")` gives the upsert its natural key.
3. **SPVT-OWNED** — fields SPVT alone touches: `spv_status`, `assigned_to_id`, `spv_notes`, `student_id`, `converted_at`, `converted_by_id`, `version`, `created_at`, audit metadata, `deleted_at`.

The upsert in `apps/backend/src/jobs/v2Ingest.ts:213-221` shows the pattern: `update: src` refreshes V2 SOURCE columns only — SPVT-owned fields never appear in the update payload, so a re-sync **never clobbers** local edits.

---

## 4. Features (sidebar walkthrough)

Sidebar layout (`apps/frontend/components/AppShell.tsx:108-146`):

- **Primary**: Dashboard, Students, Leads, Inbox, Calendar, Institutions, Courses (label key `programs`), Imports.
- **Admin (admin-only)**: Admin, Billing (if `tenant.billing_enabled`), Compliance group (collapsible) → Audit, DSAR, Consents, Breaches, Sub-processors.
- **Settings**: Settings (available to all).

Each item below documents *what it does*, *click path*, *underlying endpoint(s)*, and *related tables*.

### 4.1 Dashboard (`/`)

Landing page showing KPI tiles + finance summary + expiring items + SLA breaches + engagement-at-risk. Backend endpoints (`apps/backend/src/modules/dashboard/dashboard.routes.ts`):

- `GET /dashboard/summary` — headline counts.
- `GET /dashboard/finance-summary` — per-currency outstanding/collected/payments.
- `GET /dashboard/expiries` — passport/visa/insurance/document expiries.
- `GET /dashboard/sla-breaches` — students overdue at their current stage.
- `GET /dashboard/engagement-at-risk` — engagement heuristic.
- `GET /dashboard/onboarding` — first-run empty-state helper.

Tables read: `students`, `crm_leads`, `crm_lead_fees`, `finance_items`, `lifecycle_stages`, `student_visas`, `documents`, `engagement_checks`.

### 4.2 Students (`/students`)

Managed post-visa students: full record with encrypted PII (passport, visa numbers, contacts).

Click path: sidebar → **Students** → list; click a row → detail with tabs (Overview, Contacts, Qualifications, Documents, Finance, Visas, Travel, Accommodation, Insurance, Employment, Dependents, Timeline).

Endpoints (`apps/backend/src/modules/students/students.routes.ts`):
- `GET /students` — list (paginated).
- `POST /students` — create (ADMIN, COUNSELLOR).
- `GET /students/:id` — read (ownership-gated).
- `PATCH /students/:id` — update (ownership-gated).
- `DELETE /students/:id` — soft-delete (ADMIN).
- `GET /students/:id/timeline` — combined event feed.
- `POST /students/:id/transitions` — advance lifecycle stage.
- `GET /students/:id/completeness` — completeness ring metric.

Related tables: `students`, `addresses`, `student_addresses`, `student_identifications`, `student_visas`, `student_contacts`, `academic_qualifications`, `language_test_results`, `documents`, `finance_items`, `travel_records`, `accommodations`, `insurance_records`, `student_employment`, `student_dependents`, `student_lifecycle_events`.

### 4.3 Leads (`/leads`)

**IMPORTANT**: The sidebar label is "Leads" but the page heading says "Applications". This is intentional — the page shows one row per visa-accepted lead-course (visa-accepted applications = the post-visa work queue). Grounded in the recent fix commit `e3a1e1b`:

> V2's operational reality: the visa-accepted funnel state lives on LeadCourses, not Applications. Applications are sparse (9 rows for 333 leads) and their (v2_lead_id, v2_course_id) rarely align with the visa-accepted lead-course — driving the list off crm_applications hid ~333 real work-queue items behind 2 stray rows.
> Rewrite so crm_lead_courses is the base query (state_v2='visa_accepted'), and crm_application is enriched in via the (v2_lead_id, v2_course_id) composite when present.

Click path: sidebar → **Leads** → paginated table (Applicant, Course, Institution, Country, Intake, Next fee due, Status). Row click → `/leads/[id]` detail with tabs (Profile, Fees, Applications, Payments, Activity, Assignments, Guardians, History).

Header controls (`apps/frontend/app/(app)/leads/Client.tsx`):
- **CRM catalog** button → `/leads/institutions` (visa-accepted-scoped institutions + courses reports).
- **Sync from V2** button (ADMIN only) → posts to `/leads/sync`, shows last run status inline.

Endpoints (`apps/backend/src/modules/crm-leads/crm-leads.routes.ts`):
- `GET /leads` — list leads (pagination, filters: `search`, `intake_key`, `has_upcoming_fee`, `assigned_to_id`, `status`).
- `GET /leads/applications` — list one row per visa-accepted lead-course (enriched with application if present).
- `GET /leads/finance-summary` — per-currency `outstanding`, `collected`, `payments`.
- `GET /leads/institutions-report` — institutions catalog.
- `GET /leads/courses-report` — courses catalog.
- `POST /leads/sync` — ADMIN, rate-limited (v2SyncLimiter).
- `GET /leads/:id` — full detail (includes lead_courses, applications, course_history, payments, remarks, follow_ups, calls, visits, assignments, qualifications, language_tests, guardians, fees, student link).
- `PATCH /leads/:id` — ADMIN, COUNSELLOR; If-Match version required. Only updates `spv_status`, `assigned_to_id`, `spv_notes`.
- `POST /leads/:id/convert` — ADMIN; requires `Idempotency-Key` header. Creates a managed `Student` + migrates fees + optional enrollment.
- Fee CRUD:
  - `POST /leads/:id/fees` — add SPVT-owned fee.
  - `PATCH /leads/:id/fees/:feeId` — edit (If-Match).
  - `POST /leads/:id/fees/:feeId/pay` — mark paid (atomic guard).
  - `POST /leads/:id/fees/:feeId/waive` — waive.
  - `DELETE /leads/:id/fees/:feeId` — soft-delete.

Related tables: `crm_leads`, `crm_lead_courses`, `crm_applications`, `crm_courses`, `crm_institutions`, `crm_countries`, `crm_lead_course_history`, `crm_payments`, `crm_remarks`, `crm_follow_ups`, `crm_call_history`, `crm_visits`, `crm_assignments`, `crm_qualifications`, `crm_language_tests`, `crm_guardians`, `crm_lead_fees`.

### 4.4 Inbox (`/inbox`)

Consolidated task feed with three tabs (`?tab=tasks|expiring|messages`). Replaced the older separate Reminders / Expiries / Inbox pages (`apps/frontend/components/AppShell.tsx:104-107`).

Endpoints (`apps/backend/src/modules/comms/routes.ts`):
- `GET /inbox/messages` — list.
- `POST /inbox/messages/read-all`.
- `POST /inbox/messages/:id/read`.
- Reminders: `apps/backend/src/modules/reminders/routes.ts` (list, dismiss, snooze).
- Expiries union: `apps/backend/src/modules/expiries/routes.ts` — reads across visa, passport, insurance, document, regulator-id sources.

### 4.5 Calendar (`/calendar`)

Reminder/task calendar view. Backed by the reminders module (`/api/v1/reminders`).

### 4.6 Institutions (`/institutions`)

Consultancy's academic-catalog institutions (distinct from `crm_institutions` mirrored from V2 — see caveat 13.10).

Endpoints (`apps/backend/src/modules/institutions/institutions.routes.ts`): GET / POST / PATCH / DELETE `/institutions/:id`; nested identifiers, accreditations, contacts, campuses. Super-agent pivots at `/institutions/:id/super-agents`.

Tables: `institutions`, `campuses`, `schools`, `departments`, `institution_identifiers`, `institution_accreditations`, `institution_contacts`, `institution_super_agents`.

### 4.7 Programs — "Courses" in the UI (`/programs`)

Academic program catalog. Endpoints (`apps/backend/src/modules/programs/programs.routes.ts`): CRUD `/programs`; nested intakes, requirements, modules, fees.

Tables: `programs`, `program_intakes`, `program_requirements`, `program_modules`, `program_fees`.

### 4.8 Imports (`/imports`)

Bulk CSV import for students. Endpoints under `/api/v1/imports`. Table: `import_jobs`, `import_mapping_templates`.

### 4.9 Admin (`/admin`)

Single tabbed page consolidating admin sub-areas (`AppShell.tsx:120-123`). Sub-pages surface:
- Stages (`/stages`) — configurable lifecycle stages + transitions.
- Visa types (`/visa-types`) — per-(country × visa-type) catalog.
- Users (`/users`) — user CRUD.
- Commissions (`/commissions`).
- Reports (`/reports`).
- Exports (`/exports`).
- Catalog (`/catalog`).
- Super-agents (`/super-agents`), super-agent-types (`/super-agent-types`).
- Interview prep (`/interview-questions`, `/interview-attempts`).
- Outbox (`/admin/outbox`), Tenants (`/admin/tenants`).

### 4.10 Billing (`/billing`)

Double-gated: admin role + `tenant.billing_enabled` (schema: `Tenant.billing_enabled` default false, `apps/backend/prisma/schema.prisma:47`). Fee plans, installments, payments, allocations, adjustments, refunds, credits.

Tables: `fee_plans`, `fee_installments`, `payments`, `payment_allocations`, `fee_adjustments`, `refunds`, `student_credits`.

### 4.11 Compliance (collapsible, admin-only)

- **Audit (`/audit`)** — append-only hash-chained log; verify chain intact.
- **DSAR (`/dsar`)** — GDPR data-subject requests.
- **Consents (`/consents`)** — recorded lawful bases + revocations.
- **Breaches (`/breach-incidents`)** — incidents with GDPR Art. 33 72h SLA.
- **Sub-processors (`/sub-processors`)** — Art. 28 third-party inventory.

### 4.12 Settings (`/settings`)

Per-user self-service: locale, timezone, notification digest cadence, MFA enrol/disable, password change. Sections in `apps/frontend/app/(app)/settings/sections/`.

---

## 5. User flows

### 5.1 First-time admin onboarding

1. Navigate to the frontend URL (e.g. `https://spvt.example.com`).
2. Log in with the seeded admin: `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` (dev default `admin@example.com` / `ChangeMeNow!2026` — `README.md:32-37`). **Immediately change the password** from Settings → Security or via `POST /api/v1/auth/change-password`.
3. Open **Settings → Security**, enrol MFA (TOTP): `POST /auth/mfa/setup` returns an `otpauth://` URL; scan in an authenticator, then `POST /auth/mfa/verify` with a 6-digit code. Save the printed recovery codes.
4. Open sidebar → **Admin → Users** and create counsellor/viewer accounts (`POST /users`). New users receive a set-password email if email is configured; otherwise the admin uses `POST /users/:id/reset-password` (requires admin MFA header).
5. Confirm the tenant has `V2_INGEST_TENANT_ID` pointing at it (env var, set at deploy time). If unsure, ask an operator to check DO env vars.
6. Click **Leads → Sync from V2**. First sync may take several minutes; the button shows "Syncing…" and last-run status appears beneath it (`apps/frontend/app/(app)/leads/Client.tsx:26-50`).
7. Once complete, applications appear in the leads table. Row-click opens the applicant.

### 5.2 Handling a visa-accepted applicant

1. Sidebar → **Leads**.
2. Filter by intake key or applicant name using the top toolbar. Toggle "Has upcoming fee" to focus on the money queue.
3. Click a row → `/leads/[id]`.
4. In the **Fees** tab, see auto-seeded post-visa fees (each labelled "<course name> — Session 1" if seeded from V2). Add extra fees via **Add fee** dialog (`POST /leads/:id/fees`).
5. In **Overview**, assign a counsellor via the dropdown (calls `PATCH /leads/:id` with `assigned_to_id`; requires `If-Match: "<version>"` header — the FE handles this).
6. Add internal notes via the notes textarea (writes to `spv_notes`).
7. Later, when the student is ready to be a full "managed" student, click **Convert to student** → confirm the pre-filled Student form. Uses `POST /leads/:id/convert` (ADMIN only, Idempotency-Key required — auto-injected by the axios interceptor).

### 5.3 Marking a fee paid

1. Open the lead detail → **Fees** tab.
2. Find the fee row → **Actions** menu → **Mark paid**.
3. Confirm date + optional partial amount → **Confirm**.
4. Endpoint: `POST /leads/:id/fees/:feeId/pay` with `{"paid_on":"2026-08-03","paid_amount_minor":123456}`. Server-side is an atomic `updateMany` (`apps/backend/src/modules/crm-leads/crm-leads.service.ts:275-278`) with `status: { not: 'PAID' }` so concurrent double-clicks can't record two payments on the same row.
5. On success, related PENDING/SENT reminders are auto-dismissed (`.../crm-leads.service.ts:281-283`).
6. Audit event `crm_lead.fee.paid` is written into the hash chain.

### 5.4 Running a manual V2 sync

1. Sidebar → **Leads** → header → **Sync from V2** (ADMIN only).
2. Sync runs under a Postgres advisory lock (`runJob('v2.ingest', {ttlSec: 30 * 60}, ...)`) so a second click while one is running returns `status: 'ALREADY_RUNNING'` (`.../crm-leads.service.ts:326-347`).
3. UI toasts: "Synced N record(s)" / "A sync is already running." / "Sync failed — check the V2 connection.".
4. The last-run chip shows status + timestamp + rows processed. Backed by `GET /jobs/recent?jobName=v2.ingest&limit=1` (`apps/backend/src/modules/jobs/routes.ts:21`).
5. Under the hood: read visa-accepted `LeadCourses` from V2 → build the dump → topological upsert (countries → institutions → courses → leads → applications → lead-courses → history → payments → activity → profile → fees). Details in §7.

### 5.5 Password reset flow

Self-service (`apps/backend/src/modules/auth/auth.routes.ts:74-87`):

1. On the login screen, click **Forgot password** → `/forgot-password`.
2. Enter email → `POST /auth/password/reset-request`. Endpoint **always** returns 200 with the same body shape (defeats account enumeration). Rate-limited: 5/min/IP (`authLimiter`).
3. Backend generates a single-use, 30-min TTL token stored as `sha256(token)` in `password_reset_tokens`. Raw token is emailed (via `EMAIL_PROVIDER=resend` in prod or logged when `EMAIL_PROVIDER=log`).
4. User clicks link → `/reset-password?token=<raw>` → enters new password → `POST /auth/password/reset-confirm`.
5. Backend validates the token, checks it isn't consumed/expired, applies bcrypt hash, marks token consumed, revokes all live refresh tokens for the user.

Admin-initiated reset:
1. Sidebar → **Admin → Users** → click a user → **Reset password**.
2. Admin must have MFA enrolled and supply `X-MFA-Code` header (`apps/backend/src/modules/users/users.routes.ts:48-54`).
3. Endpoint: `POST /users/:id/reset-password` — issues a reset link the same way as self-service.

### 5.6 CRM catalog navigation (institutions + courses reports)

The CRM catalog is a **visa-accepted-scoped** aggregate view over mirrored institutions + courses. It shows only institutions that at least one visa-accepted lead-course points at, along with counts.

1. From **Leads** → click **CRM catalog** → `/leads/institutions`.
2. Backing endpoints:
   - `GET /leads/institutions-report` — one row per institution with lead + course counts.
   - `GET /leads/courses-report` — one row per course with fee (from V2), institution, and lead counts.
3. Tables read: `crm_institutions`, `crm_courses`, `crm_lead_courses`, `crm_countries`.
4. Data reflects the last successful sync. Rerun sync from `/leads` to refresh.

### 5.7 Audit log review

1. Sidebar → **Compliance → Audit** (`/audit`, admin only).
2. Filter by actor, entity type, action, date range → `GET /audit-logs` (`apps/backend/src/modules/audit/routes.ts:52`).
3. Click **Verify chain** → `GET /audit-logs/verify` recomputes SHA-256 hash chain per tenant and returns `broken_count`.
4. `GET /audit-logs/anchors` returns nightly Merkle roots (`audit_anchors` table); external WORM replication can compare.
5. Trigger `audit_logs_no_update` + `audit_logs_no_delete` (`apps/backend/prisma/migrations/20991231235959_init_rls_and_triggers/migration.sql:70-78`) makes rows immutable at the database level — the API can only insert.

---

## 6. Data model

The Prisma schema (`apps/backend/prisma/schema.prisma`, 3857 lines, 84 models) is organised into these groups.

### 6.1 Tenant, users, auth (lines ~24-350)

| Model | Purpose | Key fields |
|---|---|---|
| `Tenant` | Consultancy / business unit. RLS root. | `id`, `name`, `default_locale`, `default_timezone`, `default_currency`, `email_from`, `billing_enabled`, `require_mfa_for_admins`, `is_active` |
| `User` | Person with credentials. | `id`, `tenant_id`, `email` (unique per tenant), `password_hash` (bcrypt), `role` (`ADMIN`/`COUNSELLOR`/`VIEWER`), `mfa_enabled`, `mfa_secret_enc` (envelope-encrypted), `mfa_recovery_hashes`, `notifications_digest`, `failed_login_count`, `locked_until` |
| `RefreshToken` | Rotating refresh tokens. | `id`, `token_hash` (unique, HMAC-peppered), `expires_at`, `revoked_at`, `last_used_at` (SVT-SEC-IDLE), `replaced_by_id` |
| `AccessTokenDenylist` | Revoked access-token JTIs (logout). | `jti`, `user_id`, `tenant_id`, `expires_at` |
| `PasswordResetToken` | Single-use reset tokens. | `token_hash` (sha256), `expires_at`, `consumed_at`, `invalidated_at` |
| `AuditAnchor` | Nightly Merkle root of the audit chain. | `tenant_id`, `root_hash`, `entries_count`, `last_entry_id`, `anchored_at` |
| `SubProcessor` | GDPR Art. 28 processor inventory. | `name`, `purpose`, `region`, `dpa_signed_at`, `transfer_mechanism` |
| `ConsentRecord` | Per-subject lawful-basis records. | `subject_type`, `subject_id`, `purpose`, `lawful_basis`, `granted`, `justification` |
| `DSARRequest` | GDPR SAR/erasure workflow. | `type`, `status`, `requested_at`, `due_by`, `export_storage_key` |
| `BreachIncident` | Incident register + 72h SLA. | `detected_at`, `due_by`, `severity`, `affected_subjects_count` |

### 6.2 Reference / lookup (~370-500)

`Country`, `Currency`, `IscedField`, `AirlineIATA`, `AirportIATA`, `VisaCategory`, `RelationshipType`, `DocumentType`.

### 6.3 Lifecycle configuration (~500-640)

| Model | Purpose |
|---|---|
| `LifecycleStage` | Per-tenant stage catalog (post-visa). Key fields: `key`, `label`, `sequence`, `category` (`IN_PROGRESS`/etc.), `is_initial`, `is_terminal`, `is_outcome_success`, `is_outcome_failure`, `sla_hours`, `visa_type_id` (per-(country×visa-type) scoping), `prompt_date_label`. |
| `VisaType` | Per-tenant per-country visa workflow. |
| `LifecycleStageTransition` | Allowed stage → stage moves, optionally `requires_role`. |
| `LifecycleStageChecklistItem` | Tasks required in a stage. |
| `StudentStageChecklistProgress` | Per-student checkbox state. |

### 6.4 Managed student (~674-1170)

| Model | Purpose |
|---|---|
| `Student` | Post-visa student record. Envelope-encrypted passport/PII columns. Assigned counsellor. Current stage. |
| `Address` / `StudentAddress` | Reusable addresses (normalised). |
| `StudentIdentification` | Passport, national ID, etc. |
| `StudentVisa` | Visa issued/renewed events. |
| `StudentRegulatorIdentifier` | CAS/COE/I-20 style regulator ids. |
| `ComplianceCheck` / `EngagementCheck` | Periodic checks. |
| `StudentEmployment`, `StudentDependent`, `AcademicQualification`, `LanguageTestResult`, `StudentContact`, `Sponsor`, `StudentSponsorship` | Child records. |

### 6.5 Academic catalog (~1186-1530)

`Institution` (with `InstitutionIdentifier`, `InstitutionAccreditation`, `InstitutionContact`, `Campus`, `School`, `Department`), `Program` (with `ProgramIntake`, `ProgramRequirement`, `ProgramModule`, `ProgramFee`), `Enrollment`.

### 6.6 Super-agents (~1629-1780)

`SuperAgentType`, `SuperAgent`, `SuperAgentContact`, `SuperAgentCommissionRule`, `InstitutionSuperAgent`.

### 6.7 Post-visa modules (~1773-1930)

`TravelRecord`, `Accommodation`, `InsuranceRecord`, `FinanceItem`.

### 6.8 Documents, communications, tags, notes (~1932-2200)

`Document`, `MessageTemplate`, `CommsThread`, `CommsMessage`, `Tag`, `EntityTag`, `Note`, `AttributeDefinition`, `EntityAttribute`, `SavedView`.

### 6.9 Lifecycle events + audit (~2175-2260)

`StudentLifecycleEvent` (append-only), `AuditLog` (append-only, hash-chained).

### 6.10 Bulk + operational (~2251-2560)

`ImportJob`, `ImportMappingTemplate`, `ExportJob`, `ExternalId`, `IdempotencyRecord`, `Reminder`, `CommissionClaim`, `JobRun`.

### 6.11 Billing (~2614-2900)

`FeePlan`, `FeeInstallment`, `Payment`, `PaymentAllocation`, `FeeAdjustment`, `Refund`, `StudentCredit`.

### 6.12 CRM mirror (V2 MIS) (~2986-3700)

| Model | Purpose | Key V2-dedup index |
|---|---|---|
| `CrmCountry` | Mirrored V2 Country. | `[tenant_id, v2_country_id]` |
| `CrmInstitution` | Mirrored V2 Institution. | `[tenant_id, v2_institution_id]` |
| `CrmCourse` | Mirrored V2 Course (with `fee_amount_minor` + `fee_currency`). | `[tenant_id, v2_course_id]` |
| `CrmLead` | Mirrored V2 Lead (identity + profile + attribution). SPVT-owned: `spv_status`, `assigned_to_id`, `spv_notes`, `student_id`, `converted_at`, `converted_by_id`. | `[tenant_id, v2_lead_id]` + `[tenant_id, phone_number]` (phone uniqueness) |
| `CrmApplication` | Mirrored V2 Application. Sparse in V2 practice — see caveat 13.10. | `[tenant_id, v2_application_id]` |
| `CrmLeadCourse` | Mirrored V2 LeadCourses — the **funnel-state** row. Composite source id `(v2_lead_id, v2_course_id)`. Fields: `state` (legacy free-text), `state_v2` (typed enum), `sub_state`, `start_date`, `end_date`. | `[tenant_id, v2_lead_id, v2_course_id]` |
| `CrmLeadCourseHistory` | Append-only state history. | `[tenant_id, v2_history_id]` |
| `CrmPayment` | Mirrored V2 Payment (session fees). | `[tenant_id, v2_payment_id]` |
| `CrmRemark` / `CrmFollowUp` / `CrmCallHistory` / `CrmVisit` / `CrmAssignment` | Activity streams. | Each has its own V2 dedup. |
| `CrmQualification` / `CrmLanguageTest` / `CrmGuardian` | Applicant profile detail. | |
| `CrmLeadFee` | **SPVT-OWNED** post-visa fee schedule. Not mirrored — SPVT is authoritative. `session_label`, `amount_minor`, `currency`, `due_on`, `status` (`SCHEDULED`/`DUE`/`OVERDUE`/`PAID`/`WAIVED`), `paid_at`, `paid_amount_minor`, `seeded_from_v2` bool. | Business logic: never overwrites edits (see §7). |

### 6.13 Federation-reserved (island tables) (~3705-3755)

`SpvLeadOverlay`, `SpvLeadFee` — reserved for the "read V2 live" mode (`SPV_READ_MODE=live`). Present but not yet wired (`DEPLOYMENT-READINESS.md:29-30`).

### 6.14 Interview prep (~3778-3860)

`InterviewQuestion`, `InterviewAttempt`, `InterviewAnswer`.

---

## 7. V2 sync (post-visa scope) — detailed flow

Grounded end-to-end in `apps/backend/src/integrations/v2-mis/queries.ts` and `apps/backend/src/jobs/v2Ingest.ts`.

### 7.1 Trigger paths

- **Scheduler** (daily) — `runV2IngestPass()` in `.../v2Ingest.ts:410-424`. Skips when `V2_INGEST_ENABLED=false` or `V2_INGEST_TENANT_ID` unset. Otherwise verifies the tenant is active + calls `ingestForTenant`.
- **On-demand** — `POST /leads/sync` (ADMIN, `v2SyncLimiter`) → `triggerSync()` (`.../crm-leads.service.ts:318-351`). Wraps in `runJob('v2.ingest', {ttlSec: 30*60}, ...)` for advisory-lock idempotency.

### 7.2 Scope filter

`.../queries.ts:69-72`:

```sql
SELECT "leadId" FROM "LeadCourses"
 WHERE "isDeleted" = false
   AND ("stateV2" = 'visa_accepted' OR state ILIKE '%visa%accept%')
```

Rationale (`.../queries.ts:60-72`): V2 dual-writes `LeadCourses.state` (legacy free-text like `"Visa Accepted"`, well populated ~301 rows) and `LeadCourses.stateV2` (typed enum `'visa_accepted'`, sparsely backfilled ~88 rows). Using either column alone under-counts. The union matches V2's own admin count. **Note**: `Application.state` is a lifecycle flag (ACTIVE/completed), not the visa funnel, so it must not be used here.

### 7.3 Read pass (single READ ONLY transaction)

`.../queries.ts:47-134`:

1. `BEGIN TRANSACTION READ ONLY` + `assertV2ReadOnly()` (verifies the role has no INSERT privilege and isn't a superuser).
2. Scope leads (`leadIds`).
3. Fetch `Lead`, `Application` (deletedAt is null), `LeadCourses`, `LeadCourseStateHistory`, `Remark`, `FollowUpDate`, `CallHistory`, `VisitHistory`, `Qualification`, `LanguageTestResult`, `Guardian` — all `WHERE leadId = ANY($1::int[])`.
4. `AssignedUser` + `Follower` unified with a `kind` tag (`ASSIGNEE` / `FOLLOWER`).
5. Payments — link via `Payment.studentId → Student.id → Student.leadId`.
6. Catalog: only the referenced `Course` / `Institution` / `Country` rows (id-set filtered).
7. `COMMIT`.

### 7.4 Ingest (topological upsert per row, per own tenant tx)

`.../v2Ingest.ts:93-407`:

1. **Countries** → `CrmCountry` upsert on `[tenant_id, v2_country_id]`.
2. **Institutions** → `CrmInstitution`, resolves `country_id` via `countryMap`.
3. **Courses** → `CrmCourse`, stores `fee_amount_minor` (BigInt) via `decimalToMinor(c.feeAmount, c.feeCurrency ?? env.V2_INGEST_DEFAULT_CURRENCY)`.
4. **Leads** → `CrmLead` upsert. **Update payload is `src` only** — SPVT-owned columns (`spv_status`, `assigned_to_id`, `spv_notes`, `student_id`, `converted_at`, `converted_by_id`) are intentionally absent, so a resync never clobbers local edits. Also: DSAR-erased leads (soft-deleted → `deleted_at != null`) are filtered up front (`.../v2Ingest.ts:178-189`) so an erased subject is never re-populated.
5. **Applications** → `CrmApplication`, requires resolved `leadId` + `courseId` from maps.
6. **Lead-courses** → `CrmLeadCourse`, using `leadCourseStateEnum(stateV2, state)` to derive the typed enum (unambiguous only — ambiguous legacy values stay null).
7. **History** → `CrmLeadCourseHistory` (append-only).
8. **Payments** → `CrmPayment` (BigInt minor units, currency slice-3 upper).
9. **Activity** → remarks, follow-ups, calls, visits, assignments.
10. **Profile** → qualifications, language tests, guardians.
11. **Fee seed** — see §7.5.

Each row runs inside `withTenantTx` (its own transaction with `set_config('app.tenant_id', ..., true)`), inside `up(label, v2Id, fn)` (try/catch + counters). One bad row can't sink the batch.

### 7.5 Fee auto-seeding

`.../v2Ingest.ts:375-403`:

```ts
const visaAccepted = dump.leadCourses.filter(
  (lc) => leadCourseStateEnum(lc.stateV2, lc.state) === 'visa_accepted' && lc.startDate,
);
for (const lc of visaAccepted) {
  const leadId = leadMap.get(lc.leadId);
  const course = dump.courses.find((c) => c.id === lc.courseId);
  const amount = decimalToMinor(course?.feeAmount ?? null, course?.feeCurrency ?? env.V2_INGEST_DEFAULT_CURRENCY);
  if (!leadId || amount == null || !lc.startDate) continue;
  // createMany skipDuplicates=true → idempotent
  ...
}
```

Rules:
- Only seeds when the lead-course is **visa-accepted** AND has a `startDate` (needed to anchor `due_on`).
- Only seeds when the course has a `feeAmount` (else skip — no amount, no fee row).
- One row per visa-accepted lead-course, `session_label = "<course.name> — Session 1"` (or `"V2 session fee"` if course name missing).
- Currency: `course.feeCurrency ?? V2_INGEST_DEFAULT_CURRENCY` (default NPR), 3-char upper.
- Status: `SCHEDULED`, `seeded_from_v2: true`.
- Idempotent via `createMany({ skipDuplicates: true })` — re-runs don't create duplicates; the `crm_lead_fees_seed_uq` unique index enforces this at the DB level too.
- SPVT-owned; never overwritten by later syncs. Local edits (mark paid, change amount, add notes) survive every future sync.

### 7.6 Idempotency + concurrency

`triggerSync` wraps in `runJob('v2.ingest', { ttlSec: 30 * 60 }, ...)`. `runJob` (`apps/backend/src/jobs/runner.ts:93-240`) acquires a Postgres advisory lock; if another replica or another manual trigger already holds it, the current pass records a `SKIPPED_LOCKED` `JobRun` and returns. The controller surfaces this to the UI as `status: 'ALREADY_RUNNING'`.

### 7.7 TLS + read-only assertion

Connection details in `apps/backend/src/integrations/v2-mis/pool.ts:34-79`:
- Strips any `sslmode=` from the URL, then applies the explicit `ssl` option (avoids the `pg` library preferring the URL param).
- If `V2_MIS_DATABASE_CA` is set (inline PEM or a file path), uses `{ ca, rejectUnauthorized: true }` — finance-grade verified TLS.
- Otherwise, warns loudly and falls back to `{ rejectUnauthorized: false }` (encrypted-but-unverified, dev only).
- `assertV2ReadOnly()` (`.../pool.ts:88-117`) runs once per process, verifies `pg_roles.rolsuper = false` and no INSERT privilege on `"Lead"`. Logs a loud warning if the role can write.

---

## 8. Security

### 8.1 Authentication

- **RS256 JWT** with JWKS-published `kid` (`apps/backend/src/shared/jwt.ts`).
- Access-token TTL: 900s (15 min) default (`ACCESS_TOKEN_TTL_SECONDS`).
- Refresh-token TTL: 604800s (7 days) default (`REFRESH_TOKEN_TTL_SECONDS`).
- Refresh tokens are **single-use rotating with reuse detection** — replaying an already-rotated token revokes the whole token family as suspected theft (see `apps/frontend/lib/api.ts:147-165` for the FE single-flight guard that avoids accidentally triggering it).
- Refresh delivered as an **httpOnly cookie**, access-token held **in memory only** (`apps/frontend/lib/api.ts:11-24`) — XSS cannot lift it.
- Idle timeout — refresh rejected if `RefreshToken.last_used_at < now - IDLE_TIMEOUT_MIN` (default 30 min, OWASP-compliant).
- Bcrypt for password hashes.
- Account lockout: 5 failed logins → locked_until 15 min.
- Rate limits: 5/min/IP on `authLimiter`, 600/min global.
- **HIBP integration** — password change refuses breached passwords; fail-closed in production, fail-open in dev (`env.ts:143-155`).

### 8.2 JWT key rotation

Graceful three-slot keyset (`.../jwt.ts:21-59`, runbook `infra/docs/runbooks/jwt-key-rotation.md`):
- `PRIMARY` — full keypair, signs + verifies.
- `NEXT` — public half in JWKS + accepted on verify; not used for signing until promoted.
- `PREV` — public half of retired key; accepted on verify until refresh TTL elapses.

### 8.3 MFA

TOTP-based (RFC 6238); enrolment returns 10 single-use recovery codes stored as sha256 hashes in `User.mfa_recovery_hashes` (`schema.prisma:162-167`). Optional per-tenant policy `require_mfa_for_admins` forces every admin to enrol before acting on peer accounts.

Step-up: all destructive user-mutation routes (PATCH/DELETE user, reset-password, revoke-sessions, admin-disable-MFA) demand a fresh `X-MFA-Code` header per request (60s replay window).

### 8.4 Envelope encryption

- **KEK** (Key Encryption Key) — 32 bytes, held by KMS: `local` (default; `KMS_KEK_BASE64`), `aws`, `gcp`, `vault`. Production forbids `local` unless `KMS_LOCAL_OK=true` is set explicitly.
- **DEK** (Data Encryption Key) — per-record; encrypts sensitive columns (passport number, sponsor income, MFA secret, `mfa_secret_enc`) with AES-256-GCM, then the DEK itself is encrypted with the KEK and stored alongside the ciphertext.
- Losing the KEK = losing every envelope-encrypted column (`README.md:202`).

### 8.5 Auxiliary secrets

Distinct from JWT + KMS keys so rotations don't cascade:

| Secret | Purpose | Required in prod? |
|---|---|---|
| `REFRESH_TOKEN_PEPPER` | HMAC pepper on `refresh_tokens.token_hash` | Yes |
| `LOG_HMAC_KEY_BASE64` | HMAC key for ip_hash / ua_hash / email_hash correlation | Yes |
| `CORRELATION_HMAC_KEY` | Legacy hex spelling; ignored if `LOG_HMAC_KEY_BASE64` set | Optional |
| `METRICS_TOKEN` | Bearer guarding `GET /metrics` | Yes for scraper access |
| `RESEND_WEBHOOK_SECRET` | Svix HMAC for `/webhooks/*` | Yes (or backend refuses to boot) |
| `SEED_ADMIN_PASSWORD` | First-boot admin | Yes |

### 8.6 RLS + hash-chain audit

- Tenant isolation at the DB layer, not the app layer (`apps/backend/prisma/migrations/20991231235959_init_rls_and_triggers/migration.sql:14-49`).
- Runtime role assertion at boot refuses to start in production on a BYPASSRLS role (`apps/backend/src/config/db.ts:69-102`).
- Audit-log rows are UPDATE/DELETE-blocked at the DB (`.../20991231235959_init_rls_and_triggers/migration.sql:70-78`) and hash-chained SHA-256 per tenant (`.../migration.sql:82-116`) — computed at both app and DB layers (defence in depth). Nightly cron folds the tip into `audit_anchors` (Merkle root) which is meant to be WORM-replicated externally.
- Every mutating request writes an audit row via `writeAudit(...)` — request id, actor id, entity, before/after JSON (envelope-encrypted).

### 8.7 Transport + headers

- Helmet CSP in production: `default-src 'none'`, `script-src 'self'`, no unsafe-inline for scripts, no eval, `frame-ancestors 'none'` (`apps/backend/src/app.ts:126-140`).
- HSTS gated on `req.secure || production` (`.../security.ts`) so a dev box never accidentally pins `Strict-Transport-Security`.
- CORS allow-list (comma-separated `CORS_ORIGIN`), credentials true, maxAge 600.
- CSRF: `sameSite=lax` on the refresh cookie + Origin allow-list on cookie-bearing endpoints (`originGuard`).
- CSP violation reports → `/api/v1/csp` (self-rate-limited).

### 8.8 Uploads

Files go through **MIME-sniff → ClamAV (fail-closed) → envelope-encrypt-at-rest → signed download URL**. If ClamAV isn't reachable, uploads land `av_status=ERROR` and refuse to serve — safe default.

---

## 9. Deployment

Target: DigitalOcean App Platform + managed Postgres, same VPC/region for private V2 networking. Grounded in `.do/app.yaml` (lines 1-159).

### 9.1 Component breakdown

| Component | Kind | Command | Purpose |
|---|---|---|---|
| `spvt-db` | Managed Postgres 16 | (managed) | App-owned database (`region: blr`). |
| `migrate` | PRE_DEPLOY job | `pnpm --filter backend prisma:migrate:deploy` | Runs `prisma migrate deploy` **once** before new instances go live. Uses `DATABASE_MIGRATE_URL` (owner role) for DDL. |
| `backend` | Service, `basic-xs` | `pnpm --filter backend start` | Node.js API on port 4000. `instance_count: 1` (see caveat). Health check: `/api/v1/health/livez`. |
| `frontend` | Service, `basic-xs` | `pnpm --filter frontend start` | Next.js on port 3001. Health check: `/`. |

### 9.2 Required environment (backend)

Full list from `.do/app.yaml:65-142`:

| Var | Type | Notes |
|---|---|---|
| `NODE_ENV` | value=production | Build+runtime. |
| `DATABASE_URL` | SECRET | Runtime role — MUST be `spv_app` (NOSUPERUSER, NOBYPASSRLS). Fails boot otherwise. |
| `DATABASE_MIGRATE_URL` | SECRET | Owner/admin role. Same DB as `DATABASE_URL`. |
| `REDIS_URL` | value=`redis://localhost:6379` | Dummy placeholder — schema requires the URL shape; single-replica falls back to in-process. |
| `SPV_ALLOW_SINGLE_REPLICA` | value=`true` | Acknowledges the single-instance step-up MFA state. |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | SECRET | Bootstrap admin on first boot. |
| `CORS_ORIGIN` | value=`${frontend.PUBLIC_URL}` | No default — boot fails without it. |
| `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` / `JWT_KID` | SECRET | RS256 PEM (single-line with literal `\n`). |
| `JWT_ISSUER` / `JWT_AUDIENCE` | value | e.g. `https://spvt.example.com` / `spvt-api`. |
| `REFRESH_TOKEN_PEPPER` | SECRET | `openssl rand -hex 32`. |
| `LOG_HMAC_KEY_BASE64` | SECRET | `openssl rand -base64 32`. |
| `RESEND_WEBHOOK_SECRET` | SECRET | Boot fails without. |
| `METRICS_TOKEN` | SECRET | `openssl rand -hex 24`. |
| `KMS_PROVIDER` | value=`local` | (Switch to `aws`/`gcp` for finance-grade.) |
| `KMS_LOCAL_OK` | value=`true` | Acknowledgement of local KMS in prod. |
| `KMS_KEK_BASE64` | SECRET | `openssl rand -base64 32`. |
| `EMAIL_PROVIDER` | value=`log` | (Switch to `resend` + `RESEND_API_KEY` for real delivery.) |
| `EMAIL_FROM` | value | Verified sender domain when using Resend. |
| `STORAGE_DRIVER` | value=`s3` | App Platform fs is ephemeral. |
| `S3_ENDPOINT` / `S3_REGION` / `S3_BUCKET` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | SECRET / value | DO Spaces credentials. |
| `V2_MIS_DATABASE_URL` | SECRET | `postgresql://spv_ro_ingest:...@<private-host>:25060/defaultdb` |
| `V2_MIS_DATABASE_SSL` | value=`true` | |
| `V2_MIS_DATABASE_CA` | SECRET | DO CA bundle for verified TLS. |
| `V2_MIS_ASSERT_READONLY` | value=`true` | |
| `V2_INGEST_ENABLED` | value=`true` | |
| `V2_INGEST_TENANT_ID` | SECRET | UUID of the SPVT tenant that owns the mirrored data. |
| `V2_INGEST_DEFAULT_CURRENCY` | value=`NPR` | |
| `SENTRY_DSN` | SECRET | Errors + traces. |
| `SENTRY_TRACES_SAMPLE_RATE` | value=`0.05` | |

### 9.3 Required environment (frontend)

`.do/app.yaml:154-158`:

| Var | Scope | Notes |
|---|---|---|
| `NODE_ENV` | RUN_AND_BUILD_TIME | `production` |
| `NEXT_PUBLIC_API_BASE_URL` | RUN_AND_BUILD_TIME | `${backend.PUBLIC_URL}/api/v1` — baked into the bundle at build time. |
| `NEXT_PUBLIC_APP_NAME` | RUN_AND_BUILD_TIME | Display name (`Student Post-Visa Tracker`). |

### 9.4 Deploy flow

1. `git push origin main` → GitHub → DO `deploy_on_push: true`.
2. DO fires the `migrate` PRE_DEPLOY job.
3. Job runs `pnpm install --frozen-lockfile && … && pnpm --filter backend prisma:migrate:deploy` on the owner role. Fails the deploy if a migration errors — no partial rollout.
4. New backend + frontend containers built (`docker build` per-app Dockerfile).
5. Health checks (`/api/v1/health/livez` for backend, `/` for frontend) must pass for the new instances to receive traffic.
6. Old instances drained. New instances live.

### 9.5 P0 items before first production run

From `DEPLOYMENT-READINESS.md:13-18`:

1. **Rotate `doadmin`; create `spv_ro_ingest`.** Dev holds a DO superuser in `.env` (gitignored + untracked, but still). Create the read-only role using SQL from `apps/backend/.env.example:135-146`, point `V2_MIS_DATABASE_URL` at it, then rotate `doadmin`.
2. **Set every `type: SECRET` in `.do/app.yaml`** in DO dashboard.
3. **Document storage on App Platform is ephemeral** — `STORAGE_DRIVER=local` loses uploads on redeploy. Either implement the S3 driver + DO Spaces, or deploy on a persistent-volume host.
4. **ClamAV** — App Platform has no clamd; every upload lands `av_status=ERROR`. Either run clamav as a worker, accept docs disabled, or fail-closed as-is.

---

## 10. Operational runbook

Full runbooks live under `infra/docs/runbooks/` (`README.md:262-283`). Common tasks:

### 10.1 Rotate a secret (e.g. `REFRESH_TOKEN_PEPPER`)

1. Generate: `openssl rand -hex 32`.
2. Update the value in DO Dashboard → App → Settings → Environment.
3. Redeploy the backend component.
4. Every issued refresh token becomes unusable (hash pepper mismatch) — all users must re-login. Communicate ahead.

### 10.2 Run the seed manually (first-boot or extra tenant)

1. From DO Console → App → Backend service → Console.
2. `pnpm --filter backend prisma:seed`.
3. Idempotent: existing users/tenants are skipped. Grounded in the seed fix commit `9eaa798`: "wrap tenant and admin user creation in RLS-aware transactions" — the seed now sets the `app.tenant_id` GUC before writing.

### 10.3 Manually trigger V2 sync

**UI**: sidebar → Leads → **Sync from V2** (admin only).

**API**: `POST /api/v1/leads/sync` with a valid admin JWT.

**Console** (if the API is unreachable): from the backend container, `node -e "import('./dist/jobs/v2Ingest.js').then(m => m.runV2IngestPass()).then(console.log)"` — but ensure `V2_INGEST_ENABLED=true` and `V2_INGEST_TENANT_ID` are set.

### 10.4 Read runtime logs (V2, error patterns)

DO Dashboard → App → Backend service → Runtime Logs.

Filter examples:
- `v2.ingest` — sync lifecycle.
- `v2.ingest row failed` — per-row failures with entity + `v2Id`.
- `v2.ingest fee seed failed` — fee auto-seed failures.
- `v2-mis pool error` — connection issues.
- `v2-mis: connected role has WRITE capability` — you're using a too-privileged role.
- `rls-role-assert: runtime DB role is superuser/BYPASSRLS` — RLS is disabled; fix `DATABASE_URL`.

### 10.5 Read audit logs

`GET /api/v1/audit-logs?...` with an admin JWT (`apps/backend/src/modules/audit/routes.ts:52`). Filters: `actor_id`, `entity_type`, `action`, `since`, `until`. UI at `/audit`.

Verify chain: `GET /api/v1/audit-logs/verify` recomputes per-tenant SHA-256 chain. `broken_count > 0` = tampering suspected. Automate as a daily cron externally.

### 10.6 Password reset for a locked user (admin path)

1. Sidebar → **Admin → Users** → click user → **Reset password** (admin must have MFA enrolled + supply `X-MFA-Code`).
2. Or via API: `POST /api/v1/users/:id/reset-password` (`apps/backend/src/modules/users/users.routes.ts:48-55`).
3. To unlock without a reset, `PATCH /users/:id` and clear `locked_until` (`apps/backend/prisma/schema.prisma:158`).

### 10.7 Add a new admin user

1. Sidebar → **Admin → Users → Add user**.
2. Fill email, given/family name, role = `ADMIN`.
3. `POST /api/v1/users` (admin only) — creates user with a temp password + reset link.
4. First login: user resets password, enrols MFA if `require_mfa_for_admins=true`.

### 10.8 Force-disable an admin's MFA (unbrick)

For an admin who lost BOTH the TOTP device AND all recovery codes:

1. From another admin (must have MFA), sidebar → **Admin → Users → [user] → Disable MFA**.
2. Endpoint: `POST /api/v1/users/:id/mfa/disable` (`apps/backend/src/modules/users/users.routes.ts:68-75`).
3. Requires `requireMfa` (fresh X-MFA-Code from the acting admin).
4. Without this route, the only recovery is direct psql access.

---

## 11. API endpoints

Base path: `/api/v1`. Auth = Bearer JWT unless noted "public".

### 11.1 Public / discovery

| Method | Path | Purpose |
|---|---|---|
| GET | `/health/livez` | Liveness probe. |
| GET | `/health/readyz` | Readiness (DB + Redis). |
| GET | `/health/version` | Version. |
| GET | `/version` | Alt version endpoint. |
| GET | `/.well-known/jwks.json` | JWKS. |
| GET | `/docs` | Swagger UI (dev only). |
| GET | `/openapi.json` | OpenAPI spec (dev only). |
| GET | `/metrics` | Prometheus, bearer-guarded. |
| POST | `/csp/report` | CSP violation sink. |
| POST | `/security/error-report` | FE error-boundary sink. |
| POST/GET | `/public/*` | Unauthenticated DSAR intake + operational status. |

### 11.2 Auth

`apps/backend/src/modules/auth/auth.routes.ts`

| Method | Path | Role |
|---|---|---|
| POST | `/auth/login` | public (rate-limited 5/min) |
| POST | `/auth/refresh` | public (cookie) |
| POST | `/auth/logout` | public (cookie) |
| GET | `/auth/me` | authed |
| PATCH | `/auth/me` | authed + step-up MFA |
| POST | `/auth/change-password` | authed + step-up MFA |
| POST | `/auth/password/reset-request` | public |
| POST | `/auth/password/reset-confirm` | public |
| POST | `/auth/mfa/setup` | authed + current password |
| POST | `/auth/mfa/verify` | authed |
| POST | `/auth/mfa/disable` | authed + current password |
| GET | `/auth/jwks` | public |

### 11.3 Users (`apps/backend/src/modules/users/users.routes.ts`)

All require admin. Mutations require MFA-enrolled admin + `X-MFA-Code`.

| Method | Path | Notes |
|---|---|---|
| GET | `/users` | list |
| POST | `/users` | create |
| GET | `/users/:id` | read |
| PATCH | `/users/:id` | update, MFA |
| DELETE | `/users/:id` | soft-delete, MFA |
| POST | `/users/:id/reset-password` | admin-issued reset |
| POST | `/users/:id/sessions/revoke` | revoke every refresh, MFA |
| POST | `/users/:id/mfa/disable` | force-disable, MFA |

### 11.4 Tenants (`.../tenants/routes.ts`)

| Method | Path | Role |
|---|---|---|
| GET | `/tenants/me` | admin |
| PATCH | `/tenants/me` | admin |

### 11.5 Students (`.../students/students.routes.ts`)

| Method | Path | Role |
|---|---|---|
| GET | `/students` | any |
| POST | `/students` | ADMIN, COUNSELLOR |
| GET | `/students/:id` | ownership |
| PATCH | `/students/:id` | ADMIN, COUNSELLOR + ownership |
| DELETE | `/students/:id` | ADMIN |
| GET | `/students/:id/timeline` | ownership |
| POST | `/students/:id/transitions` | ADMIN, COUNSELLOR + ownership |
| GET | `/students/:id/completeness` | ownership |
| GET/POST/PATCH/DELETE | `/students/:studentId/{contacts,visas,identifications,dependents,employment,qualifications,language-tests,travel,accommodations,insurances,finance,compliance,engagements,regulator-ids,sponsorships,enrollments,documents,messages,addresses}` | Sub-resources; ownership via child |

### 11.6 CRM leads (`.../crm-leads/crm-leads.routes.ts`)

| Method | Path | Role |
|---|---|---|
| GET | `/leads` | any |
| GET | `/leads/applications` | any |
| GET | `/leads/finance-summary` | any |
| GET | `/leads/institutions-report` | any |
| GET | `/leads/courses-report` | any |
| POST | `/leads/sync` | ADMIN (rate-limited) |
| GET | `/leads/:id` | any |
| PATCH | `/leads/:id` | ADMIN, COUNSELLOR (If-Match) |
| POST | `/leads/:id/convert` | ADMIN (Idempotency-Key) |
| POST | `/leads/:id/fees` | ADMIN, COUNSELLOR |
| PATCH | `/leads/:id/fees/:feeId` | ADMIN, COUNSELLOR (If-Match) |
| POST | `/leads/:id/fees/:feeId/pay` | ADMIN, COUNSELLOR |
| POST | `/leads/:id/fees/:feeId/waive` | ADMIN, COUNSELLOR |
| DELETE | `/leads/:id/fees/:feeId` | ADMIN, COUNSELLOR |

### 11.7 Stages (`.../stages/stages.routes.ts`)

| Method | Path | Role |
|---|---|---|
| GET | `/stages` | any |
| POST | `/stages` | ADMIN |
| PATCH | `/stages/:id` | ADMIN |
| DELETE | `/stages/:id` | ADMIN |
| GET | `/stages/transitions` | any |
| POST | `/stages/transitions` | ADMIN |
| DELETE | `/stages/transitions/:id` | ADMIN |

### 11.8 Institutions (`.../institutions/institutions.routes.ts`)

CRUD `/institutions` + nested identifiers, accreditations, contacts, campuses. Writes require ADMIN/COUNSELLOR; deletes require ADMIN.

### 11.9 Programs (`.../programs/programs.routes.ts`)

CRUD `/programs` + nested intakes, requirements, modules, fees.

### 11.10 Documents (`.../documents/documents.routes.ts`)

| Method | Path | Role |
|---|---|---|
| GET | `/students/:studentId/documents` | ownership |
| POST | `/students/:studentId/documents` | ADMIN, COUNSELLOR |
| GET | `/documents/:id` / `/documents/:id/download` | ownership |
| PATCH | `/documents/:id` | ADMIN, COUNSELLOR |
| DELETE | `/documents/:id` | ADMIN |

### 11.11 Commissions (`.../commissions/routes.ts`)

`GET /commissions`, `/summary`, `/:id`; state transitions (`/:id/claim`, `/verify`, `/pay`, `/reconcile`, `/dispute`, `/waive`); PATCH.

### 11.12 Comms (`.../comms/routes.ts`)

- Templates: `messageTemplateRouter` (`/message-templates`) CRUD, list.
- Student-scoped: `/students/:studentId/messages` GET/POST.
- Threads: `/comms/threads`.
- Inbox: `/inbox/messages`, `/inbox/messages/read-all`, `/inbox/messages/:id/read`.
- Admin outbox: `/admin/comms/outbox/{health,trend,metrics,messages,requeue-all,:id/requeue}`.
- Unsubscribe: `/comms/unsubscribe` (public, HMAC).
- Webhooks: `/webhooks/*` (Resend, svix HMAC).

### 11.13 Reminders (`.../reminders/routes.ts`)

CRUD reminders; list, dismiss, snooze.

### 11.14 Expiries (`.../expiries/routes.ts`)

Read-only union across visa, passport, insurance, document, regulator-id.

### 11.15 Billing (`.../billing/billing.routes.ts`)

Gated by `tenant.billing_enabled`. Fee plans, installments, payments, adjustments, refunds, credits — many endpoints; ADMIN or ADMIN+COUNSELLOR as appropriate.

### 11.16 Audit (`.../audit/routes.ts`)

Admin-only.

| Method | Path | Notes |
|---|---|---|
| GET | `/audit-logs` | list (paginated) |
| GET | `/audit-logs/:id` | detail |
| GET | `/audit-logs/verify` | recompute + return `broken_count` (rate-limited) |
| GET | `/audit-logs/anchors` | Merkle roots |

### 11.17 Reports (`.../reports/routes.ts`, admin-only + heavy-read rate limit)

- `GET /reports/visa-funnel`
- `GET /reports/counsellor-load`
- `GET /reports/commission-revenue`
- `GET /reports/refund-rate`
- `GET /reports/outstanding-by-age`

### 11.18 Dashboard (`.../dashboard/dashboard.routes.ts`)

`/dashboard/{summary,finance-summary,expiries,sla-breaches,engagement-at-risk,onboarding}`.

### 11.19 Jobs (`.../jobs/routes.ts`)

`GET /jobs/recent?jobName=v2.ingest&limit=1` — recent JobRun rows.

### 11.20 GDPR / compliance

- Consents: `/consents` CRUD + `/:id/revoke`.
- DSAR: `/dsar` CRUD, plus public intake at `/public/*`.
- Breach: `/breach-incidents` (admin).
- Sub-processors: `/sub-processors` (admin).
- ROPA (Records of Processing Activities): `/admin/ropa` (admin).

### 11.21 Admin diagnostics

- `/admin/idempotency/*` — sweep stuck PENDING rows.
- `/admin/v2-diagnostics/entity-counts` — histogram over V2 raw counts (added in commit `307b00d`).
- `/admin/v2-diagnostics/state-histogram` — histogram of free-text V2 state values (added in commit `611c945`).

### 11.22 Attributes / tags / notes / saved-views

Generic multi-entity tagging + custom attributes + note thread + saved query views.

### 11.23 Interview prep

`/interview-questions`, `/interview-attempts`, public `/public/interview-prep`.

---

## 12. Frontend architecture

- **Framework**: Next.js 14 App Router (`apps/frontend/app/`).
- **UI**: MUI v5 + Emotion + custom components in `apps/frontend/components/`.
- **State/data**: TanStack React Query for server state (queries live in `apps/frontend/lib/queries.ts` and per-feature under `apps/frontend/features/`).
- **HTTP**: Axios with two interceptors (`apps/frontend/lib/api.ts`):
  1. Attach `Authorization: Bearer <access>` (token held in memory).
  2. Auto-inject `Idempotency-Key: <uuid>` on POST/PATCH/PUT/DELETE.
  3. On response 401 (except MFA step-up sub-codes `mfa_required`/`mfa_invalid`/`mfa_replay`), perform a **single-flight silent refresh** via `refreshSession()` and retry once.
- **Auth context** (`apps/frontend/lib/auth.tsx`):
  - Provides `user`, `accessToken`, `isLoading`, `login`, `logout`, `refresh`.
  - Access token in memory only; refresh cookie is httpOnly. `user` snapshot mirrored to `sessionStorage` so a page reload doesn't flash a login screen while the silent refresh happens.
  - Broadcasts a `CustomEvent('auth:logout')` on refresh failure; the provider clears local state + TanStack cache.
- **Router shell**: `AppShell` (`apps/frontend/components/AppShell.tsx`) — persistent drawer (md+), temporary drawer (mobile), AppBar with notifications bell + theme switcher + profile menu. Locale-aware (`ar` = RTL right-anchored drawer). Command palette + keyboard shortcuts globally mounted.
- **i18n**: `next-intl` with `en`, `ar`, `hi`, `ne` message packs (`apps/frontend/messages/`).
- **Theming**: MUI theme with light/dark/system modes (`apps/frontend/theme/`).
- **CSP-compliant**: no inline scripts; error boundary reports to `/api/v1/security/error-report`.

Directory map:

```
apps/frontend/
├── app/
│   ├── (app)/          # authed routes with AppShell
│   │   ├── DashboardClient.tsx
│   │   ├── students/[id]/
│   │   ├── leads/[id]/
│   │   ├── inbox/tabs/{tasks,expiring,messages}
│   │   └── ...
│   ├── (auth)/          # login, forgot-password, reset-password
│   ├── (public)/        # legal, DSAR intake, status
│   └── (legal)/         # terms, privacy, support
├── components/          # AppShell, DataTable, ErrorState, StatusChip, ...
├── features/            # feature-scoped queries + dialogs
├── lib/                 # api, auth, format, queries, helpers
├── messages/            # en, ar, hi, ne
└── theme/
```

---

## 13. Known caveats + gotchas

### 13.1 V2 dual-writes `state` + `stateV2`

`.../queries.ts:60-72`: V2's `LeadCourses` writes both a legacy free-text `state` (well populated, ~301 rows) and a typed enum `stateV2` (sparsely backfilled, ~88 rows). SPVT unions both on the visa-accepted scope query so it matches V2's own admin count. `Application.state` is a lifecycle flag (ACTIVE/completed) and MUST NOT be used as a funnel indicator.

### 13.2 335 lead-courses vs 9 applications

Per commit `e3a1e1b`: "lead_courses_visa_accepted: 335; applications_total: 9; applications_matching_va: 2". The `/leads/applications` endpoint now drives off `crm_lead_courses` (state_v2='visa_accepted') and enriches with `crm_application` via `(v2_lead_id, v2_course_id)` when a matching row exists. If the app row is absent, `intake_key` / `application_state` / `next_fee_due` fall back to null but the lead-course id is still returned.

### 13.3 Fee auto-seed requires course.feeAmount + lead-course.startDate

`.../v2Ingest.ts:378-403`: A visa-accepted lead-course only produces a `CrmLeadFee` row if BOTH the course has a `feeAmount` AND the lead-course has a `startDate` (to anchor `due_on`). If your fee-seed count is 0, check `crm_courses.fee_amount_minor` (nullable) and `crm_lead_courses.start_date` for the visa-accepted rows — one or both is null.

### 13.4 RLS blocks raw Prisma calls outside `tenantContext`

`prisma.<model>.findMany()` (without `req.db`) issues a query on the connection pool without `app.tenant_id` set → RLS blocks all rows. If a route ever needs cross-tenant reads it must go through `prismaAdmin` (superuser, BYPASSRLS) and only for authentication primitives (login lookup by email, refresh by token_hash, etc.) — see `apps/backend/src/config/db.ts:22-50`. Recent bugs of the form "`GET /tenants/me` returned 404" were traced to this exact pattern; fix was to wrap in a scoped tx that sets `app.tenant_id` GUC (commit `10c0ff0`).

### 13.5 `spv_lead_overlay` / `spv_lead_fees` are reserved

Present in schema but not yet wired (`DEPLOYMENT-READINESS.md:29-30`). They're the island tables for the "read V2 live" mode (`SPV_READ_MODE=live`). Keep `SPV_READ_MODE=mirror` (default) until the live path is verified.

### 13.6 Nav label "Leads" = visa-accepted applications

Minor IA quirk (`DEPLOYMENT-READINESS.md:28`). Page heading says "Applications"; sidebar says "Leads". Both are the same route (`/leads`).

### 13.7 Frontend `output: standalone` build fails on Windows locally

Symlink perm issue — `next build` errors with EPERM on Windows dev boxes (`DEPLOYMENT-READINESS.md:26`). Fine on the Linux deploy target. The run command is `next start` so standalone isn't required for prod either.

### 13.8 Single-replica step-up MFA state

`instance_count: 1` in `.do/app.yaml:58`. Scaling requires Redis for MFA state + document download nonce store + some rate-limits (`DEPLOYMENT-READINESS.md:21`). `SPV_ALLOW_SINGLE_REPLICA=true` acknowledges the constraint.

### 13.9 Dev vs prod schema application

Dev uses `prisma db push` (no RLS applied). Prod uses `prisma migrate deploy` via the `migrate` PRE_DEPLOY job — RLS + triggers only apply in prod (`DEPLOYMENT-READINESS.md:25`).

### 13.10 Two "Institution" model families

- `Institution` = consultancy academic catalog (managed by admins).
- `CrmInstitution` = V2 mirror.

They aren't linked and don't share rows. The Institutions sidebar item points at the consultancy catalog; the CRM catalog page (`/leads/institutions`) reads `crm_institutions`.

### 13.11 Recent hotfixes (last 20 commits, `git log --oneline -20`)

Notable production issues resolved:
- `10c0ff0` — panel-review followups: deterministic app pick, zod contract nullable, tenants scoped-tx (defense-in-depth RLS).
- `2e2f658` — `/tenants/me` used the scoped Prisma client, RLS blocked it; switched to `prismaAdmin` (later refactored in `10c0ff0`).
- `e3a1e1b` — pipeline drove off `crm_applications` and hid ~333 work-queue items; rewrote to drive off `crm_lead_courses`.
- `9eaa798` — seed script didn't set `app.tenant_id` GUC → RLS blocked writes; wrapped in tenant-scoped tx.
- `e21c2b4` — all auth-time DB ops now use `adminDb` (bypasses RLS as intended).
- `c20061d` — Redis auto-reconnect on failed initial connect caused boot-loop; disabled.
- `611a23e` — `DATABASE_MIGRATE_URL` was `value:` not `SECRET`, resolved to `defaultdb` (wrong DB); fixed to SECRET.
- `3b2b8b6` — missing backend env vars caused deploy failures; added `REDIS_URL`, `SEED_ADMIN_*`.

---

## 14. Troubleshooting

### 14.1 "self-signed certificate in certificate chain" from V2

The V2 pool logs this when TLS is enabled but the CA can't be verified. Fix:

1. Fetch the DigitalOcean CA bundle for the V2 DB from the DO console (Database → Overview → Download CA).
2. Set `V2_MIS_DATABASE_CA` to either the inline PEM (including `-----BEGIN CERTIFICATE-----`) or a file path.
3. Redeploy. Log should show `v2-mis: TLS with CA verification enabled (rejectUnauthorized:true)` (`.../pool.ts:53`).
4. In dev only, leaving `V2_MIS_DATABASE_CA` unset works but logs `v2-mis: TLS enabled WITHOUT CA verification` — never ship this to prod.

### 14.2 "Connection terminated due to connection timeout" to V2

The `pg` pool `connectionTimeoutMillis: 10_000` (`.../pool.ts:68`) trips when the network can't reach V2. Root causes:

1. **Not in the same VPC** — App Platform outbound IP isn't allowlisted. Fix by moving both DBs into one VPC and using the **PRIVATE** host of V2 (`.../.env.example:143-145`).
2. **Trusted Sources not configured** — if using the public host, add the App Platform egress IP to V2's Trusted Sources.
3. **Firewall / suspended DB** — check DO console for the V2 cluster status.

### 14.3 401 on API calls (token expired)

Expected first-time behaviour. The axios response interceptor (`apps/frontend/lib/api.ts:233-273`) silently refreshes the access token once via the httpOnly cookie and retries the original request. If the refresh cookie itself is missing or expired the interceptor broadcasts `auth:logout` and the user is redirected to `/login`.

If the 401 doesn't retry, check:
1. `CORS_ORIGIN` includes the frontend origin exactly (comma-separated OK).
2. Cookies are being sent (`credentials: true` on axios instance + browser not blocking third-party cookies).
3. `Origin` header matches allow-list (`originGuard` rejects mismatches with 401).
4. The response body `code` is not `mfa_required` / `mfa_invalid` / `mfa_replay` — those are step-up 401s that the caller must handle by supplying `X-MFA-Code`.

### 14.4 Empty leads page

Possible causes:
1. **No successful V2 sync yet** — click **Sync from V2** (admin). Watch the last-run chip.
2. **Wrong tenant** — `V2_INGEST_TENANT_ID` points at a different tenant than the one you're logged into. Fix env var + resync.
3. **V2 has no visa-accepted leads** — verify with `/admin/v2-diagnostics/entity-counts` or in V2 directly.
4. **RLS is silently blocking** — if `DATABASE_URL` is a superuser, the runtime role assertion should have refused to boot in production; check backend logs for `rls-role-assert: FATAL`.

### 14.5 Fee seed count = 0

`.../v2Ingest.ts:376-380`. The seed loop only fires for visa-accepted lead-courses where BOTH conditions hold:
- `course.feeAmount` is non-null (V2 `Course.feeAmount`).
- `lc.startDate` is non-null (V2 `LeadCourses.startDate`).

Verify with:

```sql
SELECT lc.state, lc.state_v2, lc.start_date, c.fee_amount_minor, c.fee_currency
  FROM crm_lead_courses lc JOIN crm_courses c ON c.id = lc.course_id
 WHERE lc.state_v2 = 'visa_accepted' AND lc.deleted_at IS NULL;
```

Rows where either is null won't produce a seeded fee. Existing seeded fees are never re-created (idempotent via `createMany({ skipDuplicates: true })`).

### 14.6 "A sync is already running." toast

Not an error — the advisory lock is held by a still-running sync (or a scheduler run). Wait 30 min (the `ttlSec`) or check `/jobs/recent?jobName=v2.ingest`.

### 14.7 Backend boots then exits with `rls-role-assert: FATAL`

You've pointed `DATABASE_URL` at a superuser / BYPASSRLS role (typically DO's `doadmin`). Postgres silently skips RLS for such roles — the boot guard refuses to serve. Fix per the log message: create the `spv_app` role (SQL in `.env.example:135-146`), grant SELECT/INSERT/UPDATE/DELETE on the tenant-scoped tables, and point `DATABASE_URL` at it. Keep `DATABASE_MIGRATE_URL` on the owner.

### 14.8 "Version mismatch (have N, expected M)" on PATCH

Optimistic concurrency guard. Another user (or another tab) edited the record. Refresh, re-apply your changes, retry.

### 14.9 "If-Match required for PATCH"

The FE forgot to include the `If-Match: "<version>"` header. Every OCC-guarded resource requires it (leads, fees, ...). Frontend axios wrappers set it automatically from the last GET's ETag.

### 14.10 Audit chain shows "broken"

`GET /audit-logs/verify` returned `broken_count > 0`. Somebody bypassed the DB triggers (superuser psql session) and mutated `audit_logs`. Investigate against `pg_stat_activity` archives; the daily hash-anchor cron should have captured the last-good root — replay from there.

### 14.11 CORS preflight failing

Backend rejects the `Origin` header. Check:
1. `CORS_ORIGIN` env var — comma-separated allow-list; each origin must match scheme+host+port exactly.
2. `origin: env.CORS_ORIGIN.split(',').map((s) => s.trim())` (`apps/backend/src/app.ts:151-156`).

### 14.12 First-boot admin login fails

Root cause is typically that the seed didn't run. Check backend startup logs for the seed run, or invoke it manually (`pnpm --filter backend prisma:seed` from the container console). Fix from commit `9eaa798`: the seed now wraps tenant + admin creation in RLS-aware transactions so it works with the tightened runtime role.

---

*End of Student Post-Visa Tracker Complete Guide.*
