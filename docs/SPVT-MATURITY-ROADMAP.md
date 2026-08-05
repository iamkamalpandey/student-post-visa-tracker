# SPVT — Maturity Roadmap

**Date:** 2026-08-05 · **Basis:** five parallel read-only audits (security & privacy, accessibility & i18n, performance & scale, reliability & observability, architecture & code quality). Every finding was required to quote real code; the headline ones were then re-verified by hand against `HEAD`.

**Framing.** The brief was *"take the application forward with international standards, no compromise — richer in itself, not feature heavy."* This document therefore proposes almost no new features. It proposes making the things that already exist actually true.

That distinction turned out to be the theme of the whole audit. The recurring defect in this codebase is not missing capability — it is **capability that is wired but not connected**: a control that is documented, has code, has configuration, and does nothing. Those are more dangerous than a known gap, because the organisation stops looking.

---

## 1. The five things that are believed to work and do not

These are ranked first because each one is currently providing false assurance.

### 1.1 Error tracking does not exist
`@sentry/node` appears **zero times** in `apps/backend/package.json` and **zero times** in `pnpm-lock.yaml`. `config/sentry.ts` imports it dynamically, the import always throws, and `sentry` is set to `null`. Every `captureException`, `captureJobException`, `sentryErrorHandler`, and `withTenantScope` call in the codebase is a no-op.

Meanwhile `.do/app.yaml` provisions `SENTRY_DSN` as a secret and the readiness review records observability as *passed*. Builds use `--frozen-lockfile`, so the dependency can never appear at runtime.

### 1.2 Nothing can page a human
There is no `alerts:` block and no `log_destinations:` block in `.do/app.yaml`. `/metrics` is exported and token-guarded, but no Prometheus, Alertmanager, or scrape configuration exists anywhere in the repository. Logs land in DigitalOcean's ring buffer and stop there.

Every deliberately-loud `logger.error` in the system — broken audit hash chain, orphaned storage object, job all-retries-failed — writes to stdout and reaches nobody.

### 1.3 There are no automated backups, and restore has never been run
`.github/workflows/db-backup.yml` has its `schedule:` block **commented out**; only `workflow_dispatch` remains. The single drill log on file is marked `DRY-RUN — needs operator wet-run`, with RTO "not measured".

Not covered by any backup: `KMS_KEK_BASE64` (losing it is permanent, total loss of every envelope-encrypted field), `PII_BLIND_INDEX_KEY`, `LOG_HMAC_KEY_BASE64`, `REFRESH_TOKEN_PEPPER`, the JWT keys, and the S3/Spaces document objects. A database-only restore yields rows pointing at objects that were never backed up.

### 1.4 Uploads are recorded as virus-scanned when no scanner ran
`documents.service.ts:147` runs ClamAV only `if (env.CLAMAV_HOST)`, which is optional and has no production requirement. Line 216 then writes `av_status: 'CLEAN'` and `av_scanned_at: new Date()` **unconditionally**. Both download paths gate on `av_status !== 'CLEAN'`, so the gate always passes.

The row is a false attestation — it records a scan timestamp for a scan that never happened. That is precisely the artefact a SOC 2 auditor samples. `SECURITY.md` lists ClamAV as a control in place.

### 1.5 The audit chain's tamper-evidence was silently reverted
Migration `…994_audit_chain_forensic_fields` added `actor_email_hash`, `ip_hash` and `ua_hash` to the hashed payload and stamped `hash_version := 2`, explaining that without them *"a party with raw DML access could rewrite the acting user's email-hash or the source IP/UA on any row and `audit_logs_verify()` would STILL report the chain intact."*

Migration `…996_audit_chain_for_update` then `CREATE OR REPLACE`d the same function to add `FOR UPDATE`, shipping the **pre-994 payload** and dropping the `hash_version := 2` stamp. It sorts last, so it wins. Because new rows land at `hash_version = 1`, the verifier takes its v1 branch, which matches the reverted payload exactly — so the nightly job reports the chain intact forever. The concurrency fix was kept; the forensic fix was lost in the merge.

---

## 2. Tenant isolation — the control the whole product rests on

### 2.1 The RLS escape hatch was re-opened on 21 tables *(fixed in this pass)*
Migration `…983_rls_remove_escape_hatch` exists solely to strip `OR app_current_tenant() IS NULL` from every `tenant_isolation` policy, because that clause defeats RLS on any connection where the GUC is unset.

Three later migrations re-created policies with the old clause, and later migrations win:
`…986b_crm_v2_mirror` (17 `crm_*` tables — the full V2 CRM PII mirror), `…986d_spv_overlay` (2), `…987_v2_tracker_tables` (2).

A fourth instance was introduced by this session's own credit-ledger migration, by copying the pattern from a neighbouring billing migration without noticing `…983` had superseded it.

**Landed:** `…236003` corrected in place, and `…236005_rls_reclose_escape_hatch` re-tightens all 21 pre-existing tables.

### 2.2 One question to answer before anything else on this list
`config/db.ts` refuses to boot in production on a BYPASSRLS role. If that gate genuinely passes, then a large set of un-scoped call sites are querying RLS-enforced tables with `app_current_tenant()` NULL and receiving **zero rows** — the JTI denylist, the MFA gate, the billing gate, and every `audit_logs` insert (whose failure is swallowed). Those controls would be silently inert.

If instead they demonstrably work in production, then `DATABASE_URL` is **not** on an RLS-enforced role and tenant isolation is off globally.

Both branches are serious, and they are mutually exclusive. Confirm which is true first — it determines whether §2.1 was a latent hole or an active one.

### 2.3 `req.db` is optional, so 20 modules invented their own narrowing
`types/express.d.ts` declares `db?: PrismaClient | Prisma.TransactionClient`. Optional plus union means every consumer must narrow it, and they split into two camps that **disagree on the safety policy**:

- **Fail-open** — `return ((req.db as unknown as Db) ?? prisma)` in students, institutions, programs, enrollments, crm-leads, comms. These are exactly the tables where isolation matters most.
- **Fail-closed** — `throw new Error('tenantContext middleware not applied')` in expiries and others.

`dashboard.routes.ts` documents the correct rule: *"We MUST NOT fall back to the singleton because the per-request `app.tenant_id` GUC would be missing."* No test asserts which policy any module has.

**Highest-leverage single change in the codebase:** make `req.db` non-optional and delete all 20 `dbFor` copies. It collapses this finding, the three-parallel-mechanisms problem, and a large share of the 325 `as never` casts at once.

---

## 3. Where the system already meets the bar

Stated plainly, because it is substantial and worth protecting.

**Cryptography and auth.** RS256 pinned with an explicit post-verify assert and `kid`-resolved rotation. Refresh-token rotation with bidirectional chain-burn on reuse detection. Session-wide revoke via `sessions_valid_from`. Both auth caches **fail closed** on DB error. Argon2id at m=64MB. Refresh tokens stored as HMAC with a deploy-stable pepper. Envelope encryption at v2 with the KEK id inside the blob plus a retired-key registry, failing loudly on malformed rotation config. Enumeration-resistant login end to end. TOTP anti-replay atomic across replicas via Redis `SET NX EX`.

**Data handling.** Zero raw-SQL injection across ~40 `$queryRaw` sites. CSV formula injection neutralised in both writers. Upload MIME sniffed from magic bytes with OOXML container verification. Storage keys 100% server-derived with traversal rejection plus a `path.relative` re-check. Download integrity re-verified against stored SHA-256 on every read. Log redaction across 40+ paths; an independent cycle-safe Sentry scrubber.

**Correctness primitives.** `shared/fsm.ts` is a genuinely well-designed state-machine framework — declarative, load-time validated, correct 403/409/422 mapping. `tenantContext.ts`'s batched-transaction rewrite pipelines `set_config` + query into one round-trip instead of four. Keyset pagination is correctly implemented on the `(created_at, id)` tuple so duplicate timestamps never skip rows. Job locking uses a Postgres advisory lock that **fails closed**. Per-tenant job failure isolation with bounded concurrency.

**Discipline.** `strict` **and** `noUncheckedIndexedAccess` on in every tsconfig. Exactly one `@ts-ignore` and one `@ts-expect-error` repo-wide. Zero `any` in the frontend. Zero cross-module imports across 61 modules. Five TODO markers in 66k lines. Nearly every non-obvious decision carries a ticket ID and a rationale paragraph.

**Accessibility, in places.** All 112 icon buttons carry a non-empty `aria-label` — zero unnamed. WCAG 2.2 SC 2.5.8 target size passes everywhere. `prefers-reduced-motion` honoured globally and correctly layered. Status is never conveyed by colour alone. Skip link and main landmark correctly wired.

---

## 4. International-standards gaps, by standard

### WCAG 2.2 AA / EN 301 549
| Finding | Criterion |
|---|---|
| No `<h1>` on ~40 authenticated routes — `ListPageShell` emitted `<h4>` *(fixed)* | 1.3.1, 2.4.6 |
| `role="button"` on `<tr>` stripped table semantics from 35 grids *(fixed)* | 1.3.1, 4.1.2 |
| Form-field and card borders at **1.21–1.38:1** against their surfaces | 1.4.11 (needs 3:1) |
| Filled status chips at 4.21–4.24:1; dark mode never swaps to dark-role colours | 1.4.3 |
| `StageChip` picks foreground using non-linearised sRGB — tenant colours land at 2.30–2.78:1 | 1.4.3 |
| RTL declared (`dir="rtl"`) but never implemented: no `direction` in theme, no `stylis-plugin-rtl`, 98 physical spacing props vs 4 logical | 1.3.2 |
| Global single-key shortcuts (`/`, `c`) with no disable or remap | 2.1.4 |
| Tabpanels carry no `id`/`aria-labelledby`; tabs carry no `aria-controls` | 1.3.1, 4.1.2 |
| No `scroll-padding-top` — focus lands under the fixed app bar | 2.4.11 |
| `autocomplete` present only on auth fields, absent on name/phone/locale | 1.3.5 |
| 5 mouse-only click targets (8 instances); 2 are the only route to a detail page | 2.1.1 |

### Unicode CLDR / ICU
- **~2,570 hardcoded strings across 191 of 224 files.** The catalogue covers ~17% of rendered strings. All 136 toasts and all 47 validation messages are hardcoded. The auth flow — the first screen anyone sees — is 100% untranslated.
- **Non-English locales are empty.** `ar`/`hi`/`ne` are structurally complete (zero missing keys) and semantically **~0.06%** translated — one real string across all three.
- **The language switcher changes no date, number, or currency.** Two disconnected locale sources: next-intl's cookie drives messages, while `user.locale` drives all formatting. 70 of ~82 formatting call sites pass no locale at all.
- 26 hand-rolled binary plurals vs 7 ICU keys. Arabic CLDR requires six plural categories; even the 7 ICU keys declare only `one`/`other`.
- 8 `localeCompare` calls, none with a locale argument; no `Intl.Collator` anywhere.

### GDPR / UK-GDPR
- **Art. 9 special-category data in plaintext.** `religion` and `ethnicity` are plain columns, writable via the public API with no consent gate — and the Art. 30 register explicitly declares `special_category_data: false`. Combined with the next item, readable by every VIEWER.
- **Art. 5(1)(f) / Art. 32.** `GET /api/v1/students` has no `requireRole` and an optional caseload filter, so any role receives DOB, email, phone, nationality, notes, religion and ethnicity for **every** student — the exact control the by-id route was hardened to close.
- **Art. 15 / Art. 17.** Interview attempts are absent from the DSAR export bundle, and erasure matches on `student_id`, which the public flow never sets — so public-flow attempts holding candidate name, email and free-text answers can be neither exported nor erased.
- **Art. 35.** No DPIA artefact, despite Art. 9 data, minors, and cross-border transfer.
- **Art. 5(1)(e).** ROPA declares 7-year audit retention; no job enforces it in either direction.

### SOC 2 / ISO 27001
Controls an auditor will ask for that do not exist: periodic access review; key-rotation schedule and evidence; breach-notification drill records; anomaly detection on bulk PII access; off-host log immutability (a superuser can `ALTER TABLE audit_logs DISABLE TRIGGER`); restore-drill evidence; pentest records; sub-processor DPA enforcement; segregation of duties (ADMIN is one flat role that can read the audit log, mutate peers, move money and complete DSARs); end-user session inventory.

### OWASP ASVS 4.0 L2
Beyond §1 and §2: 13 billing routes are tenant-scoped but not caseload-scoped, so a counsellor can read and move money on another counsellor's student (the list endpoint *is* scoped — only the by-id mutating paths are not). `/readyz` is unauthenticated and echoes the raw database error, including host and role. Interview-prep share tokens are signed with the **production JWT private key**, last 365 days, and have no `jti`, no denylist, and no revocation path short of rotating the app's signing key.

---

## 5. Performance — the same bug in four costumes

Every one of these is "load everything, filter in JavaScript":

| Site | Cost |
|---|---|
| `reminderScanner` — 10 unbounded, unwindowed scans per tenant, then 3–4× fan-out in memory | ~1.2 GB heap for one of ten sections at 1M visas |
| Inbox thread list — downloads every message body in 200 threads to pick the newest per thread | ~100 MB for a 200-row payload |
| `/expiries` — no lower date bound, so it returns every expiry that has ever occurred | grows forever; the frontend fetches the whole set to render a count |
| Inbox count tiles — fetch a full 60-day expiry set to display one number | same file already uses `limit: 1` + `page.total` correctly elsewhere |

Structural items worth naming separately:

- **The audit hash-chain trigger does a full table scan on every INSERT.** `WHERE tenant_id IS NOT DISTINCT FROM NEW.tenant_id` is not indexable in Postgres, so the index built for exactly this query cannot be used. There are 249 `writeAudit` call sites, most awaited on the request path. `FOR UPDATE` on the chain tail then serialises all writes for a tenant, capping throughput regardless of replica count.
- **`shared/audit.ts` recomputes the same chain in Node, unscoped and unindexed — and the database throws the answer away**, because the `BEFORE INSERT` trigger overwrites both values unconditionally. Deleting five lines removes a full scan and two round-trips from all 249 call sites with zero behaviour change. **This is the single cheapest high-impact fix available.**
- **Trigram search indexes cannot serve the queries they were built for.** They index a concatenated expression while every query does per-column `ILIKE ... OR`. Postgres only matches an expression index on the identical expression, so all three are dead weight — write amplification with no read benefit — and every search is a sequential scan. `crm_leads` and `programs` have no trigram index at all.
- **Every keyset-paginated list pays an O(N) `count()` beside its O(log N) seek**, negating it entirely. At 1M rows the count is >99% of request latency, on page 1 and page 500 alike.
- **`billingDaily` issues up to 20,000 sequential single-row writes per tenant per night** where four set-based statements would do.
- **Frontend:** `Intl` formatters are constructed per cell per render — ~600 constructions for a 100-row × 3-money-column table. *(Fixed: cached.)* Pagination is decorative on 26 of 29 tables. Search fires one request per keystroke, and each request is the sequential scan above.

The encouraging part: **the codebase already contains the correct pattern for nearly every defect found** — `expiryAlerts.ts` for bounded scans, `bulkInsertReminders` for set-based writes, `exports.service.ts` for keyset streaming, `money.ts` for caching, `audit/Client.tsx` for formatter hoisting. Most of this is propagation, not design.

---

## 6. Deploy-path defects that will bite on the next push

- **The seed is not idempotent and forks a new tenant on every deploy.** `ensureTenant` sets `app.tenant_id` to a **fresh random UUID** and calls `findFirst`, expecting a wildcard. Since `…983` tightened the `tenants` policy to `USING (id = app_current_tenant())` with no `IS NULL` branch, and the table is `FORCE ROW LEVEL SECURITY`, the lookup matches zero rows, `existing` is always null, and a new tenant is created. `.do/app.yaml` chains `prisma:seed` onto every deploy with `deploy_on_push: true`. The comment asserting the seed is idempotent is false under the shipped policy.
- **`prisma migrate deploy` reads `DATABASE_URL`, never `DATABASE_MIGRATE_URL`.** The same key needs two *different* values in two components — de-privileged `spv_app` for the service, owner for the migrate job — and no deployment document mentions it. Setting the natural value fails every DDL statement.
- **Deploys are not gated on CI.** `deploy_on_push: true` is the only deploy path and DigitalOcean does not wait for GitHub Actions. A red `backend-ci` still ships.
- **425 index builds, none `CONCURRENTLY`** — and `…960_perf_indexes` contains a header comment claiming every index in it uses `CONCURRENTLY`. None do. It holds the three most expensive builds in the repo.
- **No rollback path exists.** No `down`/`rollback` SQL anywhere; every migration folder holds exactly one file. Several migrations are non-backward-compatible (`DROP COLUMN` on `payments`/`tenants`, `DROP TABLE`), so rolling the app back leaves the schema forward.
- **The migration ordering scheme has exhausted its numeric space** — 52 migrations carry an invalid time component (`235960`…`236004`; there is no 23:60) and two share the prefix `20991231235983`, ordered by alphabetical luck.

---

## 7. Sequenced plan

Ordered by risk retired per unit of effort. Nothing here is a new feature.

### Stage 0 — Stop the false assurance (days)
1. Install `@sentry/node`; add DigitalOcean's `alerts:` block and `log_destinations:`. Four lines of YAML is the difference between "someone finds out" and "nobody does".
2. Uncomment the backup schedule; perform **one** real restore and record RTO/RPO.
3. Document and test KEK escrow, or move to `KMS_PROVIDER=aws` (already implemented). Today, losing one environment variable is unrecoverable total data loss.
4. Make ClamAV production-required, or write `av_status: 'PENDING'` when no scan ran and let the download gate mean what it says.
5. Restore the v2 audit payload and the `hash_version := 2` stamp.
6. Fix the seed's tenant lookup and the migrate job's `DATABASE_URL` contract **before** the next deploy.
7. Point the health check at `/readyz`, stop echoing raw DB errors, and drive `db_up`/`redis_up` from a ticker rather than an HTTP handler.

### Stage 1 — Close the isolation and access gaps (1–2 weeks)
8. Answer §2.2 definitively. Everything else in this stage depends on the answer.
9. Make `req.db` non-optional; delete the 20 `dbFor` copies; add a test asserting every router is mounted with `authenticate` + `tenantContext`.
10. Scope `GET /students` and the 13 by-id billing routes to caseload, matching their own list endpoints.
11. Encrypt `religion`/`ethnicity` behind a consent gate, or drop the columns; correct the ROPA either way.
12. Give interview-prep tokens their own key, a short TTL, a `jti`, and a revocation path; add RLS to its tables.

### Stage 2 — Make the numbers honest (1–2 weeks)
13. Delete the dead chain read in `shared/audit.ts` (five lines, removes a full scan from 249 call sites).
14. Make the chain trigger's predicate indexable; move the chain tail to a one-row-per-tenant table to lift the write-serialisation ceiling.
15. Replace the trigram indexes with per-column ones that match the queries; add them for `crm_leads` and `programs`.
16. Drop or approximate `total` on cursor-paginated endpoints.
17. Window and bound every job scan; collapse `billingDaily`'s loops to set-based statements.
18. Debounce search; wire the pagination controls that currently do nothing.

### Stage 3 — Reach the accessibility and localisation bar (3–4 weeks)
19. Raise `outlineVariant` and the status palette to 3:1/4.5:1; fix `StageChip` to use real relative luminance.
20. Decide RTL honestly: either implement it (theme `direction`, `stylis-plugin-rtl`, logical properties) or stop advertising `dir="rtl"`.
21. Source formatting locale from `useLocale()` so the language switcher actually switches the language.
22. Extract strings systematically, starting with auth, toasts and validation messages. Then commission real translations — shipping four locales that are 0.06% translated is worse than shipping one.
23. Wire tabpanel ARIA, `scroll-padding-top`, `autocomplete`, and the five mouse-only targets.

### Stage 4 — Earn the certifications (ongoing)
24. Retention schedule per entity, with jobs that enforce it.
25. Access review, key-rotation evidence, restore-drill records, DPIA, breach-notification drill.
26. Off-host WORM log shipping so the audit chain is tamper-evident *and* tamper-proof.
27. Expand/contract migration policy with a CI check rejecting destructive DDL without a paired expand-phase marker; `CONCURRENTLY` for index builds on large tables.
28. Segregation of duties: maker-checker on refunds, erasures and role changes.

---

## 8. Landed in this pass

- Re-closed the RLS escape hatch on 21 tables (`…236005`) and corrected the instance introduced by this session's own credit-ledger migration.
- Patched every HIGH supply-chain advisory with in-range upgrades — no major version bumps required: `next` 15.5.18→15.5.21, `sharp` 0.34.5→0.35.3, `multer` 2.1.1→2.2.0, `axios` 1.16.1→1.19.0, `js-cookie` 3.0.5→3.0.8.
- Unbroke `backend-ci` and `frontend-ci`, which had been failing at pnpm setup for four consecutive commits — meaning lint, typecheck, the full test suite and `prisma migrate deploy` had not run on any recent commit.
- `<h1>` on every page built on `ListPageShell` (~40 routes).
- Removed `role="button"` from table rows, restoring table semantics on 35 grids.
- Date-only values now render in UTC, fixing every `expires_on`/`due_on`/`paid_on` reading a day early for users in the Americas — a real hazard on a visa-expiry tracker.
- Cached `Intl` formatters instead of constructing one per cell per render.

---

## 9. How to read this document

Every claim above is traceable to a file and line in the audit transcripts. Where a finding was retracted on verification, it was recorded rather than quietly dropped — see the retraction in `SPVT-QA-REMEDIATION.md`. An audit that only reports confirmations is not an audit.

The honest summary: **this codebase is well above average in craft and materially below its own documentation in operations.** The engineering instincts on display — fail-closed caches, advisory locks, the FSM framework, the batched-transaction rewrite, comment discipline — are the hard part, and they are already here. What is missing is the unglamorous connective tissue: a dependency actually installed, a cron actually uncommented, an alert actually routed, a translation actually written. That is good news, because connective tissue is cheap. It just has to be done, and then verified rather than assumed.
