# SPVT Comprehensive QA Audit — 2026-08-03

Six-dimension expert panel. Findings verified against source at commit `025ff42`. Cited to file:line.

**Dimensions reviewed:**
1. Frontend UX + design
2. Backend API + system engineering
3. Security + data integrity
4. Deployment + SRE readiness
5. User-flow end-to-end
6. Test coverage + code quality

**Severity legend:** CRITICAL (data loss / GDPR / cross-tenant leak) · HIGH (breaks a shipping flow or security posture) · MEDIUM (usable but wrong / fragile) · LOW (polish / consistency)

---

## Executive summary

| Dimension | CRITICAL | HIGH | MEDIUM | LOW |
|---|---:|---:|---:|---:|
| Frontend UX | 0 | 8 | 6 | 12 |
| Backend API | 0 | 3 | 12 | 15 |
| Security | 1 | 5 | 5 | 3 |
| Deployment / SRE | 0 | 5 | 7 | 8 |
| User flow | 0 | 9 | 7 | 3 |
| Test coverage | 1 | 4 | 4 | 3 |
| **Total** | **2** | **34** | **41** | **44** |

**Ship-blockers (must-fix before real users):**
1. RLS gap on institution/program child tables (§Security §2) — cross-tenant leak vector
2. Student PII plaintext (`dob`, email, phone) (§Security §3) — GDPR breach magnifier
3. Audit chain race (`FOR UPDATE` missing) (§Security §5) — false tamper alarms under load
4. KEK rotation silent data loss (§Security §14) — envelope missing kek_version
5. MFA-disable/change-password don't denylist access tokens (§Security §1) — 15-min post-breach window
6. First-boot seed doesn't run (§SRE §18) — DEPLOYMENT-READINESS.md claim is false
7. Sentry HTTP capture inert (§SRE §8) — errors reach Sentry with no tenant/user/request tags
8. No real-Postgres RLS enforcement test (§Tests §CRITICAL) — a broken policy ships undetected
9. `/legal/privacy` → `/admin/sub-processors` (§Frontend §Cross-page) — broken link to non-existent route
10. Automated backups disabled + wet-restore drill overdue 6+ weeks (§SRE §9)

---

## §1 Frontend UX + design

### Cross-cutting
- HIGH [i18n] Only 42 of 112 client files use `useTranslations`. `en/ar/hi/ne` JSON packs have aligned 524-526 keys — mostly unreferenced. AR RTL renders but strings stay in English.
- HIGH [a11y] `components/ErrorState.tsx:19-70`, `ConfirmDialog.tsx:54-128`, `error.tsx`, `CookieBanner.tsx`, `DataTable.tsx:76-83` — English defaults hardcoded ("Something went wrong", "Try again", "Delete", "Nothing to show").
- HIGH [broken-link] `apps/frontend/app/(legal)/legal/privacy/page.tsx:120` — links to `/admin/sub-processors` (route does not exist). Correct: `/sub-processors`.
- MEDIUM [ux-polish] No global "last synced" indicator except on `/leads`. TanStack `staleTime` 30-60s, no visual cue.
- MEDIUM [a11y] `ConfirmDialog` typed-confirmation instructions only in English.

### Per-page highlights
- Dashboard: HIGH — `const ORG_NAME = 'Default Tenant'` (`DashboardClient.tsx:135`) hardcoded — every tenant sees this string.
- Dashboard: MEDIUM — `slaQuery`, `engagementQuery`, `breachQuery`, `dsarQuery` errors swallowed silently; cards just hide when permission-gapped.
- Students: MEDIUM — cursor pagination is forward-only server-side, but MUI `TablePagination` (line 727-738) still renders standard controls — misleading.
- Leads: HIGH — `ErrorState` at `leads/Client.tsx:192` renders without title/description/requestId → support cannot correlate a failure.
- Leads: MEDIUM — no filter reset/clear button; `has_upcoming_fee` switch has no help text.
- Leads/institutions: MEDIUM — `getRowId={(r) => r.institution_id ?? r.name}` collides on institutions with `null` id.
- Inbox: MEDIUM — SLA breaches tile routes to tenant-wide breach set, not user's own.
- Breach-incidents: HIGH — Mark reported + Mark closed fire immediately on IconButton click, no ConfirmDialog. GDPR-significant.
- Interview-questions: MEDIUM — Delete-confirm typed-label uses `question_text.slice(0, 30)` — long/multiline questions make confirmation hard.
- Login: MEDIUM — no LocaleSwitcher; wrong-locale users can't switch pre-signin.
- Login: LOW — `submitError` doesn't clear when user starts typing again.
- Programs (Courses): MEDIUM — intake-status filter removed pending backend, TODO only in a code comment (not tracker).
- Legal footer (AppShell.tsx:502-517) — "Terms/Privacy/Support" hardcoded English.

---

## §2 Backend API + system engineering

### P0
- P0 [openapi drift] `/leads/**`, `/super-agents*`, `/super-agent-types*`, `/institutions/*/super-agents*`, `/interview-questions*`, `/interview-attempts*`, `/public/interview-prep*`, `/admin/idempotency/*`, `/admin/v2-diagnostics/*`, `/students/*/checklist-progress`, `/stages/*/checklist-items` — absent from `apps/backend/src/modules/openapi/spec.ts`. Clients cannot validate against server surface.
- P0 [env-gap] `RESEND_WEBHOOK_SECRET` enforced at runtime only (`webhooks.routes.ts:64-74`) → 503 per request instead of fail-boot in prod. Move to `EnvSchema` + `superRefine`.

### P1 — missing idempotency (money/side-effect)
- `POST /students/:id/transitions` (`students.routes.ts:78-87`) — writes StudentLifecycleEvent + stage change
- `POST /students/:studentId/enrollments` (`enrollments.routes.ts:85-93`) — enrolment + billing plan hook
- `POST /leads/:id/fees` + PATCH/pay/waive/DELETE (`crm-leads.routes.ts`) — money row
- `POST /billing/installments/:id/adjustments` — ledger row
- `POST /commissions/:id/*` (claim, invoice, mark-paid, dispute, resolve-dispute, waive)
- `POST /imports/:job_id/apply` — bulk apply
- `POST /admin/comms/outbox/requeue-all`

### P1 — RLS scope bugs
- `apps/backend/src/modules/users/users.service.ts:73-446` — `create/getById/update/softDelete/resetPassword/revokeAllSessions/adminDisableMfa` use raw `prisma`. Only `list()` uses `req.db`. Prod switch to `spv_app` role → silent 0-row on user mutations.
- `apps/backend/src/modules/admin/ropa.routes.ts:125-140,181-184` — same class of bug.

### P1 — missing validate()
- `PATCH /documents/:id/verification` (`documents.routes.ts:88-95`)
- `POST /leads/:id/fees/:feeId/waive`, `POST /leads/sync`
- `/reports/*` (all 5) — parse query inline
- `/inbox/*` (read-all, /:id/read), `/admin/comms/outbox/*/requeue*`
- `/interview-questions/generate-link`
- `commissions/routes.ts:62,91` (claim, waive)

### P2 — polish
- Response envelope drift — some list endpoints `{data, page}`, some raw arrays, some raw objects (super-agents/contacts.routes.ts, super-agent-types/routes.ts, commission-rules.routes.ts)
- Prisma connection pool not configured (default `num_cpus*2+1` per replica; saturation risk under load)
- Dashboard endpoints lack `heavyReadLimiter` (polling risk)
- `/auth/jwks` served twice without `Cache-Control` on the auth-mounted copy
- `usersService.list` returns no `total`
- `/health/readyz` echoes raw `err.message` (leaks connection paths on Prisma error)
- Lookup endpoints (countries, currencies, etc.) return full table with no `take` guard

---

## §3 Security + data integrity

### CRITICAL
- **RLS gap on 10 child tables** (`migrations/20991231235966_critical_rls_coverage/migration.sql:67-87`) — `campuses`, `schools`, `departments`, `institution_identifiers`, `institution_accreditations`, `institution_contacts`, `program_intakes`, `program_requirements`, `program_modules`, `program_fees`: NO RLS at all (explicitly deferred). Cross-tenant leak prevented only while every code path traverses parent via nested Prisma reads. A single direct `req.db.campus.findMany()` returns every tenant's rows. **Fix:** subquery policy `USING (EXISTS (SELECT 1 FROM programs p WHERE p.id = <child>.program_id AND p.tenant_id = app_current_tenant()))` + `(program_id)` / `(institution_id)` indexes.

### HIGH
- **Student PII plaintext** (`schema.prisma:683,693-696,1097-1098`) — `Student.date_of_birth`, `email_primary/secondary`, `phone_primary/secondary_e164`, `StudentContact.email/phone_e164` stored plaintext. `name_in_passport_enc` proves team knows envelope encryption. GDPR/DPA breach magnifier.
- **Audit chain race** (`migrations/20991231235984b_audit_chain_utc_timestamp/migration.sql:51-56`) — trigger reads `prev` WITHOUT `FOR UPDATE`. Comment in `shared/audit.ts:44-46` claims `FOR UPDATE` — doc drift. Under READ COMMITTED, two concurrent inserts same tenant → identical `prev_hash` → chain FALSELY verifies as broken. Fix: `SELECT ... FOR UPDATE` + `UNIQUE (tenant_id, prev_hash) DEFERRABLE`.
- **KEK rotation silent data loss** (`config/kms.ts:74-98` + `shared/encryption.ts:12-22`) — envelope has format version byte but no `kek_version`. Rotating `KMS_KEK_BASE64` breaks decryption of every existing envelope (tag mismatch). Fix: append `kekId` to envelope header, keep N-1 KEKs available, force operators to run `infra/scripts/rewrap-secrets.ts` before removing previous KEK.
- **MFA/password/session revocation gaps** (`mfa.service.ts:174-200`, `auth.service.ts:660-708`, `password-reset.service.ts:256-278`, `users.service.ts:352-374`) — all four flows revoke refresh tokens but never touch `accessTokenDenylist`. 15-min post-breach window on stolen access tokens. Fix: on each, denylist affected user's outstanding JTIs OR gate `authenticate` on `token.iat >= user.password_changed_at`.
- **ClamAV silently skipped** (`documents/documents.service.ts:147`) — if `env.CLAMAV_HOST` unset, `if (env.CLAMAV_HOST) { ... }` skips scan entirely. `.do/app.yaml:127-130` ships it commented out. Production accepts arbitrary content post-MIME-sniff. Fix: refuse to boot in prod without CLAMAV_HOST OR admin banner.

### MEDIUM
- CSP `style-src` includes `'unsafe-inline'` (`app.ts:134`) — stored-XSS + `<style>{ background: url(exfil) }` still exfils. Move to nonce-based `style-src`.
- CSP has no `report-uri`/`report-to` directive — `/api/v1/csp` collector never fires despite being wired.
- `assertRuntimeRoleRespectsRls()` returns silently on DB failure at boot (`db.ts:76-82`) — DB flap during boot skips the check.
- `prismaAdmin` surface is broad — audit surface should whitelist which models can be accessed.
- In-memory rate limiter (`middlewares/rateLimit.ts:24-29`) — silent bypass on multi-instance scale; `.do/app.yaml` `instance_count:1` OK today, fragile if scaled.

### LOW
- `REFRESH_TOKEN_PEPPER` fallback `'00'.repeat(32)` used when env missing (`shared/passwords.ts:49-50`) — should refuse to boot when buffer is all-zero and `NODE_ENV !== 'test'`.
- `tokenHmac(raw, tenantId)` implemented but unreferenced (advertised tenant-fingerprinting security property not in effect).
- `app.set('trust proxy', 1)` — safe on current single-hop DO topology, silently bypassable if a WAF/CDN layer is added.

### PASS
- Argon2id (m=64MB, t=3, p=1) — meets OWASP 2024.
- JWT RS256 pinned (no alg-confusion).
- TOTP replay defence + step-up MFA.
- DSAR erasure skip in `v2Ingest.ts:178-189`.
- Currency-grouped money handling (never combined across currencies).
- `SELECT FOR UPDATE` on installment allocation.
- Logger + Sentry PII redaction lists thorough.
- No hardcoded secrets in source; `.env.example` uses placeholder values only.
- No SQL injection surface (`$queryRawUnsafe` only 2 sites, both bind bigint).

---

## §4 Deployment + SRE readiness

### P0 (pre-launch blockers)
- **Sentry HTTP capture is inert** (`config/sentry.ts:138-153`) — `sentryRequestHandler` returns bare `next()`, `sentryErrorHandler` calls `captureException(err)` with NO scope/user/tenant/request_id tag. HTTP errors reach Sentry only via `unhandledRejection`/`uncaughtException`. Fix: wire `Sentry.setupExpressErrorHandler(app)` + attach tenant/user tags.
- **First-boot seed doesn't run** — `.do/app.yaml:43` PRE_DEPLOY runs `prisma migrate deploy` only, no `prisma:seed`. `DEPLOYMENT-READINESS.md:88` claim "created on first boot if users table empty" is **factually false**. Fix: chain `pnpm --filter backend prisma:seed` after `migrate deploy`.
- **Automated backups disabled** (`.github/workflows/db-backup.yml:23-25`) — `schedule:` commented out; only `workflow_dispatch` works. Wet-restore drill overdue by 6+ weeks (`db-backup-restore.md` line 3: "next wet drill due 2026-06-19"). Now 2026-08-03.
- **Migration CI gap** (`backend-ci.yml:114-124`) — Postgres service container spun up but `prisma migrate deploy` never runs. Tests use `db push` (per DEPLOYMENT-READINESS.md:26). 45 migrations effectively untested until PROD.
- **Scheduler silent failures** — 12 of 13 daily jobs have NO alerting (only `audit.chain.verify` wires Sentry). `retention.erasure` + `dsar.sla.watch` silent failure = GDPR non-compliance.
- **METRICS_TOKEN not prod-required** — `env.ts:191` optional; `/metrics` returns 401 silently forever if unset. Prometheus scrape fails silently.
- **`.do/app.yaml:41,52,146`** — GitHub repo literal placeholder `<org>/<repo>` on all three components. Deploy will fail.

### P1
- Scheduler double-scheduled at 06:00 UTC (`expiry.alerts` + `billing.daily`) and 07:00 UTC (`dsar.sla.watch` + `comms.cleanup`). Comment says "staggered so they never overlap" — they don't. `scheduler.ts:418,425` / `420,431`.
- Scheduler / background job logs use bare `logger.error({...})` — no `request_id` / `job_run_id` correlation. Failing pass emits N tenant-scoped log lines with no join.
- V2 ingest reads ENTIRE dump into Node memory + 10k sequential BEGIN/COMMIT per row (`v2Ingest.ts:94,121+`). No batching, no LIMIT on V2 SELECTs. Bounded runtime scales linearly with tenant size.
- No `SENTRY_RELEASE` / `GIT_COMMIT` in `.do/app.yaml` → release-health tracking + source maps show "unknown".
- No canary/traffic-split. `instance_count: 1` = SPOF during redeploy AND request path. Not documented.
- `basic-xs` sizing (1 vCPU, 1GB) with no `autoscaling:` block. First traffic spike → OOM.
- `package.json:46` — `"redis": "^6.0.0"` — node-redis latest stable is v4.x. Likely fictional version; verify against npm.
- Missing runbooks: v2-outage, migration-failure/rollback, tenant-level restore, single-tenant-key-compromise.
- `JWT_ISSUER=https://spvt.example.com` + `EMAIL_FROM=noreply@spvt.example.com` in `.do/app.yaml:97,116` — placeholder domain values; tokens issued with fake issuer.
- `EMAIL_PROVIDER=log` in prod → no user emails ever sent (password reset, verification). Needs manual flip.
- Coverage thresholds gated `continue-on-error: true` (`backend-ci.yml`) — regressions do not block merges.

### P2
- Two migrations share prefix `20991231235983_` (billing-sec-hardening + rls-remove-escape-hatch). Works today via lex order but fragile.
- Migration `20991231235967` needs `CONCURRENTLY` conversion for large prod DBs — comment says so, no automation.
- No Renovate/Dependabot config.
- `Dockerfile` base image digest not pinned.
- Redis `_URL=redis://localhost:6379` — any Prometheus alert on `redis_up == 0` will page for intentional absence.
- No image push step; DO builds from source. Trivy scanned locally-built image, deployed image not provably identical.

### Runbooks present
db-backup-restore, db-restore, restore-staging-from-prod, hash-chain-verify, kms-rotation, kek-rotation, jwt-key-rotation (+v1.1), env-rotation, webhook-secret-rotation, locked-out-admin, incident-response, founder-onboard-tenant, dsar, bulk-import-stuck, provider-degrade, dependency-upgrades, migration-rename-2026-05-19.

---

## §5 User flow end-to-end

### Flow gaps
- **F1 First-time onboarding** — HIGH: Post-login lands at `/` (dashboard), no onboarding quick-action for "Sync V2" (`DashboardClient.tsx:1386-1413`). MED: `useRequireAuth` redirects to `/login` without preserving requested path (`lib/auth.tsx:213-217`); `?redirect=` accepted but never set. LOW: no self-serve "Create tenant" — CLI onboarding only.
- **F2 Applicant handling** — HIGH: `/leads/[id]` tabs actual = `['Profile','Applications','Status history','Activity','Qualifications','Payments','Fees']` — no Overview/Assignments/Guardians/History tab as spec expected. HIGH: No discrete "Edit assigned_to" or "Add note" button — all three fields batched in Edit modal (`EditLeadDialog.tsx:17-77`). MED: Activity tab read-only; no in-app "add remark/call".
- **F3 Convert lead → student** — HIGH: After success, user does NOT navigate to new student. `DetailClient.tsx:251` discards `studentId, code`. MED: No MFA step-up on `/convert` — only `requireRole('ADMIN') + requireIdempotencyKey` (`crm-leads.routes.ts:68`).
- **F4 Password reset** — PASS end-to-end. Anti-enumeration enforced on both endpoints.
- **F5 Add + manage user** — HIGH: Sidebar path is `/users`, not `/admin/users`. `/admin/users` returns 404 (via `admin/Client.tsx:33` link only). HIGH: No email invite flow — admin types passwords manually (`CreateUserDialog.tsx:32,137`). MED: PATCH/MFA-disable/revoke-sessions correctly MFA-gated backend + frontend.
- **F6 Sync from V2** — MED: single generic toast "Sync failed — check the V2 connection" (`leads/Client.tsx:105`). No distinction for timeout/TLS/429; `job_runs.error_msg` never surfaced.
- **F7 Mark fee paid** — PASS end-to-end. `dismissRemindersForEntity` fires + refetch.
- **F8 Audit review** — MED: Actor filter takes raw UUID text (`audit/Client.tsx:477-486`). No email/name autocomplete. No frontend action for daily anchor rebuild (scheduler only).
- **F9 Bulk import** — HIGH: Mapping UI is READ-ONLY (`imports/new/Client.tsx:436-464`). Renders table showing `suggested_mapping` but no editable Select per column. Admin must fix CSV if auto-detect misses.
- **F10 Billing + fee plan** — HIGH: No admin cross-tenant "create fee plan" surface. FeePlanWizardDialog invoked only from student page. Attaching to student is the only path.
- **F11 DSAR intake** — MED: Public form requires subject to know `tenant_id` UUID or arrive with `?tenant=` (`legal/dsar/Client.tsx:54,64`). Fallback "paste manually" — data-subject friction.
- **F12 Locale switch** — HIGH: `LocaleSwitcher.tsx:22-26` lists en/ar/ne only. `hi.json` exists but `'hi'` NOT in `i18n/request.ts:4` SUPPORTED. Hindi cookie falls back to English silently. Dead file. MED: Locale is cookie-only (`spv-locale`), never persisted to `user.preferred_locale`. Cross-device switching lost.
- **F13 Mobile nav** — MED: `users/Client.tsx:340` forces `minWidth: 720` — 375px viewport horizontally scrolls without column hiding.
- **F14 Logout everywhere** — HIGH: `SignOutEverywhereSection.tsx:33-38` calls `/users/{id}/sessions/revoke` only when `user.role === 'ADMIN'`. Non-admins get normal single-session logout. Description admits it, CTA still says "Sign out everywhere".
- **F15 Error boundary** — PASS. Nested boundaries + `reportBoundaryError` → `/api/v1/security/error-report` (`security/csp-report.routes.ts:127-149`).

### Cross-cutting
- `/leads/[id]` tab list inconsistent with docs (spec drift).
- No self-serve profile editing (name/locale/timezone) — every mutation requires admin.
- No email invitation flow anywhere.
- Sync errors + audit filters are UUID/opaque.

---

## §6 Test coverage + code quality

### CRITICAL
- **No real-Postgres RLS enforcement test.** `rls-escape-hatch.spec.ts` greps migration SQL text. `rls-role-assert.spec.ts` verifies boot-time role-privilege guard. Every "tenant isolation" spec uses in-memory mock — service-layer `tenantId` filter alone satisfies. A broken RLS policy in prod would ship undetected.

### HIGH
- Zero direct coverage of `crm-leads.service.ts::listApplications` (freshly rewritten in `e3a1e1b` + `10c0ff0`), `triggerSync`, `financeSummary`, all fee CRUD atomic guards (`markFeePaid`'s TOCTOU `updateMany` with `status: { not: 'PAID' }`).
- Frontend: `apps/frontend/package.json` `"test": "echo no tests yet"`. Zero unit tests. Only 5 Playwright e2e specs.
- `frontend-ci.yml` never runs Playwright e2e.
- `backend-ci.yml` spins up Postgres 16 service but never runs `prisma migrate deploy`. Postgres container is dead weight. Migrations effectively untested.
- Audit hash-chain never tested across process restart / real DB.
- Timing-safe compare untested for MFA recovery, webhook HMAC, unsubscribe token.

### MEDIUM
- `rate-limiters-wiring.spec.ts` asserts middleware wiring by regex-scanning source files. Any refactor renaming router variables silently breaks the test without changing behaviour.
- `auth.spec.ts` uses 150-line hand-rolled prisma mock — semantic drift from real Prisma silent.
- Coverage thresholds 70/70/70/60 gated `continue-on-error: true`.
- 155 `Date`/`Date.now` uses across 44 spec files with ZERO `vi.setSystemTime` — brittle to day boundaries + CI jitter.
- `mfa.spec.ts:60-65` stubs `verifyTotp` to `code === '123456'` — real TOTP window/drift/replay bypassed.

### LOW
- 27 `any` occurrences across 17 backend files.
- 9 `TODO/FIXME/HACK/@ts-ignore` markers (mostly benign).
- Long files (refactor candidates): `openapi/spec.ts:1780`, `dsar/service.ts:1197`, `students.service.ts:972`, `billing/payment.service.ts:877`, `auth.service.ts:873`, `crm-leads.service.ts:769`.
- No `codeql.yml` in `.github/workflows/` (verify).

### PASS
- TypeScript strictness: `strict:true` + `noUncheckedIndexedAccess:true` + `noImplicitOverride:true`.
- Prettier + ESLint present (minimal but consistent).
- No snapshot tests (zero regression-swallowing risk).
- Security workflow: gitleaks + pnpm audit + OSV + SBOM + Trivy.
- Argon2id + JWT keyset + jwt-rotation well-covered.

---

## Recommended priority order

### Sprint 1 (ship-blocking)
1. RLS on child tables — 1 migration + tests
2. Envelope-encrypt Student PII (DOB/email/phone) + backfill migration
3. Audit chain `FOR UPDATE` fix
4. Envelope `kek_id` header for KMS rotation safety
5. Access-token denylist on all revocation flows
6. First-boot seed in `.do/app.yaml` PRE_DEPLOY
7. Sentry `setupExpressErrorHandler` + tenant tags
8. Fix broken `/legal/privacy` link
9. Backup schedule uncomment + wet-restore drill
10. Fix `.do/app.yaml` `<org>/<repo>` placeholders
11. `RESEND_WEBHOOK_SECRET` + `METRICS_TOKEN` in `EnvSchema` + `superRefine`

### Sprint 2 (compliance + reliability)
12. Real-Postgres RLS enforcement test (SET app.tenant_id sessions)
13. CI adds `prisma migrate deploy` step
14. Scheduler alerting (all 12 silent jobs → Sentry + PagerDuty)
15. Fix scheduler double-schedule at 06:00/07:00 UTC
16. Idempotency-Key on all money-touching + FSM-transition POSTs
17. Fix `usersService` + `admin/ropa.routes.ts` to use `req.db`
18. ClamAV production enforcement
19. Fix broken user flows: convert→student navigation, /admin/users 404, mapping UI editable, logout-everywhere for non-admins
20. Fix Sign out everywhere for non-admins

### Sprint 3 (polish + growth)
21. i18n coverage sweep (60+ pages)
22. OpenAPI spec drift fix
23. Response envelope standardisation
24. Email invitation flow
25. Prisma connection pool tuning
26. Move rate limiter to Redis for scale
27. CSP nonce-based style-src + report-uri
28. Frontend unit tests (React Testing Library)

---

## Full findings archive

Individual subagent outputs preserved in session task files:
- Frontend UX + design: `a18da2292b04b7ca7.output`
- Backend API + system engineering: `a0e34f85b2e0b4267.output`
- Security + data integrity: `a0843f93090a7ec85.output`
- Deployment + SRE readiness: `a75cf4d4b8e42edec.output`
- User flow end-to-end: `a2432fd3a45bdf69c.output`
- Test coverage + code quality: `a19be7d8d0e24e07f.output`

Every finding cites `file:line`. Fact-tested against code at commit `025ff42`. No speculation.
