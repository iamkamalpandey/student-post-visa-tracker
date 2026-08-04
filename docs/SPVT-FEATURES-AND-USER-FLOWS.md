# SPVT — Feature List & User Flows

**Last verified:** 2026-08-04 against commit `f8b2826` on `main`.

**Scope of this document.** A comprehensive, code-grounded catalog of every user-facing feature in the Student Post-Visa Tracker (SPVT), plus step-by-step operational flows. Every capability listed here is verified against the current codebase (backend routes, frontend pages, middleware, service logic). No forward-looking or aspirational entries.

Companion document: [SPVT-COMPLETE-GUIDE.md](SPVT-COMPLETE-GUIDE.md) — architectural + deployment guide. Read that first for context; read this for a feature-by-feature reference.

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Roles & permission model](#2-roles--permission-model)
3. [Global controls & cross-cutting features](#3-global-controls--cross-cutting-features)
4. [Feature catalog by domain](#4-feature-catalog-by-domain)
   - 4.1 [Authentication & session](#41-authentication--session)
   - 4.2 [Dashboard & onboarding](#42-dashboard--onboarding)
   - 4.3 [CRM Leads (post-visa work queue)](#43-crm-leads-post-visa-work-queue)
   - 4.4 [Managed Students](#44-managed-students)
   - 4.5 [Student sub-resources](#45-student-sub-resources)
   - 4.6 [Documents](#46-documents)
   - 4.7 [Inbox & communications](#47-inbox--communications)
   - 4.8 [Reminders, expiries & calendar](#48-reminders-expiries--calendar)
   - 4.9 [Institutions & academic catalog](#49-institutions--academic-catalog)
   - 4.10 [Bulk imports & exports](#410-bulk-imports--exports)
   - 4.11 [Billing (school/college fees)](#411-billing-schoolcollege-fees)
   - 4.12 [Commissions & super-agents](#412-commissions--super-agents)
   - 4.13 [Reports & analytics](#413-reports--analytics)
   - 4.14 [Admin console](#414-admin-console)
   - 4.15 [Compliance suite (GDPR)](#415-compliance-suite-gdpr)
   - 4.16 [Interview prep](#416-interview-prep)
   - 4.17 [Tags, notes, saved views, custom attributes](#417-tags-notes-saved-views-custom-attributes)
   - 4.18 [Public-facing endpoints](#418-public-facing-endpoints)
   - 4.19 [Operational surface (health, metrics, jobs)](#419-operational-surface-health-metrics-jobs)
5. [User flows — step by step](#5-user-flows--step-by-step)
6. [Role-specific playbooks](#6-role-specific-playbooks)
7. [Verification checklist](#7-verification-checklist)

---

## 1. Executive summary

SPVT is a multi-tenant SaaS for consultancies tracking international students **after** visa approval. It mirrors visa-accepted leads from an external V2 MIS (TheNextMis) CRM read-only, then owns the post-visa lifecycle (fee schedules, arrival, enrollment, engagement checks, expiries, offboarding) as its own SPVT-owned data.

**Verified surface (commit `f8b2826`):**

| Layer | Count |
|---|---|
| Backend HTTP routers | 66 files ([apps/backend/src/modules/**/routes.ts](apps/backend/src/modules)) |
| Backend endpoints | ~230 (grouped in §4) |
| Frontend pages | 47 ([apps/frontend/app/**/page.tsx](apps/frontend/app)) |
| Sidebar entries | 8 primary + 1 admin + 1 billing (gated) + 5 compliance (collapsible) + 1 settings |
| Prisma models | 84 |
| Enum roles | 3 (`ADMIN`, `COUNSELLOR`, `VIEWER`) |
| Auth mechanisms | RS256 JWT (access), rotating refresh cookie, TOTP MFA, HIBP, bcrypt |
| Compliance features | RLS, audit hash-chain, envelope encryption, GDPR Art 30/33/6/28, DSAR, consent, breach register, sub-processor register |

**What SPVT does NOT do** (out of scope, factual):

- Does not manage the pre-visa application funnel — V2 MIS owns that.
- Does not accept applicant self-service today (public DSAR intake only).
- Does not process card payments — payments are recorded post-hoc; no gateway integration is wired.
- Does not chat/message externally in real time — outbound email/SMS only via async provider dispatch.
- Does not render invoices as PDFs beyond the built-in `pdf-lib` generator (no external template engine).

---

## 2. Roles & permission model

### 2.1 Role enum

Defined in [packages/zod-schemas/src/common.ts](packages/zod-schemas/src/common.ts) as `RoleEnum = z.enum(['ADMIN', 'COUNSELLOR', 'VIEWER'])`.

| Role | Intended user | Global default |
|---|---|---|
| `ADMIN` | Operator / tenant owner | Full write across the tenant. MFA gated for peer-account mutations & money-movers. |
| `COUNSELLOR` | Frontline caseworker | Read + write on **own-assigned** students/leads only. Cannot manage users, cannot approve refunds. |
| `VIEWER` | Read-only observer | Every non-GET rejected globally by middleware — regardless of route. |

### 2.2 Three-layer enforcement

Every mutating request passes through, in order:

1. **Global role guard** ([apps/backend/src/middlewares/auth.ts:63-65](apps/backend/src/middlewares/auth.ts)): if the JWT claim `role === 'VIEWER'` and the HTTP method is not in `{GET, HEAD, OPTIONS}`, the request is 403'd before any handler runs.
2. **Per-route role guard** via `requireRole('ADMIN', 'COUNSELLOR', ...)` decorator.
3. **Per-record ownership guard** via `requireStudentOwnership(paramName)` or `requireStudentOwnershipViaChild(model, paramName)` — a COUNSELLOR can only touch students where `assigned_to_id = self`. `ADMIN` bypasses the ownership check.

### 2.3 MFA step-up

Enforced by `requireMfa({enrollmentRequired?: boolean})`. When the acting user has MFA enrolled, every gated request must carry a fresh `X-MFA-Code` HTTP header (60-second replay window). Strict `{enrollmentRequired: true}` variant additionally rejects unenrolled admins (403 `mfa_enrollment_required`) — used on every money-mover and every peer-account mutation.

**Endpoints demanding MFA step-up:**

| Endpoint | Guard |
|---|---|
| `PATCH /users/:id`, `DELETE /users/:id`, `POST /users/:id/reset-password`, `POST /users/:id/sessions/revoke`, `POST /users/:id/mfa/disable` | `requireMfa({enrollmentRequired: true})` |
| `POST /billing/plans/:id/cancel`, `POST /billing/payments/:id/void`, `POST /billing/payments/:id/refunds`, `POST /billing/refunds/:id/complete`, `POST /billing/refunds/:id/fail` | `requireMfa({enrollmentRequired: true})` |
| `POST /auth/mfa/setup / verify / disable`, `PATCH /auth/me`, `POST /auth/change-password` | `requireMfa` (pass-through when caller unenrolled) |
| Any admin ROPA / consent / breach mutation | ADMIN role required (§4.15) |

### 2.4 Access matrix — feature × role

Verified against each route file. `Y = full`; `own = self-assigned records only`; `-` = forbidden; `M = MFA step-up required if enrolled`.

| Feature | ADMIN | COUNSELLOR | VIEWER |
|---|---|---|---|
| Log in, change own password, enrol MFA | Y | Y | Y |
| Dashboard KPIs (tenant-wide) | Y | own caseload | own caseload |
| View / edit any student | Y | own | own (read) |
| Create student | Y | Y | - |
| Delete student (soft) | Y | - | - |
| Advance student lifecycle stage | Y | own | - |
| View any CRM lead | Y | Y | Y |
| Assign lead / add notes / change spv_status | Y | Y | - |
| Convert CRM lead → student | Y (Idempotency-Key) | - | - |
| Add/edit/pay/waive/delete CRM lead fee | Y | Y | - |
| Run V2 sync manually | Y (rate-limited) | - | - |
| Upload document | Y | own | - |
| Download document | Y | own | own |
| Verify document | Y | own | - |
| Delete document | Y | - | - |
| Send message to student | Y | own | - |
| Manage message templates (write) | Y | - | - |
| Read inbox, mark read | Y | Y | Y |
| Reminder CRUD | Y (delete only ADMIN) | Y (except delete) | - |
| Bulk import / export | Y | export own | - |
| Institution / program CRUD | Y | Y (write) | Y (read) |
| Billing plan create/pause/resume | Y | Y | - |
| Billing plan cancel / regenerate | Y (M, Idempotency-Key) | - | - |
| Record payment | Y (Idempotency-Key) | Y (Idempotency-Key) | - |
| Void payment / issue refund | Y (M, Idempotency-Key) | - | - |
| Users CRUD, reset password, revoke sessions, force-disable MFA | Y (M) | - | - |
| Tenant settings `/tenants/me` | Y | - | - |
| Reports (`/reports/*`) | Y (heavyReadLimiter) | - | - |
| Audit log read + hash-chain verify | Y | - | - |
| DSAR: create intake | Y (Idempotency-Key) | Y (Idempotency-Key) | - |
| DSAR: list/patch/export | Y | patch only | - |
| Breach register | Y (Idempotency-Key on create) | - | - |
| Consent record create | Y | Y | - |
| Consent record read/revoke | Y | Y (own subject) | Y (own subject) |
| Sub-processor register | Y | - | - |
| ROPA (Records of Processing) | Y | - | - |
| Metrics endpoint `/metrics` | Bearer `METRICS_TOKEN` (no user auth) | - | - |
| Public DSAR intake, public status, interview-prep | anonymous | anonymous | anonymous |

---

## 3. Global controls & cross-cutting features

### 3.1 Sidebar navigation ([apps/frontend/components/AppShell.tsx:108-146](apps/frontend/components/AppShell.tsx))

- **Primary (all roles):** Dashboard, Students, Leads, Inbox, Calendar, Institutions, Courses (label key `programs`), Imports.
- **Admin section (ADMIN only):** Admin (tabbed hub → Stages, Visa Types, Users, Commissions, Reports, Exports, Catalog, Super-agents, Interview prep, Outbox, Tenants).
- **Billing (ADMIN + `tenant.billing_enabled=true`):** Billing.
- **Compliance (collapsible, ADMIN):** Audit, DSAR, Consents, Breaches, Sub-processors.
- **Settings (all):** Settings.
- **Footer:** Terms, Privacy, Support links; version + copyright year.

Sidebar is a persistent Drawer on md+ viewports; temporary Drawer on mobile. In Arabic locale (`ar`), Drawer anchor flips to right (RTL).

### 3.2 App-bar controls ([AppShell.tsx](apps/frontend/components/AppShell.tsx))

- **NotificationsBell** — shows unread IN_APP message count; opens a drawer listing latest messages.
- **ThemeSwitcher** — light / dark / system (persists via provider).
- **ProfileMenu** — avatar with initials; menu shows display name, email, role chip; links to Settings, Terms, Privacy, Support; Sign-out CTA.
- **CommandPalette** — global `Cmd/Ctrl+K` quick nav.
- **KeyboardShortcuts** — bindings surfaced via `?` help overlay.

### 3.3 Localization

Locales: `en`, `ar`, `hi`, `ne` ([apps/frontend/messages/](apps/frontend/messages)). Locale switching handled by `set-locale` server action; persisted in a cookie. RTL layout activated for `ar`. Applies to sidebar labels, dialog copy, dashboard tiles — some deep pages still fall back to English (see [SPVT-QA-REMEDIATION.md](docs/SPVT-QA-REMEDIATION.md) §Deferred).

### 3.4 Idempotency-Key middleware

Frontend axios interceptor ([apps/frontend/lib/api.ts:117](apps/frontend/lib/api.ts)) auto-injects a random UUID as `Idempotency-Key` header on every `POST`/`PATCH`/`PUT`/`DELETE`. Backend `requireIdempotencyKey` middleware ([apps/backend/src/shared/idempotencyHandler.js](apps/backend/src/shared/idempotencyHandler.js)) requires the header and stores the (key, tenant, user, response) tuple in `idempotency_records` for 24h. A retry with the same key replays the cached response body verbatim, no re-execution. Applied on every money-mover, every FSM-transitioning POST, and every DSAR/breach create.

### 3.5 If-Match optimistic concurrency

Rows with a `version` column require an `If-Match: "<version>"` header on `PATCH`. Frontend queries hydrate `version` from `GET` responses and echo it back. Applied to CRM lead patches, institution patches, program patches, tenant patches.

### 3.6 Rate limiters ([apps/backend/src/middlewares/rateLimit.ts](apps/backend/src/middlewares/rateLimit.ts))

| Limiter | Cap | Applies to |
|---|---|---|
| `globalLimiter` | 600/min/IP | Every request |
| `authLimiter` | 5/min/IP | Login, password-reset, MFA setup/verify/disable |
| `refreshLimiter` | Generous | `POST /auth/refresh` (relaxed vs authLimiter — SPA reloads) |
| `v2SyncLimiter` | Per-user cap | `POST /leads/sync` |
| `importsLimiter` | 10/min/user | `POST /imports/:resource` |
| `exportDownloadLimiter` | 10/min/user | `POST /exports`, `GET /exports/:id/download` |
| `dsarLimiter` | 20/min | DSAR intake + update |
| `heavyReadLimiter` | 60/min | Reports, breach dashboard-summary, DSAR dashboard-summary |
| `inboxMutationLimiter` | Per-user | Mark-read + mark-all-read |
| `auditVerifyLimiter` | 5/min | Audit hash-chain verify |
| `otherAuthLimiter` | | Password-change, MFA disable |

### 3.7 CORS + CSRF

- `CORS_ORIGIN` allow-list (comma-separated), credentials true, maxAge 600.
- `originGuard` on every cookie-bearing endpoint (`/auth/login`, `/refresh`, `/logout`, password-reset).
- Refresh cookie: httpOnly, `sameSite=strict` (upgraded to strict for extra CSRF depth), `secure` in prod.
- CSP violation reports POSTed to `/api/v1/csp` (public, self-rate-limited).
- Error-boundary reports POSTed to `/api/v1/security` (name + digest only — never message/stack).

### 3.8 Audit trail

Every write path calls `writeAudit({action, entityType, entityId, actorId, tenantId, ...})`. Rows go into `audit_logs` which:

- Has UPDATE and DELETE triggers that block modification at the DB layer.
- Chains SHA-256 per tenant via `audit_logs_hash_chain()` trigger with `FOR UPDATE` locking (fixed in `20991231235996`).
- Nightly job folds tip into `audit_anchors` (Merkle root) for external WORM replication.
- Read-only via `GET /audit-logs` (ADMIN, filterable, paged) + `GET /audit-logs/verify` (recomputes chain per tenant).

---

## 4. Feature catalog by domain

For each domain: what the feature does, which endpoints implement it, which frontend page(s) surface it, who can use it.

### 4.1 Authentication & session

Mount: `/api/v1/auth` ([apps/backend/src/modules/auth/auth.routes.ts](apps/backend/src/modules/auth/auth.routes.ts)).

| Endpoint | Purpose | Role | Guards |
|---|---|---|---|
| `POST /auth/login` | Email+password auth; returns access token JSON + sets refresh cookie | Anon | `originGuard`, `authLimiter`, `validate(LoginRequest)` |
| `POST /auth/refresh` | Rotate refresh token; single-use with reuse detection (family-revocation on replay) | Cookie holder | `originGuard`, `refreshLimiter` |
| `POST /auth/logout` | Clear refresh cookie + denylist access token JTI | Cookie holder | `originGuard` |
| `GET /auth/me` | Current user profile | Authenticated | — |
| `PATCH /auth/me` | Update self preferences (locale, timezone, notifications) | Authenticated | `requireMfa`, `validate(UpdateMyPreferencesRequest)` |
| `POST /auth/change-password` | Self-service password change | Authenticated | `requireMfa`, HIBP-checked, revokes other sessions |
| `POST /auth/password/reset-request` | Send reset email (idempotent, always 200) | Anon | `originGuard`, `authLimiter` |
| `POST /auth/password/reset-confirm` | Consume reset token, set new password | Token holder | `originGuard`, `authLimiter` |
| `POST /auth/mfa/setup` | Return `otpauth://` URI + raw secret (needs current password) | Authenticated | `authLimiter` |
| `POST /auth/mfa/verify` | Enable MFA, return 10 recovery codes ONCE | Authenticated | `authLimiter` |
| `POST /auth/mfa/disable` | Disable MFA (needs current password) | Authenticated | `authLimiter` |
| `GET /auth/jwks`, `GET /auth/.well-known/jwks.json` | JWKS keyset for token verifiers | Anon | — |

**Frontend pages:** [/login](apps/frontend/app/(auth)/login/page.tsx), [/forgot-password](apps/frontend/app/(auth)/forgot-password/page.tsx), [/reset-password](apps/frontend/app/(auth)/reset-password/page.tsx). Access token held in-memory only (XSS-immune); refresh cookie is httpOnly.

### 4.2 Dashboard & onboarding

Mount: `/api/v1/dashboard`.

| Endpoint | Purpose | Notes |
|---|---|---|
| `GET /dashboard/summary` | By-stage + by-status counts, recent stage events, upcoming expiries, unread messages | Role-scoped (COUNSELLOR sees own caseload); hides stages flagged `show_on_dashboard=false` |
| `GET /dashboard/finance-summary` | Per-currency outstanding, 30d collections, 30d refund rate, active plan count | Never nets across currencies; role-scoped |
| `GET /dashboard/expiries` | Upcoming expiry rows within `within_days` window (default 60) | Union across visa/passport/insurance/document/regulator-id |
| `GET /dashboard/sla-breaches` | Students overdue at current stage (`elapsed - sla_hours > 0`); ACTIVE only | Optional `min_hours_over` for critical triage |
| `GET /dashboard/engagement-at-risk` | ACTIVE students below attendance threshold in recent window | Defaults: 30d window, 80% threshold, ≥3 checks |
| `GET /dashboard/onboarding` | 8-step first-run checklist | 60s per-tenant cache; ADMIN + COUNSELLOR only |

**Frontend page:** [/](apps/frontend/app/(app)/page.tsx) → renders `<DashboardClient>`. Shows: greeting tile (tenant name from `useTenant()`), KPI ring, finance summary tiles, expiring items table, SLA breach list, engagement-at-risk list, onboarding checklist card (dismissable via localStorage), recent activity feed.

### 4.3 CRM Leads (post-visa work queue)

Mount: `/api/v1/leads` ([crm-leads.routes.ts](apps/backend/src/modules/crm-leads/crm-leads.routes.ts)).

| Endpoint | Purpose | Role | Guards |
|---|---|---|---|
| `GET /leads` | Paged lead list, filters: `search`, `intake_key`, `has_upcoming_fee`, `assigned_to_id`, `status` | Any | `validate(CrmLeadListQuery, 'query')` |
| `GET /leads/applications` | One row per visa-accepted lead-course (the "Applications" table) | Any | — |
| `GET /leads/finance-summary` | Per-currency outstanding/collected/payments | Any | — |
| `GET /leads/institutions-report` | Visa-accepted-scoped institutions catalog | Any | — |
| `GET /leads/courses-report` | Visa-accepted-scoped courses catalog | Any | — |
| `POST /leads/sync` | Trigger V2 MIS ingest (advisory-lock idempotent) | ADMIN | `v2SyncLimiter`, `validate(empty)` |
| `GET /leads/:id` | Full lead detail (identity, courses, activity, fees, links) | Any | UUID param |
| `PATCH /leads/:id` | Update SPVT-owned fields (`spv_status`, `assigned_to_id`, `spv_notes`) | ADMIN, COUNSELLOR | `If-Match`, `validate(UpdateCrmLeadRequest)` |
| `POST /leads/:id/convert` | Mint managed Student + migrate fees | ADMIN | `requireIdempotencyKey`, `validate(ConvertLeadToStudentRequest)` |
| `POST /leads/:id/fees` | Add SPVT-owned fee | ADMIN, COUNSELLOR | `requireIdempotencyKey`, `validate(CreateCrmLeadFeeRequest)` |
| `PATCH /leads/:id/fees/:feeId` | Edit fee | ADMIN, COUNSELLOR | `requireIdempotencyKey`, `validate(UpdateCrmLeadFeeRequest)` |
| `POST /leads/:id/fees/:feeId/pay` | Mark fee paid (atomic guard prevents double-pay) | ADMIN, COUNSELLOR | `requireIdempotencyKey`, `validate(MarkCrmFeePaidRequest)` |
| `POST /leads/:id/fees/:feeId/waive` | Waive fee | ADMIN, COUNSELLOR | `requireIdempotencyKey`, `validate(empty)` |
| `DELETE /leads/:id/fees/:feeId` | Soft-delete fee | ADMIN, COUNSELLOR | `requireIdempotencyKey` |

**Frontend pages:**
- [/leads](apps/frontend/app/(app)/leads/page.tsx) — paged applications table. Header actions: **CRM catalog** button (→ `/leads/institutions`), **Sync from V2** (ADMIN, shows last-run chip).
- [/leads/[id]](apps/frontend/app/(app)/leads/[id]/page.tsx) — lead detail with tabs (Profile, Fees, Applications, Payments, Activity, Assignments, Guardians, History). Dialogs: `EditLeadDialog`, `AddFeeDialog`, `ConvertToStudentDialog`, per-fee `ConfirmDialog` (pay/waive/delete).
- [/leads/institutions](apps/frontend/app/(app)/leads/institutions/page.tsx) — CRM catalog reports.

**Business rules:**
- Convert dedup guard: server returns 409 `duplicate_student_candidates` when name+DOB match an existing student; UI shows inline warning with links; admin can `Convert anyway` by passing `acknowledge_duplicate: true`.
- Mark-fee-paid atomic: `updateMany({where: {id, status: {not: 'PAID'}}, ...})` — a concurrent double-click can only write one PAID row.
- Mark-fee-paid side effect: related PENDING/SENT reminders are auto-dismissed ([crm-leads.service.ts:281-283](apps/backend/src/modules/crm-leads/crm-leads.service.ts)).
- V2 sync concurrency: `runJob('v2.ingest', {ttlSec: 30*60}, ...)` — a second click returns `status: 'ALREADY_RUNNING'`.
- Convert audit event: `crm_lead.converted` written into the tenant hash chain.

### 4.4 Managed Students

Mount: `/api/v1/students` ([students.routes.ts](apps/backend/src/modules/students/students.routes.ts)).

| Endpoint | Purpose | Role | Guards |
|---|---|---|---|
| `GET /students` | Paged list | Any (ownership-filtered) | `validate(StudentListQuery, 'query')` |
| `POST /students` | Create student | ADMIN, COUNSELLOR | `validate(CreateStudentRequest)` |
| `GET /students/:id` | Read student with computed fields | Any (own or ADMIN) | `requireStudentOwnership('id')` |
| `PATCH /students/:id` | Update student | ADMIN, COUNSELLOR (own) | `requireStudentOwnership('id')`, `validate(UpdateStudentRequest)` |
| `DELETE /students/:id` | Soft-delete | ADMIN | — |
| `GET /students/:id/timeline` | Combined event feed | Any (own or ADMIN) | `requireStudentOwnership` |
| `POST /students/:id/transitions` | Advance lifecycle stage | ADMIN, COUNSELLOR (own) | `requireStudentOwnership`, `requireIdempotencyKey`, `validate(AdvanceStageRequest)` |
| `GET /students/:id/completeness` | Completeness ring metric | Any (own or ADMIN) | `requireStudentOwnership` |

**Frontend pages:**
- [/students](apps/frontend/app/(app)/students/page.tsx) — list.
- [/students/[id]](apps/frontend/app/(app)/students/[id]/page.tsx) — detail with tabs (Overview, Contacts, Qualifications, Documents, Finance, Visas, Travel, Accommodation, Insurance, Employment, Dependents, Timeline).

### 4.5 Student sub-resources

All mounted both nested (`/api/v1/students/:studentId/<resource>`) and flat (`/api/v1/<resource>`). Nested routes are `mergeParams: true`. Every sub-resource enforces `requireStudentOwnership('studentId')`.

| Resource | Nested router | Flat router |
|---|---|---|
| Travel records | `POST/GET .../travel` | `PATCH/DELETE /travel/:id` |
| Accommodations | `.../accommodations` | `/accommodations/:id` |
| Insurance records | `.../insurances` | `/insurances/:id` |
| Finance items | `.../finance` | `/finance/:id` |
| Compliance checks | `.../compliance` | `/compliance/:id` |
| Engagement checks | `.../engagements` | `/engagements/:id` |
| Employment records | `.../employment` | `/employment/:id` |
| Dependents | `.../dependents` | `/dependents/:id` |
| Sponsorships | `.../sponsorships` (+ shared `/sponsors`) | `/sponsorships/:id` |
| Contacts | `.../contacts` | `/contacts/:id` |
| Academic qualifications | `.../qualifications` | `/qualifications/:id` |
| Language tests | `.../language-tests` | `/language-tests/:id` |
| Identifications (passport, national ID) | `.../identifications` | `/identifications/:id` |
| Visas | `.../visas` | `/visas/:id` |
| Regulator IDs (CAS/COE/I-20) | `.../regulator-ids` | `/regulator-ids/:id` |
| Addresses | `.../addresses` (+ shared `/addresses`) | `/addresses/:id` |
| Messages | `.../messages` | (see 4.7) |
| Enrollments | `.../enrollments` | `/enrollments/:id` |
| Checklist progress | `.../checklist-progress` | — |

### 4.6 Documents

Mounts: `/api/v1/students/:studentId/documents` (nested) + `/api/v1/documents` (flat) ([documents.routes.ts](apps/backend/src/modules/documents/documents.routes.ts)).

| Endpoint | Purpose | Role | Guards |
|---|---|---|---|
| `GET /students/:studentId/documents` | List documents for student | Any (own or ADMIN) | `requireStudentOwnership('studentId')` |
| `POST /students/:studentId/documents` | Upload (multipart, ≤10 MiB) | ADMIN, COUNSELLOR (own) | Multer memoryStorage, MIME sniff, ClamAV fail-closed |
| `GET /documents/:id/download` | JSON envelope with signed short-lived URL | Any (own or ADMIN) | `requireStudentOwnershipViaChild` |
| `GET /documents/:id/stream?nonce=` | Stream file bytes | Any (own or ADMIN) | Nonce bound to user, ownership-gated |
| `PATCH /documents/:id/verification` | Verify (VERIFIED/REJECTED + reason) | ADMIN, COUNSELLOR (own) | `validate(VerifyDocumentRequest)` |
| `DELETE /documents/:id` | Soft-delete | ADMIN | — |

**Pipeline per upload:**
1. Multer receives multipart, buffered ≤10 MiB (memoryStorage).
2. MIME allow-list check on header (fast reject).
3. `mime.detectMime()` on buffer bytes (authoritative — header ignored).
4. ClamAV scan (fail-closed: unreachable → `av_status=ERROR`, refuse to serve).
5. Envelope-encrypt bytes with per-DEK AES-256-GCM.
6. Store to S3 (DO Spaces) — key format includes tenant + hash-of-hash.
7. Write `Document` row with sha256 checksum, mime, size, av_status, av_scanned_at.

**Frontend surface:** every student detail page has a Documents tab with drag-drop upload, list with verification actions, per-row download button.

### 4.7 Inbox & communications

Mounts: `/api/v1/inbox`, `/api/v1/message-templates`, `/api/v1/students/:studentId/messages`, `/api/v1/comms/threads`, `/api/v1/comms/unsubscribe`, `/api/v1/webhooks`, `/api/v1/admin/comms/outbox` ([comms/routes.ts](apps/backend/src/modules/comms/routes.ts)).

**Inbox (per-user):**

| Endpoint | Purpose | Role |
|---|---|---|
| `GET /inbox/messages` | List IN_APP messages addressed to caller | Any |
| `POST /inbox/messages/read-all` | Mark all read | Any (`inboxMutationLimiter`) |
| `POST /inbox/messages/:id/read` | Mark single read | Any (`inboxMutationLimiter`) |

**Message templates:**

| Endpoint | Purpose | Role |
|---|---|---|
| `GET /message-templates`, `GET /message-templates/:id` | Read templates | Any |
| `POST /message-templates` | Create | ADMIN |
| `PATCH /message-templates/:id` | Edit | ADMIN |
| `DELETE /message-templates/:id` | Delete | ADMIN |

**Per-student messages (send outbound):**

| Endpoint | Purpose | Role |
|---|---|---|
| `GET /students/:studentId/messages` | List | Any (own or ADMIN) |
| `POST /students/:studentId/messages` | Free-form outbound | ADMIN, COUNSELLOR (own) |
| `POST /students/:studentId/messages/from-template` | Render + send from template | ADMIN, COUNSELLOR (own) |
| `POST /students/:studentId/messages/from-template/preview` | Dry-render, no send | ADMIN, COUNSELLOR (own) |

**Threads (browser):** `GET /comms/threads`, `GET /comms/threads/:id`.

**Public unsubscribe (RFC 8058 one-click):** `/comms/unsubscribe/:token` (HMAC-signed, no auth).

**Webhooks:** `/webhooks/resend` (svix HMAC verification against `RESEND_WEBHOOK_SECRET`) — records bounces/complaints against the CommsMessage.

**Admin outbox:**

| Endpoint | Purpose |
|---|---|
| `GET /admin/comms/outbox/health` | Queue depth, error rate, oldest QUEUED |
| `GET /admin/comms/outbox/trend` | 24h send trend |
| `GET /admin/comms/outbox/metrics` | Provider-level metrics |
| `GET /admin/comms/outbox/messages` | List QUEUED/FAILED |
| `POST /admin/comms/outbox/requeue-all` | Requeue every FAILED |
| `POST /admin/comms/outbox/:id/requeue` | Requeue single |

**Async dispatch:** `jobs/commsDispatcher.ts` polls QUEUED/retryable-FAILED rows every N seconds, calls the provider (Resend for EMAIL), records SENT/FAILED with exponential backoff (5min, 30min, terminal). Per-tenant advisory lock.

**Frontend pages:** [/inbox](apps/frontend/app/(app)/inbox/page.tsx) — tabs `?tab=tasks|expiring|messages`. Notifications bell in app-bar for the unread count. Per-student `Messages` tab lists thread messages.

### 4.8 Reminders, expiries & calendar

**Reminders** (`/api/v1/reminders` — [reminders/routes.ts](apps/backend/src/modules/reminders/routes.ts)):

| Endpoint | Purpose | Role |
|---|---|---|
| `GET /reminders` | List (filterable) | Any |
| `GET /reminders/:id` | Read | Any |
| `POST /reminders` | Create | ADMIN, COUNSELLOR |
| `PATCH /reminders/:id` | Edit | ADMIN, COUNSELLOR |
| `POST /reminders/:id/acknowledge` | Ack (keeps for records) | ADMIN, COUNSELLOR |
| `POST /reminders/:id/snooze` | Push out `remind_at` | ADMIN, COUNSELLOR |
| `POST /reminders/:id/dismiss` | Dismiss (removes from queue) | ADMIN, COUNSELLOR |
| `DELETE /reminders/:id` | Hard remove | ADMIN |

**Reminder dispatch:** `jobs/reminderScanner.ts` scans PENDING reminders past `remind_at`; `jobs/reminderDispatcher.ts` converts to IN_APP CommsMessage rows for the assigned admin/counsellor.

**Expiries** (`/api/v1/expiries` — [expiries/routes.ts](apps/backend/src/modules/expiries/routes.ts)):

| Endpoint | Purpose | Role |
|---|---|---|
| `GET /expiries` | Read-only union across visa/passport/insurance/document/regulator-id sources | Any (`ExpiriesListQuery`) |

**Frontend pages:**
- [/inbox](apps/frontend/app/(app)/inbox/page.tsx) — 3 tabs: tasks (reminders), expiring (expiries), messages (inbox).
- [/reminders](apps/frontend/app/(app)/reminders/page.tsx) — dedicated reminders view (deep-link).
- [/expiries](apps/frontend/app/(app)/expiries/page.tsx) — dedicated expiries view (deep-link).
- [/calendar](apps/frontend/app/(app)/calendar/page.tsx) — reminder calendar.

### 4.9 Institutions & academic catalog

Mounts: `/api/v1/institutions`, `/api/v1/programs`, `/api/v1/super-agents`, `/api/v1/super-agent-types`, `/api/v1/institutions/:id/super-agents`, `/api/v1/enrollments`.

**Institutions:**

| Endpoint | Role |
|---|---|
| CRUD `/institutions` | ADMIN, COUNSELLOR (write); any (read) |
| Nested: `/institutions/:id/campuses`, `/schools`, `/departments`, `/identifiers`, `/accreditations`, `/contacts` | Similar |
| `/institutions/:id/super-agents` | Pivot for super-agent commissions |

**Programs (labeled "Courses" in UI):** CRUD `/programs` + nested `/intakes`, `/requirements`, `/modules`, `/fees`.

**Enrollments:** CRUD both `/enrollments` and `/students/:studentId/enrollments`. Creating an enrollment via POST requires `requireIdempotencyKey`.

**Super-agents:** Contacts, types, commission rules.

**Frontend pages:** [/institutions](apps/frontend/app/(app)/institutions/page.tsx), [/institutions/[id]](apps/frontend/app/(app)/institutions/[id]/page.tsx), [/programs](apps/frontend/app/(app)/programs/page.tsx), [/programs/[id]](apps/frontend/app/(app)/programs/[id]/page.tsx), [/super-agents](apps/frontend/app/(app)/super-agents/page.tsx), [/super-agents/[id]](apps/frontend/app/(app)/super-agents/[id]/page.tsx), [/super-agent-types](apps/frontend/app/(app)/super-agent-types/page.tsx).

### 4.10 Bulk imports & exports

**Imports** (`/api/v1/imports` — [imports.routes.ts](apps/backend/src/modules/imports/imports.routes.ts)):

| Endpoint | Purpose | Role |
|---|---|---|
| `GET /imports/:resource/schema` | Fields + validation rules for the resource | Authenticated |
| `GET /imports/:resource/template.csv` | Downloadable header template | Authenticated |
| `POST /imports/:resource` | Upload CSV (≤50 MiB, multer memoryStorage) | ADMIN (`importsLimiter`) |
| `GET /imports/:job_id` | Job status | Authenticated |
| `GET /imports/:job_id/report` | Summary counts | Authenticated |
| `GET /imports/:job_id/errors.jsonl` | Error rows (one JSON per line) | Authenticated |
| `POST /imports/:job_id/apply` | Commit staged rows | ADMIN (`requireIdempotencyKey`) |
| `POST /imports/:job_id/cancel` | Cancel job | ADMIN |
| `GET /imports/:job_id/result.jsonl` | Applied-row output | Authenticated |

**Exports** (`/api/v1/exports` — [exports.routes.ts](apps/backend/src/modules/exports/exports.routes.ts)):

| Endpoint | Purpose | Role |
|---|---|---|
| `POST /exports` | Queue an export job (CSV/JSONL) | ADMIN (`exportDownloadLimiter`) |
| `GET /exports/:job_id` | Status | ADMIN, COUNSELLOR (own) |
| `GET /exports/:job_id/download` | Stream artifact | ADMIN, COUNSELLOR (own, `exportDownloadLimiter`) |
| `POST /exports/:job_id/cancel` | Cancel | ADMIN, COUNSELLOR (own) |

**Frontend pages:** [/imports](apps/frontend/app/(app)/imports/page.tsx), [/imports/new](apps/frontend/app/(app)/imports/new/page.tsx), [/exports](apps/frontend/app/(app)/exports/page.tsx).

### 4.11 Billing (school/college fees)

Mount: `/api/v1/billing` ([billing.routes.ts](apps/backend/src/modules/billing/billing.routes.ts)). **Gated by** `billingEnabled` middleware — returns 404 when `Tenant.billing_enabled = false`. Sidebar entry is hidden accordingly.

**Fee plans:**

| Endpoint | Purpose | Role | Extra guards |
|---|---|---|---|
| `GET /billing/plans` | List | ADMIN, COUNSELLOR | — |
| `GET /billing/plans/:id` | Read | ADMIN, COUNSELLOR | — |
| `GET /billing/plans/:id/invoice.txt` | Text invoice (ETag, 5min cache) | ADMIN, COUNSELLOR | — |
| `GET /billing/plans/:id/invoice.pdf` | PDF invoice (pdf-lib) | ADMIN, COUNSELLOR | — |
| `GET /billing/outstanding` | Per-currency outstanding rollup | ADMIN, COUNSELLOR | — |
| `POST /billing/plans` | Create plan | ADMIN, COUNSELLOR | — |
| `POST /billing/plans/:id/pause` | Pause | ADMIN, COUNSELLOR | — |
| `POST /billing/plans/:id/resume` | Resume | ADMIN, COUNSELLOR | — |
| `POST /billing/plans/:id/cancel` | Cancel | ADMIN | `requireMfa({enrollmentRequired})` |
| `POST /billing/plans/:id/regenerate` | Recut installments | ADMIN | `requireIdempotencyKey` |

**Payments:**

| Endpoint | Purpose | Role | Extra guards |
|---|---|---|---|
| `GET /billing/payments`, `GET /billing/payments/:id` | Read | ADMIN, COUNSELLOR | — |
| `POST /billing/payments` | Record payment | ADMIN, COUNSELLOR | `requireIdempotencyKey` |
| `POST /billing/payments/:id/void` | Void | ADMIN | `requireMfa({enrollmentRequired})`, `requireIdempotencyKey` |
| `POST /billing/payments/:id/refunds` | Create refund | ADMIN | `requireMfa({enrollmentRequired})`, `requireIdempotencyKey` |
| `POST /billing/refunds/:id/complete` | Complete refund | ADMIN | `requireMfa({enrollmentRequired})`, `requireIdempotencyKey` |
| `POST /billing/refunds/:id/fail` | Fail refund | ADMIN | `requireMfa({enrollmentRequired})`, `requireIdempotencyKey` |

**Adjustments:**

| Endpoint | Purpose | Role | Extra guards |
|---|---|---|---|
| `POST /billing/installments/:id/adjustments` | LATE_FEE / DISCOUNT / SCHOLARSHIP / WAIVER / WRITE_OFF | ADMIN, COUNSELLOR | `requireIdempotencyKey` |

**Frontend page:** [/billing](apps/frontend/app/(app)/billing/page.tsx). Non-admin (or `billing_enabled=false`) sees an empty-state screen because the deep link still renders.

### 4.12 Commissions & super-agents

**Commissions** (`/api/v1/commissions` — [commissions/routes.ts](apps/backend/src/modules/commissions/routes.ts)). Institution → consultancy commission claims lifecycle.

**Super-agents** (`/api/v1/super-agents`, `/api/v1/super-agent-types`). Third-party recruiters with commission rules.

**Frontend pages:** [/commissions](apps/frontend/app/(app)/commissions/page.tsx), [/super-agents](apps/frontend/app/(app)/super-agents/page.tsx), [/super-agents/[id]](apps/frontend/app/(app)/super-agents/[id]/page.tsx), [/super-agent-types](apps/frontend/app/(app)/super-agent-types/page.tsx).

### 4.13 Reports & analytics

Mount: `/api/v1/reports` (ADMIN-only, `heavyReadLimiter` — [reports/routes.ts](apps/backend/src/modules/reports/routes.ts)).

| Endpoint | Purpose | Filters |
|---|---|---|
| `GET /reports/visa-funnel` | Lead → managed-student conversion by stage | `visa_type_id` |
| `GET /reports/counsellor-load` | Per-counsellor active-caseload count | `include_inactive_users` |
| `GET /reports/commission-revenue` | Commission $ by period | `from`, `to`, `currency` |
| `GET /reports/refund-rate` | 30d/period refund rate | `from`, `to` |
| `GET /reports/outstanding-by-age` | Outstanding by installment age bucket | `currency` |

Date-range clamped to max 3 years past-to-now. Never nets across currencies.

**Frontend page:** [/reports](apps/frontend/app/(app)/reports/page.tsx).

### 4.14 Admin console

Frontend page [/admin](apps/frontend/app/(app)/admin/page.tsx) is a tabbed hub that surfaces the following admin sub-pages:

| Sub-page | Route | Purpose |
|---|---|---|
| Stages | [/stages](apps/frontend/app/(app)/stages/page.tsx) | Configurable lifecycle stages + transitions + checklists |
| Visa types | [/visa-types](apps/frontend/app/(app)/visa-types/page.tsx) | Per-(country × visa-type) catalog |
| Users | [/users](apps/frontend/app/(app)/users/page.tsx) | User CRUD + reset password + revoke sessions + force-disable MFA |
| Commissions | [/commissions](apps/frontend/app/(app)/commissions/page.tsx) | Commission claims |
| Reports | [/reports](apps/frontend/app/(app)/reports/page.tsx) | Analytics |
| Exports | [/exports](apps/frontend/app/(app)/exports/page.tsx) | Bulk export jobs |
| Catalog | [/catalog](apps/frontend/app/(app)/catalog/page.tsx) | Reference-catalog editor (Country, Currency, DocumentType, ...) |
| Super-agents | [/super-agents](apps/frontend/app/(app)/super-agents/page.tsx) | 3rd-party recruiters |
| Super-agent types | [/super-agent-types](apps/frontend/app/(app)/super-agent-types/page.tsx) | Category lookup |
| Interview questions | [/interview-questions](apps/frontend/app/(app)/interview-questions/page.tsx) | Question bank |
| Interview attempts | [/interview-attempts](apps/frontend/app/(app)/interview-attempts/page.tsx) | Practice-attempt history |
| Outbox | [/admin/outbox](apps/frontend/app/(app)/admin/outbox/page.tsx) | Comms outbox health + requeue |
| Tenants | [/admin/tenants](apps/frontend/app/(app)/admin/tenants/page.tsx) | Tenant self-settings viewer |

**Users CRUD API** (`/api/v1/users`, ADMIN + MFA — [users.routes.ts](apps/backend/src/modules/users/users.routes.ts)):

| Endpoint | Purpose | Extra guards |
|---|---|---|
| `GET /users` | List | — |
| `POST /users` | Create | `validate(CreateUserRequest)` |
| `GET /users/:id` | Read | — |
| `PATCH /users/:id` | Update | `requireMfa({enrollmentRequired})` |
| `DELETE /users/:id` | Soft-delete | `requireMfa({enrollmentRequired})` |
| `POST /users/:id/reset-password` | Send reset link | `requireMfa({enrollmentRequired})` |
| `POST /users/:id/sessions/revoke` | Revoke all live refresh tokens | `requireMfa({enrollmentRequired})` |
| `POST /users/:id/mfa/disable` | Force-unbrick a user's TOTP | `requireMfa`, `validate(AdminDisableMfaRequest)` |

**Stages CRUD API** (`/api/v1/stages` — [stages.routes.ts](apps/backend/src/modules/stages/stages.routes.ts)):

| Endpoint | Purpose | Role |
|---|---|---|
| `GET /stages`, `GET /stages/transitions` | Read | Any |
| `POST /stages`, `PATCH /stages/:id`, `DELETE /stages/:id` | CRUD | ADMIN |
| `POST /stages/transitions`, `DELETE /stages/transitions/:id` | Manage transitions | ADMIN |
| `POST /stages/reorder` | Reorder | ADMIN |
| `POST /stages/preview-impact` | Dry-run impact of reorder | ADMIN |

**Visa-types CRUD API** (`/api/v1/visa-types`): CRUD, list open to any (needed by student editors).

**Tenant self-settings API** (`/api/v1/tenants`, ADMIN — [tenants/routes.ts](apps/backend/src/modules/tenants/routes.ts)):

| Endpoint | Purpose |
|---|---|
| `GET /tenants/me` | Read own tenant settings |
| `PATCH /tenants/me` | Update (name, legal_name, locale, timezone, currency, email_from, billing_enabled) |

**Idempotency sweeper** (`/api/v1/admin/idempotency` — [admin/idempotency.routes.ts](apps/backend/src/modules/admin/idempotency.routes.ts)): admin tooling to sweep stuck PENDING idempotency rows.

**V2 diagnostics** (`/api/v1/admin/v2-diagnostics` — [admin/v2-diagnostics.routes.ts](apps/backend/src/modules/admin/v2-diagnostics.routes.ts)): histogram of V2 free-text state values (used to tune the visa-accepted union filter).

### 4.15 Compliance suite (GDPR)

**Audit log** (`/api/v1/audit-logs`, ADMIN — [audit/routes.ts](apps/backend/src/modules/audit/routes.ts)):

| Endpoint | Purpose |
|---|---|
| `GET /audit-logs` | Paged list (filters: actor, entity_type, action, date range) |
| `GET /audit-logs/:id` | Read single |
| `GET /audit-logs/verify` | Recompute SHA-256 hash chain per tenant, return `broken_count` (`auditVerifyLimiter` 5/min) |
| `GET /audit-logs/anchors` | Merkle roots (nightly WORM anchor) |

**DSAR** (`/api/v1/dsar` — [dsar/routes.ts](apps/backend/src/modules/dsar/routes.ts)):

| Endpoint | Purpose | Role |
|---|---|---|
| `POST /dsar` | Intake (ACCESS / ERASURE / PORTABILITY / RESTRICTION / OBJECTION / RECTIFICATION) | ADMIN, COUNSELLOR (`dsarLimiter`, `requireIdempotencyKey`) |
| `GET /dsar` | List | ADMIN |
| `GET /dsar/dashboard-summary` | Widget counts | ADMIN (`heavyReadLimiter`) |
| `GET /dsar/:id` | Read | ADMIN |
| `PATCH /dsar/:id` | Advance status (PENDING → IN_PROGRESS → COMPLETED) | ADMIN, COUNSELLOR |
| `GET /dsar/:id/export` | Mint single-use 24h download token | ADMIN |
| `GET /dsar/:id/export/download?token=` | Stream export bundle | ADMIN |

**Public DSAR intake** (`/api/v1/public/dsar` — [dsar-public/routes.ts](apps/backend/src/modules/dsar-public/routes.ts)): anonymous submit for a data subject to request their own record — router owns its own rate limiter.

**Consent** (`/api/v1/consents` — [consent/routes.ts](apps/backend/src/modules/consent/routes.ts)):

| Endpoint | Purpose | Role |
|---|---|---|
| `POST /consents` | Record consent | ADMIN, COUNSELLOR |
| `GET /consents`, `GET /consents/:id` | Read | ADMIN, COUNSELLOR, VIEWER (own-subject filter for VIEWER) |
| `POST /consents/:id/revoke` | Art. 7(3) right-to-withdraw | ADMIN, COUNSELLOR, VIEWER (own subject) |

**Breach register** (`/api/v1/breach-incidents`, ADMIN — [breach/routes.ts](apps/backend/src/modules/breach/routes.ts)):

| Endpoint | Purpose | Extra guards |
|---|---|---|
| `POST /breach-incidents` | Intake | `requireIdempotencyKey` |
| `GET /breach-incidents` | List | — |
| `GET /breach-incidents/dashboard-summary` | Widget | `heavyReadLimiter` |
| `GET /breach-incidents/:id` | Read | — |
| `PATCH /breach-incidents/:id` | Advance (DETECTED → CONTAINED → NOTIFIED → CLOSED) | — |
| `DELETE /breach-incidents/:id` | **Blocked 405** — records are append-only for regulatory evidence | — |

**Sub-processors** (`/api/v1/sub-processors`, ADMIN — [sub-processors/routes.ts](apps/backend/src/modules/sub-processors/routes.ts)): CRUD for Art. 28 processor register (name, purpose, region, contract_url, dpa_signed_at, transfer_mechanism).

**ROPA** (`/api/v1/admin/ropa`, ADMIN — [admin/ropa.routes.ts](apps/backend/src/modules/admin/ropa.routes.ts)):

| Endpoint | Purpose |
|---|---|
| `GET /admin/ropa` | Art. 30 Records of Processing Activities (JSON: catalog + sub-processors + DSAR counts + consent counts) |
| `GET /admin/ropa.csv` | Same in CSV with UTF-8 BOM (CSV-injection guarded) |

**Frontend pages:** [/audit](apps/frontend/app/(app)/audit/page.tsx), [/dsar](apps/frontend/app/(app)/dsar/page.tsx), [/consents](apps/frontend/app/(app)/consents/page.tsx), [/breach-incidents](apps/frontend/app/(app)/breach-incidents/page.tsx), [/sub-processors](apps/frontend/app/(app)/sub-processors/page.tsx).

### 4.16 Interview prep

Mounts: `/api/v1/interview-questions`, `/api/v1/interview-attempts` (authenticated), `/api/v1/public/interview-prep` (anonymous).

**Frontend pages:** [/interview-questions](apps/frontend/app/(app)/interview-questions/page.tsx), [/interview-attempts](apps/frontend/app/(app)/interview-attempts/page.tsx), [/interview-prep](apps/frontend/app/(public)/interview-prep/page.tsx) (public).

### 4.17 Tags, notes, saved views, custom attributes

- **Tags** (`/api/v1/tags`, `/api/v1/entity-tags`) — free-text labels attachable to any entity.
- **Notes** (`/api/v1/notes`) — free-text notes with mentions.
- **Saved views** (`/api/v1/saved-views`) — persist filter/sort combos per user per entity.
- **Custom attributes** (`/api/v1/attribute-definitions`, `/api/v1/entity-attributes`) — key-value extension surface (typed).

### 4.18 Public-facing endpoints

Unauthenticated, mounted before any auth middleware ([app.ts:187-199](apps/backend/src/app.ts)):

| Mount | Purpose |
|---|---|
| `/.well-known` | JWKS + standard discovery |
| `/api/v1/version` | Build version |
| `/api/v1/health/livez` | Liveness (always 200) |
| `/api/v1/health/readyz` | Readiness (checks DB + Redis) |
| `/api/v1/health/version` | Detailed version |
| `/api/v1/public/dsar` | DSAR subject-side intake |
| `/api/v1/public/status` | Operational status page feed |
| `/api/v1/public/interview-prep` | Interview-prep browsing |
| `/api/v1/csp` | CSP violation reports (`{ text/plain, application/csp-report }`) |
| `/api/v1/security` | Frontend error-boundary reports (sanitised) |
| `/api/v1/auth/*` | Login, refresh, password reset, JWKS |
| `/api/v1/comms/unsubscribe/:token` | RFC 8058 one-click unsubscribe |
| `/api/v1/webhooks/*` | Signed webhook receivers (Resend) |
| `/metrics` | Prometheus scrape (bearer `METRICS_TOKEN`) |

**Frontend public pages:** [/legal/terms](apps/frontend/app/(legal)/legal/terms/page.tsx), [/legal/privacy](apps/frontend/app/(legal)/legal/privacy/page.tsx), [/legal/support](apps/frontend/app/(legal)/legal/support/page.tsx), [/legal/dsar](apps/frontend/app/(public)/legal/dsar/page.tsx), [/status](apps/frontend/app/(public)/status/page.tsx), [/interview-prep](apps/frontend/app/(public)/interview-prep/page.tsx).

### 4.19 Operational surface (health, metrics, jobs)

- `GET /api/v1/health/livez` — process alive.
- `GET /api/v1/health/readyz` — DB + Redis probe; sets `db_up` / `redis_up` Prometheus gauges.
- `GET /metrics` — Prometheus text (bearer token).
- `GET /api/v1/jobs/recent?limit=&job_name=` — ADMIN. Recent JobRun rows for scheduler observability ([jobs/routes.ts](apps/backend/src/modules/jobs/routes.ts)).
- `GET /api/v1/openapi.json`, `GET /api/v1/docs` — Dev-only Swagger UI.

**Scheduled background jobs** (Postgres advisory-lock idempotent):

| Job | Cadence | Purpose |
|---|---|---|
| `v2.ingest` | Daily | Mirror V2 MIS |
| `reminder.scanner` | 5 min | Find PENDING reminders past `remind_at` |
| `reminder.dispatcher` | 5 min | Turn PENDING reminders into IN_APP messages |
| `comms.dispatcher` | 1 min | Send QUEUED external comms (Resend etc.) |
| `comms.digest` | Daily 08:00 UTC | Roll up per-user DAILY digest |
| `comms.cleanup` | Daily 07:15 UTC | Prune old messages per retention |
| `expiry.alerts` | Daily 06:00 UTC | Materialise upcoming expiries |
| `billing.daily` | Daily 06:15 UTC | Advance overdue statuses, apply late-fee rules |
| `retention.erasure` | Daily 03:00 UTC | Apply retention policies (soft-delete + purge) |
| `hash.anchor` | Daily | Fold audit chain tip into `audit_anchors` |
| `audit.chain.verify` | Daily | Assert no chain break |
| `dsar.sla.watch` | Hourly | Escalate approaching-SLA DSARs |
| `idempotency.cleanup` | Daily | Prune old idempotency rows |

---

## 5. User flows — step by step

Every flow below is code-traceable to the routes and files listed. Assumptions have been eliminated.

### 5.1 First-time admin onboarding

1. Navigate to frontend URL. Route lands on [/login](apps/frontend/app/(auth)/login/page.tsx).
2. Enter `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` credentials. Backend `POST /auth/login` returns access JWT (in JSON) and sets refresh cookie.
3. Frontend stores access token in memory only ([apps/frontend/lib/api.ts:11-24](apps/frontend/lib/api.ts)); XSS cannot lift it.
4. Redirect to [/](apps/frontend/app/(app)/page.tsx) — dashboard renders onboarding checklist (8 steps) from `GET /dashboard/onboarding`.
5. Open [/settings](apps/frontend/app/(app)/settings/page.tsx) → Security section → Set Up MFA. Frontend POSTs `/auth/mfa/setup` with `current_password` in body — returns `otpauth_url` + raw secret.
6. Scan QR in authenticator; POST 6-digit code to `/auth/mfa/verify`. Server returns 10 single-use recovery codes ONCE — user must save them.
7. Open [/users](apps/frontend/app/(app)/users/page.tsx) (ADMIN sub-page). Create counsellor/viewer accounts (`POST /users`). Each PATCH/DELETE will demand `X-MFA-Code`.
8. Open [/settings](apps/frontend/app/(app)/settings/page.tsx) → workspace section. Update legal_name, timezone, currency — flips onboarding checklist "tenant_settings" step to complete.
9. Optionally flip `billing_enabled=true` — flips onboarding "billing_decision" step + reveals Billing sidebar entry.
10. Sidebar → **Leads** → header **Sync from V2** (ADMIN only). First sync may take several minutes; last-run chip shows status. Once complete, applications appear in the table.

### 5.2 Handling a visa-accepted applicant

1. Sidebar → [/leads](apps/frontend/app/(app)/leads/page.tsx).
2. Filter via toolbar: `search`, `intake_key`, `has_upcoming_fee`, `assigned_to_id`, `status`.
3. Click row → [/leads/[id]](apps/frontend/app/(app)/leads/[id]/page.tsx). Detail renders with tabs Profile, Fees, Applications, Payments, Activity, Assignments, Guardians, History.
4. Fees tab: auto-seeded post-visa fees appear (labeled `<course> — Session 1` when seeded from V2). Click **Add fee** → `AddFeeDialog` → `POST /leads/:id/fees` (Idempotency-Key auto-injected).
5. Overview: assign counsellor via dropdown → `PATCH /leads/:id { assigned_to_id }` with `If-Match: "<version>"`.
6. Add notes in `spv_notes` textarea (same PATCH).
7. When ready, click **Convert to student** → `ConvertToStudentDialog` opens (pre-filled from lead). Admin confirms fields V2 doesn't carry (nationality_code, date_of_birth if missing). Submit → `POST /leads/:id/convert`.
8. On success: rich toast `Created student <code> · N fees migrated · enrolled`. Router pushes to [/students/[id]](apps/frontend/app/(app)/students/[id]/page.tsx).

### 5.3 Marking a fee paid

1. Open [/leads/[id]](apps/frontend/app/(app)/leads/[id]/page.tsx) → Fees tab.
2. Row → Actions menu → **Mark paid**. `ConfirmDialog` opens.
3. Confirm → `POST /leads/:id/fees/:feeId/pay` with `{paid_on, paid_amount_minor}` and Idempotency-Key.
4. Server executes `updateMany({where: {id, status: {not: 'PAID'}}, ...})` — atomic; concurrent double-clicks record only one PAID row.
5. Related PENDING/SENT reminders auto-dismissed ([crm-leads.service.ts:281-283](apps/backend/src/modules/crm-leads/crm-leads.service.ts)).
6. `writeAudit({action: 'crm_lead.fee.paid'})` writes into hash chain.
7. Fee row status flips to PAID; toast confirms.

### 5.4 Convert lead → managed student with duplicate detection

1. Steps 1–7 of §5.2.
2. If backend detects match (name+DOB against existing students), returns 409 `duplicate_student_candidates` with an `errors` array of `{path: <student_id>, message: <display-label>}`.
3. Dialog surfaces inline warning with links to each candidate. Admin choice:
   - Open a candidate → verify → close dialog. No student minted.
   - Click **Convert anyway** → resubmit with `acknowledge_duplicate: true`. Backend proceeds.
4. On success, fees migrate + optional enrollment created (if `program_id` supplied via Autocomplete). Router pushes to student page.

### 5.5 Advancing a student's lifecycle stage

1. Open [/students/[id]](apps/frontend/app/(app)/students/[id]/page.tsx) → Overview tab.
2. Click stage chip → `TransitionDialog` opens with allowed target stages (from `GET /fsm/*`).
3. Select target + optional notes → `POST /students/:id/transitions` with Idempotency-Key.
4. Server writes `StudentLifecycleEvent`, updates `current_stage_id`, resets `StudentStageChecklistProgress` per new stage's checklist items, recomputes SLA clock.
5. Timeline tab shows new event.

### 5.6 Uploading + verifying a document

1. Open [/students/[id]](apps/frontend/app/(app)/students/[id]/page.tsx) → Documents tab.
2. Drag file OR click Upload → picks `document_type_id` + optional `issued_on`/`expires_on` → `POST /students/:studentId/documents` (multipart, ≤10 MiB, Idempotency-Key).
3. Server pipeline: multer buffer → MIME allow-list check → magic-byte sniff (authoritative) → ClamAV scan (fail-closed) → envelope-encrypt → S3 upload → `Document` row insert with `sha256`, `av_status`, `av_scanned_at`.
4. Row appears in list with av_status badge (CLEAN / INFECTED / ERROR / PENDING).
5. Reviewer opens document → clicks **Verify** → PATCH `/documents/:id/verification` with `{status: 'VERIFIED', notes?}`.
6. Row stamps `verified_by_id`, `verified_at`, `verification_status`.

### 5.7 Downloading a document

1. Documents tab → row → **Download**.
2. Frontend GETs `/documents/:id/download` → receives JSON `{url, expires_at}` (signed short-lived).
3. Browser navigates to URL → hits `/documents/:id/stream?nonce=` → server verifies nonce is bound to caller's user id, streams decrypted bytes with `Content-Disposition: attachment; filename*=UTF-8''<enc>` and `X-Content-Sha256` header.
4. Response `Cache-Control: no-store, private` — no shared cache retains bytes.

### 5.8 Running a manual V2 sync

1. Sidebar → [/leads](apps/frontend/app/(app)/leads/page.tsx) → header **Sync from V2** (ADMIN-only button).
2. Frontend POSTs `/leads/sync` with empty body + Idempotency-Key. Rate-limited by `v2SyncLimiter`.
3. Backend wraps in `runJob('v2.ingest', {ttlSec: 30*60}, ...)` — acquires Postgres advisory lock. Second click while running → returns `status: 'ALREADY_RUNNING'`.
4. Server reads V2 in one READ ONLY transaction (`assertV2ReadOnly()` checks role has no INSERT + isn't superuser), builds a dump, topological upsert per row per own tx.
5. Toast on completion: `Synced N record(s)` / `A sync is already running.` / `Sync failed — check the V2 connection.`.
6. Last-run chip reads `GET /jobs/recent?jobName=v2.ingest&limit=1` for status + timestamp + rows processed.

### 5.9 Password reset (self-service)

1. On [/login](apps/frontend/app/(auth)/login/page.tsx), click **Forgot password** → [/forgot-password](apps/frontend/app/(auth)/forgot-password/page.tsx).
2. Enter email → `POST /auth/password/reset-request`. Backend always returns 200 with same body shape (defeats enumeration). Rate limit: 5/min/IP (`authLimiter`).
3. Backend generates single-use token, TTL 30 min, stores `sha256(token)` in `password_reset_tokens`. Raw token emailed via `EMAIL_PROVIDER=resend` (or logged when `log`).
4. User clicks link → [/reset-password?token=](apps/frontend/app/(auth)/reset-password/page.tsx) → enters new password.
5. `POST /auth/password/reset-confirm` validates token (not consumed/expired), HIBP-checks, bcrypts, marks token consumed, revokes ALL live refresh tokens.
6. User redirected to login. Old sessions dead.

### 5.10 Admin-initiated password reset

1. Sidebar (ADMIN) → **Admin → Users** → click user → **Reset password**.
2. Frontend prompts for `X-MFA-Code`; POST `/users/:id/reset-password` with header. `requireMfa({enrollmentRequired})` gates.
3. Server sends reset link exactly like self-service. Admin sees toast confirmation. User receives email.

### 5.11 Enrolling MFA

1. [/settings](apps/frontend/app/(app)/settings/page.tsx) → Security section → **Set up MFA**.
2. Enter current password → `POST /auth/mfa/setup` → returns `otpauth_url` + `secret_base32`.
3. Frontend renders QR code. User scans in Google Authenticator / Authy / 1Password.
4. Enter 6-digit code → `POST /auth/mfa/verify`. Server flips `mfa_enabled=true`, stores encrypted secret, returns 10 recovery codes ONCE.
5. User must record recovery codes (only shown once; server keeps only sha256 hashes).
6. All subsequent MFA-gated actions demand `X-MFA-Code` header per request.

### 5.12 Disabling MFA (self)

1. [/settings](apps/frontend/app/(app)/settings/page.tsx) → Security → **Disable MFA** — needs current password.
2. `POST /auth/mfa/disable` → `mfa_enabled=false`, clears `mfa_secret_enc`, invalidates recovery codes.

### 5.13 Force-unbricking a user's MFA (admin)

1. [/users](apps/frontend/app/(app)/users/page.tsx) → row → **Force-disable MFA**.
2. Requires admin has own MFA enrolled + fresh `X-MFA-Code`.
3. `POST /users/:id/mfa/disable` → clears target user's MFA. Written to audit log.

### 5.14 Bulk import — students CSV

1. Sidebar → [/imports](apps/frontend/app/(app)/imports/page.tsx) → **New import**.
2. Pick resource (e.g. `students`). Frontend GETs `/imports/students/schema` for field spec + `/imports/students/template.csv` for header template (downloadable).
3. Upload CSV → `POST /imports/students` (multipart, ≤50 MiB, `importsLimiter` 10/min, ADMIN).
4. Server stages rows, validates row-by-row, produces `import_jobs` row with status COMPLETED_WITH_ERRORS if any row fails.
5. UI polls `GET /imports/:job_id/report` for summary; downloads `/imports/:job_id/errors.jsonl` for row errors.
6. Reviewer inspects. If OK, click **Apply** → `POST /imports/:job_id/apply` (Idempotency-Key). Rows commit to target table.
7. Or **Cancel** → `POST /imports/:job_id/cancel`.
8. `/imports/:job_id/result.jsonl` streams applied-row output.

### 5.15 Bulk export

1. Sidebar → [/exports](apps/frontend/app/(app)/exports/page.tsx) → **New export**.
2. Choose resource + filters → `POST /exports` (ADMIN, `exportDownloadLimiter` 10/min). Backend queues job.
3. Poll `GET /exports/:job_id` for status.
4. When COMPLETED, click **Download** → `GET /exports/:job_id/download` streams CSV/JSONL.
5. Cancel available → `POST /exports/:job_id/cancel`.

### 5.16 Sending a message from template

1. Open [/students/[id]](apps/frontend/app/(app)/students/[id]/page.tsx) → Messages tab.
2. Click **Send from template** → dialog lists tenant's `message_templates`.
3. Pick template → frontend POSTs `/students/:studentId/messages/from-template/preview` to dry-render with variable substitution.
4. Preview OK → click **Send** → `POST /students/:studentId/messages/from-template`. Server inserts `CommsMessage` with status QUEUED.
5. `jobs/commsDispatcher.ts` picks up QUEUED, calls Resend for EMAIL. On send → status SENT + provider_id + sent_at. On fail → attempts incremented, next_retry_at scheduled (5min → 30min → terminal).

### 5.17 Reading the inbox

1. Sidebar → [/inbox](apps/frontend/app/(app)/inbox/page.tsx) or app-bar notifications bell.
2. Tabs: **Tasks** (reminders), **Expiring** (expiries), **Messages** (comms).
3. Messages tab: `GET /inbox/messages` returns per-user IN_APP messages (tenant-scoped, recipient=self).
4. Click row → auto-marks read via `POST /inbox/messages/:id/read`.
5. Mark all read → `POST /inbox/messages/read-all` (both endpoints have `inboxMutationLimiter`).

### 5.18 Snoozing / dismissing a reminder

1. Inbox → Tasks tab.
2. Row → Actions:
   - **Acknowledge** → `POST /reminders/:id/acknowledge` (kept for records).
   - **Snooze** → dialog picks new datetime → `POST /reminders/:id/snooze { snooze_until }`.
   - **Dismiss** → `POST /reminders/:id/dismiss`.
3. All limited to ADMIN/COUNSELLOR. Delete (`DELETE /reminders/:id`) is ADMIN-only.

### 5.19 Creating a fee plan (billing)

1. Sidebar → [/billing](apps/frontend/app/(app)/billing/page.tsx) (visible only when ADMIN + `tenant.billing_enabled=true`).
2. Click **New plan** → dialog with student + course + total_minor + currency + installments schedule → `POST /billing/plans` with Idempotency-Key.
3. Server creates FeePlan + child FeeInstallments.
4. UI shows plan row with status ACTIVE.

### 5.20 Recording a payment against a plan

1. Open plan detail.
2. Click **Record payment** → dialog with amount + method + `received_on` → `POST /billing/payments` with Idempotency-Key.
3. Server creates `Payment` row + `PaymentAllocation` rows per installment (FIFO by due_date).
4. Installment statuses recompute (INVOICED → PARTIAL → PAID).
5. Audit event `billing.payment.recorded` written.

### 5.21 Voiding a payment (destructive)

1. Payment row → **Void** menu → confirm dialog + MFA prompt.
2. `POST /billing/payments/:id/void` requires `X-MFA-Code` + Idempotency-Key. ADMIN only.
3. Server flips payment to VOIDED, reverses allocations, reverts installment sums.

### 5.22 Issuing a refund

1. Payment row → **Refund** → dialog with amount ≤ payment.gross_minor + reason.
2. `POST /billing/payments/:id/refunds` — ADMIN + MFA + Idempotency-Key. Creates `Refund` row status REQUESTED.
3. Later: complete flow via **Complete refund** → `POST /billing/refunds/:id/complete` (external disbursement confirmed) — flips refund COMPLETED + payment status REFUNDED/PARTIAL_REFUND.
4. Or fail via **Fail refund** → `POST /billing/refunds/:id/fail`.

### 5.23 Auditing a change

1. Sidebar → Compliance → [/audit](apps/frontend/app/(app)/audit/page.tsx).
2. Filter by actor / entity_type / action / date range → `GET /audit-logs`.
3. Click row → shows request_id, before/after JSON (envelope-encrypted at rest, decrypted for display).
4. Click **Verify chain** → `GET /audit-logs/verify` (5/min limit). Server recomputes SHA-256 hash chain per tenant, returns `broken_count`.
5. `GET /audit-logs/anchors` returns nightly Merkle roots; external WORM system compares.

### 5.24 Logging a data-subject access request (DSAR)

1. Sidebar → Compliance → [/dsar](apps/frontend/app/(app)/dsar/page.tsx) → **New DSAR**.
2. Pick type (ACCESS / ERASURE / PORTABILITY / RESTRICTION / OBJECTION / RECTIFICATION) + subject identifier + requested_at → `POST /dsar` with Idempotency-Key + `dsarLimiter` 20/min.
3. Server writes `DSARRequest` with `due_by` per statutory clock (30/60/90 days depending on type + jurisdiction).
4. Row appears in list. Assign, then advance:
   - **Start** → PATCH status=IN_PROGRESS.
   - **Complete** → PATCH status=COMPLETED.
5. For ACCESS/PORTABILITY: **Export bundle** → `GET /dsar/:id/export` mints 24h single-use token; then browser follows `/dsar/:id/export/download?token=` to stream the subject's data package.

### 5.25 Public DSAR intake (anonymous)

1. Data subject visits [/legal/dsar](apps/frontend/app/(public)/legal/dsar/page.tsx).
2. Form collects subject identifier, request type, contact channel.
3. `POST /api/v1/public/dsar` (no auth, router's own rate limiter).
4. Backend creates `DSARRequest` with `source=PUBLIC_INTAKE`, notifies DPO via configured channel.

### 5.26 Recording a breach incident

1. Sidebar → Compliance → [/breach-incidents](apps/frontend/app/(app)/breach-incidents/page.tsx) → **New breach**.
2. Fill detected_at, severity, affected_subjects_count, summary → `POST /breach-incidents` with Idempotency-Key.
3. Server writes `BreachIncident` with `due_by = detected_at + 72h` (GDPR Art. 33 clock).
4. Advance:
   - **Mark reported** → confirm dialog (added in `54da9c8`) → PATCH `{ status: 'NOTIFIED', regulator_reported_at }`.
   - **Mark closed** → confirm dialog → PATCH `{ status: 'CLOSED', closed_at }`.
5. `DELETE /breach-incidents/:id` returns 405 — regulator-facing evidence, cannot be deleted.

### 5.27 Managing consent records

1. Sidebar → Compliance → [/consents](apps/frontend/app/(app)/consents/page.tsx).
2. **Create consent** → subject + purpose + lawful_basis + granted (bool) + justification → `POST /consents` (ADMIN, COUNSELLOR).
3. **Revoke** (Art. 7(3)) → `POST /consents/:id/revoke` — VIEWER can revoke their own subject's consents; ADMIN/COUNSELLOR revoke any.

### 5.28 Managing sub-processors (Art. 28)

1. Sidebar → Compliance → [/sub-processors](apps/frontend/app/(app)/sub-processors/page.tsx) (ADMIN).
2. CRUD `POST/GET/PATCH/DELETE /sub-processors`.
3. Regulator export via `GET /admin/ropa.csv` includes both active + removed processors with retirement dates (Art. 30(2)).

### 5.29 Reviewing user activity + revoking sessions

1. Sidebar → Admin → [/users](apps/frontend/app/(app)/users/page.tsx) → click user.
2. See recent sessions + login history (from audit log filter).
3. **Revoke all sessions** → `POST /users/:id/sessions/revoke` (ADMIN + MFA). Backend revokes all `refresh_tokens` for the user + logs them out on next access-token expiry (~15 min max).

### 5.30 Configuring tenant workspace

1. Sidebar → [/settings](apps/frontend/app/(app)/settings/page.tsx) (ADMIN sees workspace section).
2. Fields: name, legal_name, default_locale, default_timezone, default_currency, email_from, billing_enabled.
3. Save → `PATCH /tenants/me` (via `withTenantTx` — RLS-safe under `spv_app` role).
4. `billing_enabled` toggle busts the frontend billing-flag cache; sidebar Billing entry appears/disappears immediately.

### 5.31 Running a report (analytics)

1. Sidebar → Admin → [/reports](apps/frontend/app/(app)/reports/page.tsx) (ADMIN).
2. Pick report:
   - **Visa funnel** — `GET /reports/visa-funnel?visa_type_id=`.
   - **Counsellor load** — `GET /reports/counsellor-load?include_inactive_users=`.
   - **Commission revenue** — `GET /reports/commission-revenue?from=&to=&currency=`.
   - **Refund rate** — `GET /reports/refund-rate?from=&to=`.
   - **Outstanding by age** — `GET /reports/outstanding-by-age?currency=`.
3. `heavyReadLimiter` 60/min guards against polling abuse.
4. Date range clamped to 3-year past-max.

### 5.32 Managing lifecycle stages (per tenant)

1. Sidebar → Admin → [/stages](apps/frontend/app/(app)/stages/page.tsx).
2. Table of stages with `sequence`, `category`, `is_initial`, `is_terminal`, `sla_hours`, `visa_type_id`, `color_hex`, `show_on_dashboard`.
3. Actions:
   - **Create stage** → `POST /stages` (ADMIN).
   - **Edit** → `PATCH /stages/:id`.
   - **Delete** → `DELETE /stages/:id`.
   - **Reorder** → drag & drop → `POST /stages/reorder`.
   - **Preview impact** → `POST /stages/preview-impact` dry-runs reorder + shows affected student counts before commit.
4. Manage transitions: `POST /stages/transitions`, `DELETE /stages/transitions/:id`.

### 5.33 Managing visa types (per country × visa)

1. Sidebar → Admin → [/visa-types](apps/frontend/app/(app)/visa-types/page.tsx).
2. CRUD `/visa-types` (ADMIN write; any role can read — needed by student editors).

### 5.34 Managing message templates

1. Sidebar → Admin (Comms sub-page) — or `/message-templates` route.
2. Templates carry `subject_template`, `body_template`, `variables` (placeholders like `{{student.given_name}}`).
3. `POST /message-templates` (ADMIN), `PATCH /message-templates/:id` (ADMIN), `DELETE /message-templates/:id` (ADMIN).
4. Preview + send from student detail's Messages tab (§5.16).

### 5.35 Monitoring outbox health

1. Sidebar → Admin → [/admin/outbox](apps/frontend/app/(app)/admin/outbox/page.tsx) (ADMIN).
2. Widgets:
   - `GET /admin/comms/outbox/health` — queue depth, error rate, oldest QUEUED.
   - `GET /admin/comms/outbox/trend` — 24h send trend.
   - `GET /admin/comms/outbox/metrics` — per-provider metrics.
   - `GET /admin/comms/outbox/messages` — list QUEUED/FAILED with error details.
3. Actions:
   - **Requeue all** → `POST /admin/comms/outbox/requeue-all`.
   - Per-row **Requeue** → `POST /admin/comms/outbox/:id/requeue`.

### 5.36 Handling a Resend webhook (async)

1. Resend fires HTTP POST to `/api/v1/webhooks/resend` with svix-signed body.
2. Router parses raw body (before global JSON parser), verifies HMAC against `RESEND_WEBHOOK_SECRET`.
3. Updates matching `CommsMessage` (via `provider_id`): sets `bounce_type`, `complaint_at`, or `delivered_at`.
4. If bounce, opts user out of that channel (records in `CommsPreference`).

### 5.37 One-click unsubscribe (RFC 8058)

1. Recipient clicks List-Unsubscribe URL in email footer.
2. Browser POSTs to `/api/v1/comms/unsubscribe/:token` (HMAC-signed token, no auth).
3. Server verifies HMAC, records unsubscribe for the (user, purpose) tuple, returns confirmation page.

### 5.38 Logging in a fresh browser after refresh cookie present

1. Browser hits any authenticated route → old access token missing.
2. Frontend axios interceptor sees 401, tries `POST /auth/refresh` once (single-flight — [apps/frontend/lib/api.ts:147-165](apps/frontend/lib/api.ts)).
3. If refresh cookie valid + within idle timeout (`last_used_at > now - 30min`), server rotates refresh (old row `replaced_by_id`), returns new access token, sets new refresh cookie.
4. Original request retried with new access token.
5. If refresh is a replay (row's `replaced_by_id` already set), server marks the whole token family compromised, revokes all — forces re-login.

### 5.39 Discovering keyboard shortcuts

1. Any authenticated page → press `?` → shortcuts overlay appears.
2. `Cmd/Ctrl+K` → CommandPalette (global search + nav).
3. Other bindings from [apps/frontend/components/KeyboardShortcuts.tsx](apps/frontend/components/KeyboardShortcuts.tsx).

### 5.40 Switching theme + locale

1. App-bar → theme icon → Light / Dark / System.
2. Sidebar footer or Settings → language dropdown → English / العربية / हिन्दी / नेपाली.
3. `POST` to `set-locale` server action; cookie set; Next.js re-renders with new messages.
4. `ar` locale switches Drawer anchor to right (RTL).

### 5.41 Signing out (this device vs everywhere)

1. App-bar → profile menu → **Sign out** — clears refresh cookie + denylists current access token JTI.
2. For "sign out everywhere":
   - ADMIN sees CTA **Sign out everywhere** in Settings → Security. Fires `POST /users/:id/sessions/revoke` on self (revokes all live refresh tokens for the account).
   - Non-ADMIN sees only **Sign out of this device** — one-off (§54da9c8 fix).

### 5.42 Onboarding new counsellor

1. ADMIN creates user via [/users](apps/frontend/app/(app)/users/page.tsx) → **New user** → email + given/family name + role=COUNSELLOR.
2. `POST /users` inserts row (no password yet).
3. ADMIN clicks **Reset password** → `POST /users/:id/reset-password` (needs admin MFA). Sends email with reset link.
4. Counsellor clicks link → [/reset-password?token=](apps/frontend/app/(auth)/reset-password/page.tsx) → sets password.
5. Counsellor logs in → dashboard scoped to their caseload (empty until admin assigns them leads/students via `PATCH /leads/:id { assigned_to_id }`).

### 5.43 Rotating JWT signing keys

Documented in [infra/docs/runbooks/jwt-key-rotation.md](infra/docs/runbooks/jwt-key-rotation.md). Three-slot keyset (PRIMARY signs, NEXT accepts, PREV accepts) with graceful rotation. No user-visible flow — invisible to end users unless rotation ties across refresh cookie TTL.

### 5.44 First-run tenant seeding (deploy time)

1. `.do/app.yaml` PRE_DEPLOY `migrate` job runs `prisma migrate deploy && prisma seed`.
2. Seed reads `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_TENANT_NAME` from env.
3. `ensureTenant` upserts a Tenant with that name (RLS-aware — wraps in `withTenantTx`).
4. `ensureAdminUser` upserts the admin user (bcrypts password, role=ADMIN).
5. Both are idempotent — re-running on every deploy is safe.
6. Backend env schema (`env.ts:94-95`) requires SEED_ADMIN_* at boot too — server fails-fast if missing in prod.

### 5.45 Retention erasure (background)

Daily job `jobs/retentionErasure.ts` at 03:00 UTC:
1. Reads `DocumentType.retention_days` per document type.
2. Marks documents past retention as soft-deleted (`deleted_at` set).
3. A follow-up purge pass removes physical S3 objects after grace period.
4. Audit log rows are NEVER purged (regulator retention = 7 years / 10 years for breaches).

---

## 6. Role-specific playbooks

### 6.1 ADMIN — daily rhythm

- Open dashboard. Check onboarding checklist state (once done, dismissable via localStorage).
- Review SLA breaches widget — click **Reassign** on any red rows.
- Review engagement-at-risk students — send templated message if attendance <80%.
- Sidebar → **Leads** → click **Sync from V2** if the last-run chip shows >24h ago.
- Scan new visa-accepted rows — assign to counsellors via lead detail's Overview tab.
- Sidebar → Admin → **Outbox** → check comms health widget for stuck FAILED rows; requeue if the provider was down.
- Weekly: run **Reports → Refund rate + Outstanding by age** to catch billing anomalies.
- Weekly: Compliance → **Audit → Verify chain** — confirm 0 breaks.
- Monthly: **Sub-processors** → confirm any new contracts recorded before their DPA effective date.

### 6.2 COUNSELLOR — daily rhythm

- Open dashboard. Filtered to own caseload (backend enforces via `assigned_to_id = self`).
- Inbox → Tasks tab → work through today's reminders (acknowledge / snooze / dismiss).
- Inbox → Expiring tab → for each expiring artifact, open student → refresh/replace the document → mark verified.
- Sidebar → **Students** → filter by stage → advance stages as milestones hit.
- Sidebar → **Leads** → for own-assigned rows: add notes, mark fees paid, waive when justified.
- Add engagement checks weekly per attendance-monitored student.

### 6.3 VIEWER — permitted rhythm

- Read dashboard + leads + students + inbox.
- Can revoke consents on own subject records (Art. 7(3) right-to-withdraw at self-service level).
- Cannot write anything else. Every non-GET verb 403's globally.

### 6.4 Emergency runbook — user locked out of MFA

- Precondition: user lost both TOTP device AND every recovery code.
- Step 1: ADMIN opens [/users](apps/frontend/app/(app)/users/page.tsx) → target user → **Force-disable MFA**.
- Step 2: MFA prompt appears — admin enters own `X-MFA-Code`.
- Step 3: `POST /users/:id/mfa/disable` — target user's `mfa_enabled=false`, `mfa_secret_enc` cleared.
- Step 4: Target user logs in with password → prompted to re-enrol via Settings.

### 6.5 Emergency runbook — outbox stuck

- Symptom: emails not being delivered; outbox health shows growing QUEUED depth.
- Step 1: Sidebar → Admin → Outbox. Check per-provider metrics for error codes.
- Step 2: If provider down (Resend outage), wait. Backoff will resume.
- Step 3: If FAILED rows with recoverable errors, click **Requeue all**.
- Step 4: If configurations wrong (RESEND_WEBHOOK_SECRET missing → 401), operator sets secret in DO dashboard + redeploys backend service.

### 6.6 Emergency runbook — audit chain break

- Symptom: `GET /audit-logs/verify` returns `broken_count > 0`.
- Root cause: either DB was restored from an incomplete backup, or someone tampered with `audit_logs` bypassing triggers.
- Step 1: Snapshot current audit_logs.
- Step 2: `GET /audit-logs/anchors` — find last-known-good Merkle root.
- Step 3: Cross-reference with external WORM copy of anchors.
- Step 4: File a breach incident (regulator notification: yes, evidence tampered).
- Step 5: Investigate DB access logs via `pg_stat_activity` archive.

---

## 7. Verification checklist

Every claim in this document was verified against code at commit `f8b2826`.

| Claim | Verified by |
|---|---|
| 3 roles (ADMIN, COUNSELLOR, VIEWER) | [packages/zod-schemas/src/common.ts:98](packages/zod-schemas/src/common.ts) |
| VIEWER blocked from non-GET | [apps/backend/src/middlewares/auth.ts:63-65](apps/backend/src/middlewares/auth.ts) |
| Ownership guard middleware | [apps/backend/src/middlewares/auth.ts:150-210](apps/backend/src/middlewares/auth.ts) |
| MFA step-up on user mutations | [apps/backend/src/modules/users/users.routes.ts:33-62](apps/backend/src/modules/users/users.routes.ts) |
| MFA step-up on billing money-movers | [apps/backend/src/modules/billing/billing.routes.ts:152-251](apps/backend/src/modules/billing/billing.routes.ts) |
| Idempotency-Key on money paths | [apps/backend/src/modules/crm-leads/crm-leads.routes.ts:70-80](apps/backend/src/modules/crm-leads/crm-leads.routes.ts), [billing.routes.ts:164-267](apps/backend/src/modules/billing/billing.routes.ts), [students.routes.ts:80-93](apps/backend/src/modules/students/students.routes.ts) |
| V2 sync advisory lock | crm-leads.service.ts triggerSync + jobs/runner.ts `runJob` |
| RLS enforced at DB layer | [apps/backend/prisma/migrations/20991231235959_init_rls_and_triggers/migration.sql](apps/backend/prisma/migrations/20991231235959_init_rls_and_triggers/migration.sql) |
| Runtime role assertion | [apps/backend/src/config/db.ts:69-102](apps/backend/src/config/db.ts) |
| Audit hash chain with FOR UPDATE lock | [apps/backend/prisma/migrations/20991231235996_audit_chain_for_update/migration.sql](apps/backend/prisma/migrations/20991231235996_audit_chain_for_update/migration.sql) |
| Frontend axios injects Idempotency-Key | [apps/frontend/lib/api.ts:117](apps/frontend/lib/api.ts) |
| Sidebar structure | [apps/frontend/components/AppShell.tsx:108-146](apps/frontend/components/AppShell.tsx) |
| Locale support en/ar/hi/ne | [apps/frontend/messages/](apps/frontend/messages/), [apps/frontend/i18n/request.ts](apps/frontend/i18n/request.ts) |
| Billing double-gate (admin + tenant.billing_enabled) | [apps/backend/src/modules/billing/billing.routes.ts:44](apps/backend/src/modules/billing/billing.routes.ts), [AppShell.tsx:130-132](apps/frontend/components/AppShell.tsx) |
| Breach DELETE 405 | [apps/backend/src/modules/breach/routes.ts:27-34](apps/backend/src/modules/breach/routes.ts) |
| Consent revoke open to VIEWER (own subject) | [apps/backend/src/modules/consent/routes.ts:24](apps/backend/src/modules/consent/routes.ts) |
| DSAR intake requires Idempotency-Key | [apps/backend/src/modules/dsar/routes.ts:20-26](apps/backend/src/modules/dsar/routes.ts) |
| Metrics guarded by METRICS_TOKEN | [apps/backend/src/app.ts:363-372](apps/backend/src/app.ts), [apps/backend/src/config/env.ts:272-280](apps/backend/src/config/env.ts) |
| Documents pipeline (MIME → ClamAV → encrypt → S3) | [apps/backend/src/modules/documents/documents.service.ts](apps/backend/src/modules/documents/documents.service.ts), [documents.routes.ts](apps/backend/src/modules/documents/documents.routes.ts) |
| Sentry single-capture (scoped) | [apps/backend/src/config/sentry.ts:167-180](apps/backend/src/config/sentry.ts), [apps/backend/src/middlewares/errorHandler.ts:61-66](apps/backend/src/middlewares/errorHandler.ts) |
| Shared withTenantTx used by 6 sites | [apps/backend/src/shared/tenantTx.ts](apps/backend/src/shared/tenantTx.ts) |

**Outstanding gaps** (tracked in [SPVT-QA-REMEDIATION.md](docs/SPVT-QA-REMEDIATION.md) §Deferred): Student PII envelope encryption, KEK versioning, access-token denylist on password change, usersService raw prisma refactor, real-Postgres RLS test, frontend unit tests, backups + wet-restore drill, ClamAV production wiring.

---

*Document maintained by the SPVT team. If you find a discrepancy between this document and the code, the code wins — file a fix commit and update this file in the same PR.*
