# Page-by-page audit — objectives · functions · business logic · international-standard (2026-06-08)

3-agent audit, claims verified (agent errors corrected). **Overall: a mature, well-architected system** — dual RBAC gates + RLS, MFA step-up on money-movers, FSM-guarded billing, tamper-evident hash-chained audit, full GDPR tooling, billing idempotency. Per-page ratings 7–9.5/10. Findings below are mostly polish/edge-cases, not broken features.

---

## Primary nav

### Dashboard (`/`)
- **Objective:** role-scoped executive overview (KPIs, pipeline, expiries, SLA breaches, GDPR clocks, onboarding).
- **Functions:** view totals/active/expiries/recent-events/unread; SLA-breach drill; onboarding checklist; density toggle.
- **Business logic:** ADMIN = tenant-wide, COUNSELLOR = own caseload (`assigned_to_id`), VIEWER = read-only. SLA breach = `(now − stage_entered_at) > stage.sla_hours`, excludes WITHDRAWN/COMPLETED. Onboarding = 8 derived steps, 60s cache.
- **Rating 7/10. Gaps:** SLA clock doesn't pause for `ON_LEAVE` (false breaches); SLA recomputed against *current* `stage.sla_hours` (changing it retro-flags everyone); onboarding cache not invalidated on create; timezone of `expires_on` ambiguous.

### Students (`/students`, `/students/[id]`)
- **Objective:** the managed-student system of record (master list + 5-tab detail).
- **Functions:** search/filter (stage/status/SLA), bulk-select+export (PII-redacted for counsellor), column prefs, quick-create (`c`); detail tabs Profile/Journey/Studies/Records/Billing with full CRUD on every sub-entity; stage advance (FSM); documents (upload/verify/download).
- **Business logic:** cursor pagination `(created_at,id)`; ownership-gated (COUNSELLOR own-assigned, ADMIN all); stage transitions via `studentFsm` (terminal-state guards); completeness % (informational).
- **Rating 8/10. Gaps:** student PATCH lacks optimistic-lock/If-Match (lost-update risk on concurrent edits — *verify*); completeness not enforced; SLA-filter pagination uses created_at not breach-severity.

### Leads (`/leads`, `/leads/[id]`, `/leads/institutions`)
- **Objective:** read-only V2 CRM mirror — visa-accepted application queue + post-visa fees + convert-to-student.
- **Functions:** list (search/intake/assignee/upcoming-fee), sync (ADMIN, rate-limited), detail tabs, fee lifecycle (add/pay/waive/delete), convert→student (ADMIN), CRM catalog report (institutions+courses tabs).
- **Business logic:** scope = visa-accepted only (`state_v2='visa_accepted'`, normalized from legacy free-text); fees per-lead (SPVT-owned) seeded idempotently; **convert creates a Student + migrates fees, does NOT auto-create an Enrollment** (deliberate — won't fabricate catalog rows). Fees OCC via If-Match; create idempotent.
- **Rating 8/10. Gaps:** crm catalog vs app catalog unlinked (no reconciliation); fees keyed per-lead not per-application; no dedup vs manually-added students.

### Inbox (`/inbox`)
- **Objective:** consolidated action centre — Tasks (reminders) / Expiring / Messages / Threads.
- **Functions:** 4 clickable KPI tiles; reminder ack/snooze/dismiss; expiry triage (kind + window filters); threads browser (real `unread_count`).
- **Business logic:** reminders from the scanner; expiry severity overdue/critical(≤14)/warning(≤30). Messages KPI is an **intentional placeholder** (recent-students proxy until comms unread; honestly commented) — real unread is in Threads.
- **Rating 7/10. Gaps:** KPI counts stale until tab re-fetch; some tile labels hardcoded (i18n); messages KPI could use the real threads unread now that it ships.

### Calendar (`/calendar`)
- **Objective:** visual expiry timeline (visa/passport/insurance/document) — month heatmap + week list.
- **Functions:** month/week toggle, 30/60/90/180d window, kind filters (≥1 enforced), month nav, urgency colour+icon (WCAG-safe).
- **Business logic:** sources `/dashboard/expiries`; 42-cell grid; cells cap 3 + "+N more".
- **Rating 8/10. Gaps:** `expires_on` timezone ambiguity (off-by-one across zones); heatmap cell truncation has no "see all" path; no cell→detail deep-link to the expiring record.

### Institutions (`/institutions`, `/institutions/[id]`)
- **Objective:** curated institution/campus/school/department catalog (drives student enrollments).
- **Functions:** list (search/country/partner) + KPIs; detail tabs (identifiers/accreditations/contacts/campuses/schools→departments/programs/super-agents); full ADMIN CRUD; URL `safeHref` allowlist.
- **Business logic:** identifier upsert on `(institution_id, scheme)`; soft-delete + `is_active`; tenant-scoped.
- **Rating 8/10. Gaps:** no uniqueness on primary-contact / main-campus (multiple can be "primary"); no `expires_on ≥ awarded_on` check on accreditations; program list in detail caps 100 silently; institution dedup not enforced on UI create.

### Courses (`/programs` — nav "Courses", `/programs/[id]`)
- **Objective:** course catalog with intakes, fees, requirements, modules.
- **Functions:** list (search/institution/level/country/ISCED/language) + create; detail tabs; intake clone (copies fees); nested CRUD.
- **Business logic:** dedup `(institution_id, name, level)`; intake key `(program_id, campus_id, year, month)`; fees per intake.
- **Rating 8/10. Gaps:** ISCED accepts any 4 digits (not validated against ISCED-F); `duration_months` no range guard; intake clone not idempotent (re-click duplicates fees); language free-text (BCP-47 not validated).

### Imports (`/imports`, `/imports/new`)
- **Objective:** bulk-load students/institutions/programs/enrollments/program_fees (dry-run → apply).
- **Functions:** wizard (resource→upload→dry-run→apply→done), mapping editor, encoding/delimiter sniff, error/result JSONL, re-apply/cancel.
- **Business logic:** ADMIN-only upload+apply (rate-limited, 50MB); dedup/upsert per entity on DB unique keys; dry-run is read-only.
- **Rating 8/10. Gaps:** no within-file dedup (duplicate rows → last-wins silently); apply idempotency unverified; empty-file (header-only) succeeds with 0 rows silently; dry-run↔apply can drift on concurrent catalog edits.

---

## Admin + Compliance + Settings

### Admin hub (`/admin`) + sub-pages
- **Objective:** config + ops + compliance launchpad (12 sub-areas). **Rating 8/10.**
- **Users:** activate/deactivate/delete/revoke-sessions/disable-MFA — ADMIN + **MFA step-up**. **Stages/Visa-types/Commissions/Catalog/Super-agents:** CRUD, ADMIN-gated. **Reports/Exports:** async jobs. **Tenants:** own-tenant only (no cross-tenant browse — privacy by design, 9/10). **Outbox:** delivery monitor + requeue.
- **Outbox gap (real):** per-row + bulk requeue have **no idempotency or confirm dialog** → double-click / mis-click re-queues twice / en-masse. *Verify backend route, add confirm.*

### Billing (`/billing`)
- **Objective:** collections triage (aged debt / receipts / refund queue). **Rating 7.5/10.**
- **Business logic:** 4 FSMs (FeePlan/Installment/Payment/Refund) with terminal guards + mandatory reasons; money allocation `FOR UPDATE`-locked, `SUM(alloc) ≤ gross`, per-installment `≤ balance`, overflow→StudentCredit; receipt # via Postgres sequence; **MFA step-up + idempotency** on refund/void/complete. Strong financial integrity.
- **Gaps:** aged-debt single-currency per query; no batch reconcile; refund-dialog detail can be stale; no date/status filters on receipts.

### Compliance — Audit / DSAR / Breach / Consents / Sub-processors
- **Audit (9.5/10):** INSERT-only (DB trigger) + SHA-256 hash chain + verify function; encrypted before/after omitted from read API; actor/IP/UA HMAC-hashed. *Gap:* verify is on-demand (no nightly cron + alert); hashed IP defeats geo-anomaly detection.
- **DSAR (8/10):** 6 GDPR types, 30-day SLA clock, status FSM, signed 24h export (ACCESS/PORTABILITY), atomic Art.17 erasure. *Gap:* export-generation lag has no async status UI.
- **Breach (8.5/10):** 72h Art.33 clock, severity, lifecycle, dashboard feed. *Gap:* no regulator-notification integration/log; no affected-count sanity check.
- **Consents (7.5/10):** Art.6 lawful-basis register, granted/revoked timestamps, self-scoped for non-admins. *Gap:* no justification field (LEGITIMATE_INTEREST needs a balancing test); no pagination.
- **Sub-processors (8/10):** Art.28 register + ROPA CSV (incl. removed), `safeHref`. *Gap:* no DPA-attestation / transfer-mechanism fields.

### Settings (`/settings`)
- **Objective:** profile · MFA · tenant settings · appearance. **Rating 8.5/10.**
- **MFA:** 3-step enroll (password-gated → secret → verify + recovery codes), disable needs password+TOTP. *Gap:* no QR (manual secret entry — error-prone), recovery-code guidance thin.

---

## Cross-cutting — REAL prioritized findings (agent noise removed)

**P1 (worth doing):**
1. **SLA clock vs `ON_LEAVE`** — exclude/pause paused students or `stage_entered_at` makes false breaches. Align dashboard + students-list + sla-breaches endpoint.
2. **Outbox requeue** — add idempotency + a bulk-confirm dialog.
3. **Student PATCH optimistic lock** — verify If-Match/version; add if missing (lost-update on concurrent edits).
4. **Audit chain nightly verify + alert** — don't rely on on-demand.

**P2 (data quality / polish):**
5. Primary-contact / main-campus uniqueness constraints.
6. Within-file import dedup + empty-file warning; verify apply idempotency.
7. ISCED-F + BCP-47 validation; intake-clone idempotency; accreditation date order.
8. i18n: replace remaining hardcoded UI strings.
9. Timezone semantics for `expires_on` (return + render explicitly).

**P3 (compliance polish):** consent justification field; sub-processor DPA/transfer fields; retention-job confirmation; DSAR export async status; MFA QR.

**Corrected agent errors (NOT bugs):** convert does *not* auto-create an enrollment (by design); inbox messages KPI is an intentional commented placeholder; `.env` not in git.

---
*Verdict: launch-grade architecture. No P0 code blockers in-app (P0 launch items are operator infra — see DEPLOYMENT-READINESS.md). The above are hardening/polish.*
