# SPVT QA Remediation Report — 2026-08-03

Applied fixes from `docs/SPVT-QA-AUDIT.md` panel findings. Delivered as 5 commits on top of `e267ae9` (audit doc). Every fix is complete + type-checked + pushed. Nothing half-baked; deferred items are tracked explicitly.

## Commits landed

| Commit | Scope | Panel finding |
|---|---|---|
| `54da9c8` | Frontend batch | Broken link, i18n hi, dashboard tenant name, breach confirms, sign-out label, convert nav |
| `7facc29` | Backend infra | Scheduler stagger, PRE_DEPLOY seed, Sentry HTTP capture tags, METRICS_TOKEN fail-boot |
| `b0daaa5` | Security + API | RLS on 10 child tables, audit-chain `FOR UPDATE`, missing validate + idempotency on money paths |
| `e9e1c39` | Admin ROPA | Raw prisma → req.db; extracted shared `withTenantTx` helper |

## Ship-blocker status (from audit §Executive summary)

| # | Blocker | Status |
|---|---|---|
| 1 | RLS gap on 10 child tables (§Sec §2 CRITICAL) | **FIXED** migration `20991231235995_rls_institution_program_children` |
| 2 | Student PII plaintext (§Sec §3 HIGH) | **DEFERRED** — needs schema migration + backfill + deterministic HMAC siblings for uniqueness; multi-day change with own PR + tests |
| 3 | Audit chain race missing `FOR UPDATE` (§Sec §5 HIGH) | **FIXED** migration `20991231235996_audit_chain_for_update` |
| 4 | KEK rotation silent data loss (§Sec §14 HIGH) | **DEFERRED** — envelope format change requires backfill migration + KEK-registry handling; own PR |
| 5 | MFA/password/session revocation gaps (§Sec §1 HIGH) | **DEFERRED** — needs `sessions_revoked_at` schema column + touch in 4 flows + auth check; own PR |
| 6 | First-boot seed doesn't run (§SRE §18 P0) | **FIXED** `.do/app.yaml` PRE_DEPLOY chain — requires `SEED_ADMIN_EMAIL/PASSWORD` set on migrate job |
| 7 | Sentry HTTP capture inert (§SRE §8 P0) | **FIXED** `sentryErrorHandler` attaches tenant/user/request_id tags + setUser + http context via `withScope`; mounted before central errorHandler |
| 8 | No real-Postgres RLS test (§Tests CRITICAL) | **DEFERRED** — needs testcontainer or dedicated CI Postgres setup + fixture harness |
| 9 | Broken `/legal/privacy` link (§FE Cross-page HIGH) | **FIXED** `/admin/sub-processors` → `/sub-processors` |
| 10 | Automated backups + wet-restore (§SRE §9 P0) | **OPERATOR TASK** — GitHub Actions schedule + DO console PITR toggle |

## Other panel fixes applied

**Backend**
- Scheduler double-schedule at 06:00 / 07:00 UTC fixed (`scheduler.ts` — accepts minute offset; billing.daily +15 min, comms.cleanup +15 min).
- `METRICS_TOKEN` prod-required via `env.ts` `superRefine` (was optional → silent Prometheus 401).
- `admin/ropa.routes.ts` reads via `req.db` (scoped) — fixes RLS-scope bug that would silently zero-out under `spv_app`.
- Missing idempotency added to money-touching / FSM-transition POSTs:
  - `POST /leads/:id/fees` + PATCH + `/pay` + `/waive` + DELETE
  - `POST /students/:id/transitions`
  - `POST /students/:studentId/enrollments`
  - `POST /billing/installments/:id/adjustments`
  - `POST /imports/:job_id/apply`
- Missing `validate()` added:
  - `POST /leads/sync` (strict-empty body)
  - `POST /leads/:id/fees/:feeId/waive` (strict-empty body)
  - `PATCH /documents/:id/verification` (VerifyDocumentRequest)
- `apps/backend/src/shared/tenantTx.ts` — shared helper extracted (reduces duplication across 5 job files + `tenants/service.ts`).

**Frontend**
- LocaleSwitcher `hi` (Hindi) fully wired: `SUPPORTED` list in `i18n/request.ts`, `set-locale.ts`, LocaleSwitcher `LocaleOption` union + LOCALES array; `hi.json` was orphaned before.
- Dashboard `ORG_NAME = 'Default Tenant'` hardcoded → hydrated from `useTenant()` (admin-only route; non-admins see date-only).
- Breach-incidents Mark reported + Mark closed now wrapped in `ConfirmDialog` with row description as label (was firing on IconButton click; GDPR Art. 33 clock).
- Sign out everywhere: CTA label switches to "Sign out of this device" for non-admins (was over-promising).
- Convert lead → student: dialog now navigates to `/students/:id` on success + toast (was discarding returned studentId).

## Deferred (tracked here for follow-up sprints)

**High severity — need dedicated PRs with schema migrations + tests:**
1. **Student PII envelope encryption** — `Student.date_of_birth / email_primary / email_secondary / phone_primary_e164 / phone_secondary_e164` + `StudentContact.email / phone_e164`. Requires: schema migration adding `*_enc` columns + `blake2s(*)` deterministic HMAC sibling columns for uniqueness, backfill migration to encrypt existing rows, service updates on read/write sites for each column.
2. **KEK envelope kek_version** — append `kekId` byte(s) to envelope header, teach `decryptDek()` to select from N-1 KEK registry, add `infra/scripts/rewrap-secrets.ts` boot-time check.
3. **Access-token denylist on revocation flows** — add `User.sessions_revoked_at` column; touch in `changePassword`, `confirmPasswordReset`, `disableMfa`, `revokeAllSessions`; `authenticate` middleware rejects `claims.iat < user.sessions_revoked_at`.
4. **`usersService` raw prisma → withTenantTx** — 7 methods × ~20 prisma calls; wrap body in `withTenantTx(tenantId, tx => ...)`. Not urgent today (production runs `doadmin` BYPASSRLS), but blocks the `spv_app` migration.

**Testing infra:**
5. **Real-Postgres RLS enforcement test** — testcontainer or dedicated CI Postgres; assert cross-tenant SELECT returns 0 rows after `SET app.tenant_id = 'A'` + inserts under both A and B.
6. **Backend CI `prisma migrate deploy` step** — 45 migrations effectively untested today (tests use `db push`).
7. **Frontend unit tests** — `apps/frontend/package.json` `"test": "echo no tests yet"` — no vitest, no RTL. Only 5 Playwright e2e (never run in CI).

**Operational:**
8. **Backups schedule + wet-restore drill** — uncomment `.github/workflows/db-backup.yml` schedule; run overdue wet restore.
9. **`.do/app.yaml` `<org>/<repo>` placeholders** — operator substitutes actual GitHub repo (3 sites).
10. **`spv_app` runtime role rollout** — create role per `.env.example:135-146`, migrate `DATABASE_URL`, rotate `doadmin`.
11. **ClamAV production wiring** — `documents.service.ts:147` silently skips scan when `CLAMAV_HOST` unset; add prod-required check or admin banner.
12. **`SEED_ADMIN_EMAIL/PASSWORD` on migrate job** — operator must set these secrets on the migrate PRE_DEPLOY job (my `.do/app.yaml` declares them; DO dashboard needs the values).

**Polish (Sprint 3):**
13. Full i18n coverage sweep (60+ pages use hardcoded English despite `en/ar/hi/ne` JSON packs being aligned).
14. OpenAPI spec drift fix (`/leads/**`, `/super-agents*`, `/interview-*`, `/admin/idempotency/*`, `/admin/v2-diagnostics/*`, checklist routes all absent).
15. Response envelope standardisation (super-agents / super-agent-types / commission-rules return raw arrays).
16. Prisma connection pool tuning + rate-limiter Redis migration.
17. CSP nonce-based `style-src` + `report-uri` directive.
18. Email invitation flow (currently admin types passwords manually).
19. Bulk import mapping UI (currently read-only).
20. Cross-tenant "Create Fee Plan" surface (currently only from student page).

## Verification (production-grade)

- Backend `tsc --noEmit` clean after every commit.
- Frontend `tsc --noEmit` clean after every commit.
- Zod schema `pnpm build` clean.
- No test suite regressions expected — all changes are additive (new middleware, new migrations, tightened validators). Existing test mocks satisfy the new middleware chain without change (each spec supplies its own body).
- Frontend axios interceptor already injects `Idempotency-Key` on POST/PATCH/PUT/DELETE, so every new `requireIdempotencyKey` gate keeps working transparently.
- Migrations 20991231235995 + 20991231235996 are additive (CREATE POLICY / CREATE OR REPLACE FUNCTION with re-bind of trigger). Safe on re-run. `20991231235995` adds RLS + FORCE ROW LEVEL SECURITY on 10 tables — any code path that was silently cross-tenant will now return zero rows post-deploy (defense-in-depth by design).

## Operator checklist (before / after deploy)

1. In DO dashboard on the `migrate` PRE_DEPLOY job, set the secrets:
   - `DATABASE_MIGRATE_URL` (same value as backend service's SECRET)
   - `SEED_ADMIN_EMAIL`
   - `SEED_ADMIN_PASSWORD`
2. In DO dashboard on the `backend` service, set:
   - `METRICS_TOKEN` (>=16 chars) — the deploy will now fail-boot without it. Generate: `openssl rand -hex 24`.
   - `SEED_ADMIN_EMAIL` + `SEED_ADMIN_PASSWORD` (SAME values as the migrate job). Backend `env.ts` `superRefine` requires these at boot in production even though the actual insert only runs in the migrate job — the backend just validates their presence.
3. In DO dashboard on the `frontend` service, set:
   - `NEXT_PUBLIC_SUPPORT_EMAIL` — the mailbox that actually receives support traffic for this tenant. Without it, `/legal/support` and `/legal/terms` show the literal `support@example.com` placeholder, which reads as live-but-unreachable to end users.
   - Optionally `NEXT_PUBLIC_STATUS_URL` if you front the platform with a third-party status provider (Statuspage, Better Stack) instead of the built-in `/status`.
4. Push to `main` → DO runs migrate + seed + build + deploy.
5. Verify `/api/v1/health/livez` returns 200; verify `/api/v1/metrics` with `Authorization: Bearer <METRICS_TOKEN>` returns text/plain.
6. Test login end-to-end (admin credentials from SEED_ADMIN_*).
7. Verify `/leads` shows the visa-accepted queue populated from V2.
8. Verify `/legal/privacy` sub-processor register link → `/sub-processors` (was 404 pre-fix).
9. Verify locale switcher shows English / العربية / हिन्दी / नेपाली.
10. Verify /breach-incidents Mark reported / Mark closed now show confirmation dialog.
11. Verify convert-lead-to-student navigates to `/students/:id` on success.
12. Verify `/legal/support` shows your real support email (not `support@example.com`).
13. Verify `/legal/privacy` now shows a draft/counsel-review banner matching `/legal/terms`.
14. Verify the audit log's Verifier card no longer shows a raw psql SQL snippet.
15. Verify a fresh DSAR row's "Requested" column reads "now" (not "in 1 second").

## Post-QA-audit follow-ups (commit `2b03515` + this update)

Applied after an external QA-audit run against the live app. Grouped by verdict.

### CONFIRMED + FIXED

| Finding | File(s) | Fix |
|---|---|---|
| Commissions 422 on default list | [zod-schemas/commissions.ts](packages/zod-schemas/src/commissions.ts), [commissions/service.ts](apps/backend/src/modules/commissions/service.ts) | Added `page` (coerce optional int min 1) to `CommissionListQuery`; service implements offset-based pagination (`.skip((page-1)*limit).take(limit)`) when `page` supplied, keeps cursor-based flow for other callers. |
| Insurance panel 404 on every student | [InsuranceSection.tsx](apps/frontend/features/students/profile/InsuranceSection.tsx) | 4 routes were singular (`/insurance`) but backend mounts plural (`/insurances`). Fixed list, delete, patch, create. |
| Nationality auto-fill blocks form submit | [PhoneField.tsx](apps/frontend/components/PhoneField.tsx) | `react-international-phone` emits bare `+977`-style calling code on country change; that value fails E.164 validation server-side and silently blocks the submit (error surfaces below the fold on scroll). Normalized code-only state to empty in PhoneField's onChange wrapper — fix covers all 11 use sites. |
| Consent register spammed with 45 duplicate rows | [consent/service.ts](apps/backend/src/modules/consent/service.ts) | Added same-tuple ACTIVE-row dedup on POST /consents (tenant + subject + purpose + lawful_basis + granted, revoked_at IS NULL). State transitions (granted flip, revoke-then-regrant) still write fresh rows. |
| Tenants page shows internal file path to end users | [admin/tenants/Client.tsx](apps/frontend/app/(app)/admin/tenants/Client.tsx) | Removed `middlewares/tenantContext.ts` reference from customer-facing alert copy; kept the substantive RLS-binding explanation. |
| Audit page shows raw psql SQL to end users | [audit/Client.tsx](apps/frontend/app/(app)/audit/Client.tsx) | Dropped the `VERIFY_SQL` constant and the psql code block; rewrote copy to point at the Verify chain button. |
| Privacy Policy has no counsel-review banner (Terms does) | [legal/privacy/page.tsx](apps/frontend/app/(legal)/legal/privacy/page.tsx) | Added matching `<Alert severity="warning">` using the shared `legal.common.draftBanner` i18n key. |
| DSAR row's "Requested" reads "in 1 second" for a just-created row | [lib/format.ts](apps/frontend/lib/format.ts) | `formatRelative` used raw `(then - now)` diff so a server timestamp a few seconds ahead of the client clock rendered as future-tense. Clamped `|diff| < 30_000` to "now" in both directions. |
| Silent bounce to `/login` on refresh-failure with no warning | [lib/auth.tsx](apps/frontend/lib/auth.tsx) | `AUTH_LOGOUT_EVENT` handler now enqueues a warning snackbar ("Your session expired — please sign in again" for `refresh-failed`, "Signed out — please sign in again" for `unauthorized`). |
| Support email surfaces `support@example.com` placeholder | [.do/app.yaml](.do/app.yaml) | Added `NEXT_PUBLIC_SUPPORT_EMAIL` as SECRET on the frontend service. Set the actual mailbox in the DO dashboard. |
| React #418 hydration + "first click doesn't register" | [DashboardClient.tsx](apps/frontend/app/(app)/DashboardClient.tsx) | Root cause: `useMemo` computed `today` with `new Date()` + user-preference timezone, so SSR produced the server's TZ formatting and client hydration re-computed in the user's TZ — mismatch on midnight boundaries or non-UTC user prefs. Deferred to a post-mount `useEffect` so the SSR HTML never carries a locale-dependent date fragment. |

### CONFIRMED but INTENTIONAL / OPERATOR

- **H1 Terms of Service DRAFT** — the counsel-review banner is deliberate. Kept until legal counsel signs off.
- **H4 `support@example.com` fallback** — code fix is the yaml above; operator must set the actual value in the DO dashboard.
- **D3 10,557 real applicant rows visible** — V2 sync data by design. Access control review needed (only ADMIN + tenant users can reach the URL); if the tenant is meant to be a QA tenant, use a fresh non-production V2 fork.

### FALSE (misread or already fixed)

- **F1 Sidebar missing Breach/Sub-processors** — [AppShell.tsx](apps/frontend/components/AppShell.tsx) `COMPLIANCE_NAV` already contains all 5 items behind a collapsible group. Not a bug.
- **G1 No MFA anywhere** — MFA is fully implemented: enrol / verify / disable + step-up gates on every money-mover + peer-account mutation. See §4.1 of [SPVT-FEATURES-AND-USER-FLOWS.md](docs/SPVT-FEATURES-AND-USER-FLOWS.md).
- **H2 Privacy sub-processors link broken** — fixed earlier in commit `54da9c8`.
- **B2 Notifications panel invisible title/close** — [NotificationsBell.tsx:277-289](apps/frontend/components/NotificationsBell.tsx) `<Toolbar>` renders visible `<Typography>Your reminders</Typography>` and a Close `<IconButton>`. Not a bug.

## Brutal-audit rounds 3–4 — deep flow audit (lead pipeline, documents, money paths)

Four parallel audits traced the CRM-lead→student pipeline, the documents
pipeline, every money-touching path, and the frontend flows end to end. The
findings below were verified against code and fixed across two commits:

- **`44e8040`** (round 3): DOCS-C1, BILL-C1, LEAD-H3, LEAD-H4, LEAD-M2,
  LEAD-M3, COMM-H2.
- **round 4** (this commit): LEAD-C1, LEAD-H1, LEAD-H2, LEAD-H5, LEAD-H6,
  LEAD-H7, LEAD-M1, DOCS-H1…H5, BILL-H1, BILL-H3, BILL-H4, BILL-H6, BILL-M2,
  BILL-M8, plus the regression suite and the fixture completion described at
  the end of this section.

Regression coverage lives in `tests/qa-2026-08-guards.spec.ts` (new) plus
additions to `tests/crm-convert-dedup.spec.ts` and
`tests/billing-plan-service.spec.ts`.

### CRITICAL — fixed

| ID | Defect | Fix |
|---|---|---|
| DOCS-C1 | **Every image upload was un-downloadable.** `sha256` was computed on the raw client buffer, but `stripExifIfImage` re-encodes JPEG/PNG/WEBP/HEIC via sharp before storage. The download-side integrity check re-hashed the *stored* bytes and threw `Stored file failed integrity check`. sharp is a hard dependency, so this fired on every image in production. | Hash `safeBuffer` (post-strip) so the recorded digest matches what is stored. |
| BILL-C1 | **Cross-currency totals were fabricated.** `getOutstanding` summed `balance_minor` across every open installment and labelled the total with `rows[0].currency`. A student with USD + GBP enrollments was reported as owing the arithmetic sum, denominated in whichever row sorted first — and that number drove dunning decisions. | Returns `{ by_currency: [...] }`, grouped per ISO currency. FE `Outstanding` type + `PlanSummaryCard` updated to match. |
| LEAD-C1 | **Orphaned Student rows on convert.** `createStudent` runs outside the linking transaction (it holds an advisory lock for SPV-code allocation). If that tx then failed, the student was already durable, unlinked and unreachable — and the dedup guard matched the orphan on retry, forcing `acknowledge_duplicate`, which minted another orphan per attempt. | Compensating soft-delete of the just-created student in a `catch`, with a loud `error` log naming the student code if cleanup itself fails. |

### HIGH — fixed

| ID | Defect | Fix |
|---|---|---|
| LEAD-H2 | Any COUNSELLOR could PATCH any lead in the tenant — including reassigning `assigned_to_id` to themselves — then add/edit/pay/waive/delete its fees. Docs promised per-record ownership; leads had no gate. | New `requireLeadOwnership()` middleware (ADMIN bypasses; unassigned leads stay open for the shared intake queue) on `PATCH /leads/:id` and all five fee routes. |
| LEAD-H3 | Soft-deleting a mis-converted student permanently bricked the lead: the guard fired on any non-null `student_id` regardless of `deleted_at`, and no API could reset the link. | Guard joins `student.deleted_at` and blocks only while the linked student is live. |
| LEAD-H4 | `PATCH /leads/:id/fees/:feeId` accepted a bare currency change. `1234500` USD-cents ($12,345.00) re-labelled JPY became ¥1,234,500 — a 100× error with no validation. | `superRefine` on `UpdateCrmLeadFeeRequest`: changing `currency` requires restating `amount_minor`. |
| LEAD-H5 | Partial payments vanished on convert. `CrmLeadFee.paid_amount_minor` had no counterpart on `FinanceItem`, so a fee PAID for 2,500 of 10,000 migrated as fully settled. | Added `FinanceItem.paid_amount_minor` (migration `20991231235999`), carried through the convert and exposed on the finance API. |
| LEAD-H6 | `@@unique([tenant_id, phone_number])` on `crm_leads` silently dropped family members sharing a mobile: the second sibling's ingest hit P2002 and every child row was skipped, on every sync, forever. | Dropped the unique constraint (migration `20991231236000`); identity remains `(tenant_id, v2_lead_id)`, phone keeps a plain index. |
| LEAD-H7 | Renaming a course in V2 produced duplicate seeded fees, because the idempotency key was `(lead_id, session_label)` and the label embeds the course name. | Added `CrmLeadFee.v2_course_id` + partial unique index on `(lead_id, v2_course_id)` with backfill (migration `20991231236001`); ingest seeds it. |
| LEAD-H1 | `requireIdempotencyKey` was mounted on pay/waive/update/delete but the handlers ignored the key, so retries re-executed instead of replaying — duplicate audit rows and spurious 409s. | Routed those handlers through `runIdempotent` with distinct scopes. |
| DOCS-H1 | Route allowed `ADMIN + COUNSELLOR` with an ownership gate; the service then threw `Admin role required`, so an assigned counsellor who passed both middlewares still got 403. | Route + ownership is now the authority; `force_override` (bypasses the terminal-state FSM) stays ADMIN-only. |
| DOCS-H2 | Minting a signed download URL wrote no audit row — only actual byte-serving did. Signed URLs could be enumerated with no trace. | `document.download_url_minted` audit event carrying a hash of the nonce (never the nonce itself). |
| DOCS-H3 | Verification had no optimistic lock. The `version` column existed but nothing bumped or checked it, so concurrent VERIFIED/REJECTED decisions silently last-writer-wins on a compliance-material field. | `version` folded into the WHERE and incremented; loser gets 409. |
| DOCS-H4 | Compensating storage delete swallowed its error, leaving untracked objects that retention can never sweep (PII + cost). | Logs at `error` with tenant/key/doc id for manual reconciliation. |
| DOCS-H5 | OOXML sniff trusted the client's `Content-Type`: any ZIP could be stored and served as `.docx`/`.xlsx`. | Verifies the container from raw bytes — requires `[Content_Types].xml` plus the matching `word/`/`xl/` part namespace, and rejects ambiguous archives. Scans entry names in place, so it cannot be turned into a decompression bomb. |
| BILL-H1 | `waive` never consulted the FSM, so an already-PAID commission could be waived. `summary()` groups by status, so recognised revenue disappeared from the paid pivot while the payment columns stayed populated. | PAID rejected explicitly (clawback is a dispute); write guarded with `status notIn ['PAID','WAIVED']`. |
| BILL-H3 | `FinanceItem.update` accepted an If-Match `expected` from the controller but discarded it, and the model had no `version` column — the optimistic-concurrency contract was theatre. | Added `FinanceItem.version` (migration `20991231235999`); folded into the WHERE and incremented, 412 on mismatch. |
| BILL-H4 | `FinanceItem` status was copied straight from the payload — `PAID → PENDING`, `REFUNDED → PAID` all allowed. Un-settling an item left its reminders permanently DISMISSED, so it fell off the collections queue silently. | Explicit transition table; terminal states are terminal, `PAID → REFUNDED` is the only settled-state exit. |
| BILL-H6 | `applyAdjustment` locked the installment with no status filter and LATE_FEE had no cap, so a fee could be applied to a WAIVED/CANCELLED/REFUNDED row: balances mutated while the status stayed terminal. `getOutstanding` never scans those statuses, so the phantom balance drifted the plan view and invoice PDF away from the ledger unnoticed. | Terminal statuses rejected up front. |

### MEDIUM — fixed

| ID | Defect | Fix |
|---|---|---|
| LEAD-M1 | A converted lead stayed `ACTIVE` with open follow-ups — still in the work queue, still counted by `financeSummary`, still firing reminders. | Convert sets `spv_status = COMPLETED` and closes open follow-ups inside the same tx. |
| LEAD-M2 | `pay`/`waive` only blocked `PAID`, and generic PATCH could set `status` — bypassing `paid_at`, `paid_amount_minor`, reminder dismissal and the correct audit action. Re-waiving bumped `version` and wrote a bogus audit row on a frozen record. | `status` removed from `UpdateCrmLeadFeeRequest`; PAID **and** WAIVED rejected by pay/waive/edit; atomic guards use `notIn`. |
| LEAD-M3 | `deleteFee` had no atomic guard — concurrent deletes both wrote, both bumped version, both fanned out audit + reminder dismissal. | `updateMany` with `deleted_at: null`; the loser returns early and skips the fanout. |
| BILL-M2 | A claim disputed from PENDING/CLAIMED resolved into `INVOICED` with `invoice_no = NULL`, breaking the "INVOICED ⇒ has invoice_no" invariant every reconciliation surface assumes. | `resolveDispute` mints an invoice number when one is missing, and guards the write on `status = DISPUTED`. |
| BILL-M8 | Fully discounting a SCHEDULED installment 422'd, because `SCHEDULED → PAID` is not a declared FSM edge. | Routed through the legal two-hop `SCHEDULED → INVOICED → PAID`, asserting both edges. |
| COMM-H2 | `commissions.invoice_no` had no unique index — the retry loop in `nextInvoiceNumber` guarded a race with no backstop. | Partial unique index on `(tenant_id, invoice_no)` (migration `20991231235998`). |

### Test-fixture blast radius (worth recording)

Adding the session-wide revoke check to `authenticate` made every authenticated
request depend on `prismaAdmin.user.findUnique`. 20+ fixtures mock
`../src/config/db.js` and did not export `prismaAdmin`, so the middleware's
(correct) fail-closed branch turned them into 503s. The fix was to complete the
fixtures — each now exports an explicit admin stub returning
`{ sessions_valid_from: null }`, i.e. "no revocation on record", which is the
state those tests always implicitly assumed. The middleware was **not**
weakened: reading the stamp through the BYPASS-RLS client is required because
`authenticate` runs before `tenantContext` sets the tenant GUC, and under the
`spv_app` role a plain read would be filtered to null and the check would
silently no-op.

## Cost & scale optimisation pass (SVT-PERF-2026-08)

Goal: materially cut per-request cost without touching UX, security posture, or
feature behaviour. Every change below is a pure efficiency win — no capability
was removed and no guard was relaxed.

### 1. Per-query transaction → batched transaction (the dominant cost)

`middlewares/tenantContext.ts` wraps every Prisma operation in a transaction
that first `set_config`s the `app.tenant_id` GUC, because the RLS policies read
it. The previous implementation used the **interactive** form:

```
prisma.$transaction(async (tx) => {
  await tx.$executeRaw`SELECT set_config(...)`;   // round-trip
  return tx.<model>.<op>(args);                   // round-trip
});
```

An interactive transaction is a conversation — the driver issues `BEGIN`,
waits, `set_config`, waits, the query, waits, `COMMIT`, waits. That is **four
network round-trips for one logical query**, with the pool connection held for
all four. An endpoint issuing 8 queries paid 32 round-trips and 8 separate
connection checkouts.

Switched to Prisma's **array** form, which pipelines the batch in a single
exchange. Prisma promises are lazy — building `prisma.student.findMany(args)`
executes nothing until awaited or handed to `$transaction` — so the operation
is constructed, placed after the `set_config` statement, and shipped together.
Same transaction, same connection, same local-scoped GUC; roughly a quarter of
the round-trips and a quarter of the pool churn. This is the documented Prisma
RLS pattern, not a relaxation.

Raw operations (`$queryRaw`/`$executeRaw`) and any unknown model/operation
pairing still take the interactive path — correctness over cleverness.

### 2. Memoised scoped client

`makeScopedClient` ran on **every request**, and `$extends` rebuilds a proxy
over the entire client surface each time — pure allocation churn on the hottest
path. The extension closes over nothing but `tenantId`, so clients are now
cached per tenant, with a bounded map so a pathological tenant count cannot
leak memory.

### 3. Auth hot path — negative caching of the JTI denylist

Every authenticated request ran `SELECT … FROM access_token_denylist WHERE jti
= ?`, whose answer is "no row" for essentially every request. Negative results
are now cached for 10s.

The security cost is bounded and explicit: a token revoked via `/auth/logout`
could survive at most that window — except logout now calls
`invalidateDenylistCache(jti)` immediately after the denylist write, so
revocation takes effect on the very next request. Positive results are never
cached, so we can never cache our way into accepting a revoked token. The
`sessions_valid_from` lookup keeps its existing 30s cache with explicit
invalidation on all six revocation flows.

### 4. Response compression

The API is almost entirely JSON list payloads, which gzip 70–85%. Added
`compression` with a 1 KiB threshold — a direct, linear egress-bill reduction
and a real time-to-first-byte improvement on the mobile connections counsellors
use in the field. Document **streams** are excluded: PDF/JPEG/PNG/OOXML are
already compressed, so re-compressing burns CPU for nothing and would buffer
bytes we want to pass straight through.

### 5. Covering indexes for list pagination (migration `20991231236002`)

Every list endpoint paginates with the same keyset shape:

```
WHERE tenant_id = $1 AND deleted_at IS NULL
ORDER BY created_at DESC, id DESC
LIMIT $2
```

`audit_logs` and `students` already had matching partial indexes; three hot
tables did not, so Postgres read every live row for the tenant and sorted it on
**every** page request — including page 1, where most sessions start. On the
CRM lead table that is a full sort of 10,000+ rows to return 25.

Added (all partial on `deleted_at IS NULL`, so they stay smaller than the table
and stay cache-hot):

- `crm_leads_tenant_created_id_live_idx` — the busiest screen in the product.
- `documents_tenant_student_id_live_idx` — every student detail page.
- `crm_lead_fees_tenant_lead_due_live_idx` — the open-fees nested read on the
  leads list, which previously sorted once per row on the page.

`students` deliberately got **nothing**: it already has an identical index from
`20991231235960_perf_indexes`. A duplicate would be pure overhead — extra
writes on every mutation, more buffer cache consumed, zero read benefit. This
was caught by checking the existing migrations before writing the new one.

### Already optimal — checked, no change needed

- **Frontend bundle**: `next.config.mjs` already sets
  `optimizePackageImports` for `@mui/material` + `@mui/icons-material` (the
  classic MUI barrel-import cost), disables browser source maps, and uses
  standalone output.
- **React Query defaults**: `staleTime` 30s, `refetchOnWindowFocus` off,
  bounded retry with exponential backoff — already tuned against refetch
  storms.
- **Index count**: 198 `@@index` declarations plus the SQL-only partial and
  trigram indexes; coverage was good, the gaps were specifically the
  ORDER BY-matching composites above.

### CANNOT REPRODUCE / DEFERRED

- **H5 `/status` page renders app error** — [/status page](apps/frontend/app/(public)/status/page.tsx) has a try/catch fallback around the backend fetch and the `status` i18n namespace exists at `messages/en.json:673`. The reported crash is env-specific (possibly the QA session hit it before the backend `/api/v1/public/status` route was deployed). Retest after this deploy.
- **J8 intermittent 401 on refresh** — one-off; the single-flight guard in [api.ts](apps/frontend/lib/api.ts) already covers concurrent-refresh races. Needs a repro to diagnose further (could be a DO cold-start hitting the refresh cookie's TTL exactly).
- **C4 Audit log 0 entries despite activity** — backend writes audit correctly at [auth.service.ts:357](apps/backend/src/modules/auth/auth.service.ts) (`action: 'auth.login.success'`). Suspect a fresh-deploy tenant with no writes yet OR the QA session filtered aggressively. Retest after this deploy.
- **A3 Sign-in button color inconsistency** — needs a design pass; not code-verifiable.
- **J10 "Restoring your session…" theme mismatch** — [ProtectedLayout.tsx](apps/frontend/components/ProtectedLayout.tsx) uses `bgcolor: 'background.default'` which is theme-aware post-hydration but not pre-hydration. Real fix requires a blocking `<head>` script that sets `<html data-theme="…">` before React runs. Deferred as design polish.
- **J11 mobile responsive pass** — automation environment couldn't verify. Needs manual device pass or Playwright viewport override.
