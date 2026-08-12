# QA expert panel — findings register (2026-08-12)

Seven review lenses run against the repo: security, financial correctness,
reliability/SRE, frontend UX + accessibility, dead controls, data privacy, and
performance at scale. Plus a first-party end-to-end reachability pass.

**~70 findings. 10 CRITICAL. This is a multi-week register, not a sprint.**

Every finding below carries a file:line and a concrete failure scenario. Nothing
here is "consider refactoring". Items are ordered by *what it costs if left*,
not by effort.

Status legend: **FIXED** (landed + tested) · **OPEN** · **NEEDS SIGN-OFF**
(billing/schema/PII — hard stop for autonomous deploy).

---

## Tier 0 — silent, permanent, unrecoverable

These share one property: nothing errors, nobody is alerted, and the damage
cannot be undone after the fact. They outrank everything else.

### T0-1 · KEK rotation destroyed all encrypted PII — **FIXED**
`src/config/kms.ts:94` (was)

Two independent paths to unrecoverable loss:

- **v1 envelopes**: `keyFor(undefined)` returned the *active* key, reasoning
  that a v1 blob "was written with the only key that ever existed". True until
  the first rotation. After one, every v1 blob was written by a now-retired key,
  GCM failed, and `KMS_KEK_PREVIOUS` was never consulted. `rewrap-secrets` could
  not rescue them — it decrypts through the same path.
- **id collision**: `KMS_KEK_ID` has a *default*, so it need never be set. An
  operator who rotates `KMS_KEK_BASE64` and moves the old pair into
  `KMS_KEK_PREVIOUS` — but leaves `KMS_KEK_ID` alone — stamps new key material
  with the id every existing envelope carries. Old ciphertext then resolved to
  the new key and the retired key was never tried.

Fixed: v1 now walks the active key then every retired key (AES-GCM
authenticates, so a wrong key fails the tag rather than returning garbage), and
an active id colliding with a retired one refuses to boot. 8 tests.

### T0-2 · DSAR COMPLETED can outlive a crashed erasure — **OPEN, scope corrected**
`src/modules/dsar/service.ts:1076` then `:1204`

**Correction to the panel's report, verified on re-read.** A compensating
`catch` at `:1227` already exists and is well-built: it reverts the status,
clears `completed_at`, audits the failure and re-throws. So an erasure that
*throws* is handled correctly, and the ordering (status commits first) is a
deliberate, documented choice so the audit chain reads
`status→COMPLETED` then `dsar.erasure.executed` chronologically.

The residual risk is narrower but real: the `catch` cannot run on SIGKILL, OOM
or pod eviction. A hard kill between the two transactions leaves COMPLETED with
live PII, and the from-status guard at `:1080` makes a re-PATCH a no-op, so the
erasure can never fire again.

Reordering is the wrong fix — it would break the audit-chain rationale. The
right fix is reconciliation: an `erasure_executed_at` column (or a scan for
ERASURE DSARs that are COMPLETED with no `dsar.erasure.executed` audit row) plus
a job that re-runs them. **That is a schema change, so it is a hard stop needing
sign-off** — not startable inside a routine batch.

### T0-3 · S3 delete swallowed every error; erasure reported success — **FIXED**
`src/modules/documents/storage.ts:223` — `.catch(() => undefined)`

Production runs `STORAGE_DRIVER=s3`. A 403/500/timeout during the retention pass
is treated as success: `deleted_at` is set, an audit row asserts
`document.retention_shredded`, and the next scan filters on `deleted_at: null`
so the document is never revisited. The passport scan is still in the bucket and
the audit log affirmatively states it was destroyed. `LocalStorage.delete` at
`:139` gets this right. Same path in `dsar/service.ts:524`.

### T0-4 · Enrollment status commits before the fee plan exists — **OPEN**
`src/modules/enrollments/enrollments.service.ts:557` then `:619`

Crash between them leaves a student ENROLLED with no FeePlan and no
installments — never invoiced, ever. Both hooks are gated on a status *change*,
so re-PATCHing the same status is a no-op and the normal path can never mint
them again. Silent permanent revenue loss, invisible until someone reconciles
receivables by hand.

### T0-5 · Import retry restarts at row 1 and duplicates students — **OPEN**
`src/modules/imports/imports.service.ts:300`

Only `CANCELLED`/`COMPLETED` are refused; `APPLYING` is accepted. After a
mid-file crash, N chunks are durably applied but the job still says APPLYING. A
fresh Idempotency-Key re-runs from row 1; rows without an `external_id` fall
through to an unconditional `student.create`. The customer's student list
silently doubles for part of an import.

### T0-6 · Job advisory lock is session-scoped; Prisma does not pin connections — **OPEN**
`src/jobs/lock.ts:49`

`pg_try_advisory_lock` and `pg_advisory_unlock` are separate calls with many
queries between them, so the unlock can land on a different pooled connection.
Two failure directions: the lock is never released and every job thereafter logs
`SKIPPED_LOCKED` (which reads as normal multi-replica behaviour, so reminders,
comms, billing and retention silently stop) — or, since advisory locks are
re-entrant within a session, an overlapping run re-acquires and executes
concurrently. `ttlSec` is accepted and never used.

---

## Tier 1 — money is wrong

### T1-1 · `regeneratePlan` re-bills money already paid — **NEEDS SIGN-OFF**
`src/modules/billing/plan.service.ts:548`

Regenerate cancels the old plan without carrying `paid_minor` forward and
rebuilds from `before.total_minor` — the full original. Plan of 1,000,000 with
350,000 collected, regenerated to fix a due date, goes from 750,000 outstanding
to **1,000,000**. The student is dunned for money they already paid. The code
comment at `:513` names this exact hazard as the thing to avoid.

### T1-2 · `financeSummary` double-counted partial CRM fees — **FIXED**
`src/modules/crm-leads/crm-leads.service.ts:751`

**My regression from earlier today.** I added PARTIAL to `OPEN_FEE_STATUSES`
without updating the aggregate: `outstanding` sums the full `amount_minor` of a
part-paid fee while `collected` counts only `status: 'PAID'`. A 100,000 fee
part-paid 40,000 reports outstanding 100,000 (should be 60,000) and collected 0
(should be 40,000) — an 80,000 swing on one fee, in the exact money the PARTIAL
status was introduced to preserve.

### T1-3 · `Enrollment.scholarship_minor` never applied — **FIXED**
`src/modules/billing/enrollment-hook.ts:75`

Same bug class as the FeePlan scholarship fixed earlier today, one layer
upstream. The auto-seed omits `scholarship_minor` even though `createFeePlan`
accepts and applies it. Tuition 2,000,000 with a 500,000 scholarship seeds a
plan billing **2,000,000**, and the invoice prints no scholarship line — so the
document is internally consistent and the error is undetectable from the
artifact.

### T1-4 · Refund mints a second credit for the same cash — **OPEN**
`src/modules/billing/payment.service.ts:664`

`completeRefund` never retires the StudentCredit the payment minted (compare
`voidPayment:413`, which does). An overpayment creates Credit A; the refund
throws with guidance to pass `credit_carryforward=true`; following that
instruction mints Credit B. Net cash movement zero, outstanding credit liability
**doubled**, both spendable against real installments.

### T1-5 · Reversal restores a balance onto a WAIVED installment — **OPEN**
`src/modules/billing/payment.service.ts:378`, `:614`

Status is only rewritten when currently PAID or PARTIAL, so a WAIVED row keeps
WAIVED while regaining a live balance. The DB CHECK passes. That balance is then
invisible to `getOutstanding` and the dashboard but *visible* to
`outstandingByAge` — two finance screens disagree, and no API path can fix the
row because the FSM has no outbound WAIVED edge.

### T1-6 · Late-fee recompute is an unlocked read-modify-write — **OPEN**
`src/jobs/billingDaily.ts:328`–`:353`

Four statements, no transaction, no version predicate — unlike `applyAdjustment`
which holds `FOR UPDATE` throughout. A payment landing mid-sequence yields a
**PAID installment carrying a balance**, excluded from every collection path and
never rescanned. Crashing mid-sequence orphans the adjustment permanently,
because the same-day idempotency guard then skips the recompute forever.

### T1-7 · `commissions.summary` dropped legacy PAID rows — **FIXED**
`src/modules/commissions/service.ts:707`

`(_sum.received_minor ?? _sum.amount_minor)` is a *group*-level coalesce where a
*row*-level one was intended. SQL `SUM` skips NULLs, and the column was added
with no backfill, so pre-migration rows vanish unless every row in the group is
NULL. Collections understated by exactly the legacy total.

### T1-8 · `/reports/commission-revenue` reported claimed, not received — **FIXED**
`src/modules/reports/service.ts:141` · Same defect `summary()` already fixed;
the reports surface was not updated. Two finance screens, same row, 150,000
apart on a short-settled claim.

Fixed by adding `total_received_minor`, summed with a genuine row-level
`COALESCE(received_minor, amount_minor)` for PAID rows (raw SQL here, so the
coalesce can be expressed directly — unlike T1-7, which needed two grouped sums).

**Deliberately NOT changed: the date basis.** Rows are still bucketed by claim
date, not payment date. Moving PAID onto `paid_on` would reconcile more
naturally against a bank statement, but it silently changes what "month" means
in an existing report and shifts claims across period boundaries. That is a
product decision, not a bug fix — **left for sign-off**.

### T1-9 · Idempotency caches FAILED for 24h, including for writes that committed — **OPEN**
`src/shared/idempotency.ts:187`, `:226`

The SUCCESS write sits *inside* the try, so a transient error after a committed
payment records FAILED. The client retries and is replayed the failure; the
operator re-enters the payment with a fresh key — **a second payment**. The
mandatory Idempotency-Key on that route exists to prevent exactly this.

### T1-10 · Regenerating with explicit `lines[]` compounds the scholarship — **OPEN**
`src/modules/billing/plan.service.ts:534` · Partly a consequence of today's
scholarship fix. Passing an already-net schedule re-applies the discount; a
third pass compounds again. Each resulting invoice is internally consistent, so
the drift is invisible.

### T1-11 · `late_fee_policy.fee_pct` can never charge — **OPEN**
`prisma/schema.prisma:2652` documents `fee_minor | fee_pct`; the parser reads
only `amount_minor ?? fee_minor`. The percentage arm of the documented shape
silently does nothing.

### T1-12 · `Enrollment.agent_commission_minor` is write-only — **OPEN**
Stored via API and CSV import, read by nothing; commission is always derived
from the institution rate. A negotiated per-enrollment commission is silently
ignored.

---

## Tier 2 — visible in a demo

### T2-1 · Students list pagination was decorative — **FIXED**
`app/(app)/students/Client.tsx:238`, `:727`

**This corrects a claim I made.** The DataTable pagination fix did *not* cover
the flagship table, because `/students` hand-rolls its own `<Table>` +
`<TablePagination>`. The query key omits the page index and the request sends
only `{limit}` — no cursor. Clicking next changes the label to "26–50 of 340"
and shows **the same 25 rows**. The file's own comment concedes "the page count
is informational". The API is cursor-paged, so a numeric pager can never work;
`app/(app)/audit/Client.tsx:396` already has the correct `cursorStack` pattern.

### T2-2 · DataTable reports the fetch cap as the true total — **OPEN**
`components/DataTable.tsx:111` · Only 3 of ~31 call sites pass a real server
`rowCount`; the rest fetch a hard cap of 100. A tenant with 140 consents sees a
confident "1–25 of 100" and rows 101+ are unreachable and undisclosed.

> Fixed with a cursor stack (the pattern `app/(app)/audit/Client.tsx` already
> used), the cursor added to the query key so it actually refetches, next/back
> driven by the server's `hasMore`, and `page` dropped from the URL because a
> page number cannot be restored under keyset paging. Three contract tests pin
> `cursor` as accepted and an offset-style `page` as rejected.
>
> **T2-2 and T2-3 below are the same family and remain open** — `DataTable`
> still reports a fetch cap of 100 as the true total on ~28 call sites, and the
> Users page has no pager at all.

### T2-3 · Users page truncates at 50 with no pager at all — **OPEN**
`app/(app)/users/Client.tsx:144`

### T2-4 · Inbox "Recent threads" counts students — **OPEN**
`app/(app)/inbox/Client.tsx:189` · Fetches `/students?limit=10` and renders the
array length under a threads label. On a fresh demo tenant it reads "3"; on any
real tenant it is pinned at 10. `/comms/threads` is live and returns real counts.

### T2-5 · KPI alarm colour never renders — **OPEN**
`components/KpiTile.tsx:39` · Uses `warning.lighter`/`error.lighter`, which the
theme never defines, so MUI emits invalid CSS the browser drops. The warning
accent is dead exactly where it matters — refund rate >5%, overdue installments,
terminal outbox failures. Nothing looks wrong when something is wrong.

### T2-6 · Document "Reject" fires on one click with no confirmation — **OPEN**
`features/students/records/DocumentsSection.tsx:416` · One pixel-row from
"Verify", and once fired both inline buttons disappear — no inline undo. The
file already imports `ConfirmDialog` and uses it for delete.

### T2-7 · Required field with no reachable error — **OPEN**
`features/students/AdvanceStageDialog.tsx:510` · Rendered `required`, declared
`.optional()` in zod, omitted from the payload when empty, and its server error
is dropped by both the field mapper and the top-level banner. The user submits,
gets a generic snackbar, and the field marked required never shows an error.

### T2-8 · Fee plan pause/resume/cancel have no UI — **OPEN**
`features/billing/queries.ts:358`–`:380` · Exported, zero call sites, while
`PlanSummaryCard.tsx:220` renders a "Plan paused" alert for a state no control
can enter or leave.

### T2-9 · No `<h1>` on ~30 authenticated pages — **OPEN** (WCAG 1.3.1 / 2.4.6)
The biggest pages hand-roll headers as `variant="h4"` → literal `<h4>`.

### T2-10 · Command palette "Billing" navigates to Settings — **OPEN**
`components/CommandPalette.tsx:33` · `/billing` exists and is in the nav.

### T2-11 · Dark-mode users get a white flash on every load — **OPEN**
`app/providers.tsx:76` · Mode hardcoded `'light'` for SSR; the masking guard is
inert (`visibility: hydrated ? 'visible' : 'visible'`).

---

## Tier 3 — breaks at customer scale

Assumption: 20k students, 50k leads, 200k finance rows.

### T3-1 · Reminder insert exceeded Postgres' bind-parameter ceiling — **FIXED**
`src/jobs/reminderScanner.ts:143` · Unchunked `createMany`, 13 columns → ~2,520
row ceiling. **Was at ~95% of the limit on the existing dataset** — breaking at
roughly 1.1x current data, not 100x. The catch logged and returned 0, so the job
reported success while inserting nothing and reminders silently stopped.

Fixed on both halves:
- Inserts are chunked at 500 rows (6,500 params — headroom for the row shape to
  grow to 40 columns and still clear the ceiling). Chunking is safe *because*
  the insert is idempotent: the `(tenant_id, source_entity_type,
  source_entity_id, scheduled_for)` unique plus `skipDuplicates` means a failed
  chunk leaves earlier ones committed and the next scan re-offers the remainder.
  That was checked before changing anything — chunking a non-idempotent insert
  would have traded a silent stall for silent duplicates.
- `ScanResult` gained `failed`. Previously a dead write returned 0, and
  `inserted: 0` is exactly what a healthy re-run produces when every row is
  already present, since ON CONFLICT skips are not counted either — so
  "reminders have stopped" and "nothing new to do" were the same number.

7 tests, including the ceiling assertion with a 4x margin so the batch cannot
creep back toward the limit, and failure-mid-run cases proving the scan
continues and reports the loss.

### T3-2 · Ten unbounded whole-tenant scans in the same job — **OPEN**
`reminderScanner.ts:200`–`:663` · No `take`, no date window; past-dated rows
filtered in JS after transfer. ~150k–250k rows into heap per tenant per pass.
Combined with the boot-time kick in `scheduler.ts:384`, an OOM becomes a
self-sustaining crash loop that Sentry never sees because the process is killed.

### T3-3 · `v2Ingest` opens one transaction per row — **OPEN**
`src/jobs/v2Ingest.ts:101` · ~4 round-trips × 400k–600k rows ≈ **1–5.5 hours**,
against a 6h lock TTL, with no incremental watermark.

### T3-4 · `billingDaily` silently truncates at 5,000 — **OPEN**
20k students on monthly plans ≈ 240k installments, so the daily set exceeds the
cap and **billing falls permanently behind with no signal**.

### T3-5 · Trigram search indexes are unreachable — **OPEN**
`20991231235960_perf_indexes:52,97,121` · Indexed on a *concatenated expression*
while Prisma emits *per-column* ILIKE. Postgres cannot use an expression index
for a predicate that doesn't match it. All three are pure write amplification;
student search is a seq scan, run twice. `crm_leads` has no trigram index at all.

### T3-6 · `count()` double-counts the cursor — **OPEN**
`students.service.ts:215` and three others · `where` is mutated to include the
cursor *before* `count()` uses it, so `total` becomes "rows after the cursor" on
page 2+. Correctness bug on top of the cost.

### T3-7 · `getOutstanding` transfers every open installment — **OPEN**
`plan.service.ts:633` · ~200k rows to sum four numbers, and it has no role
scoping, so a COUNSELLOR gets a tenant-wide financial total.

---

## Tier 4 — configuration with outsized blast radius

### T4-1 · Health check points at an endpoint that checks nothing — **OPEN**
`.do/app.yaml` → `/livez`, which returns `{status:'ok'}` unconditionally.
`/readyz` probes the DB and nothing uses it. A deploy with a bad `DATABASE_URL`
is promoted as healthy while every request 500s.

### T4-2 · `REDIS_URL` is a dummy, so every Redis-backed control is degraded — **OPEN**
`.do/app.yaml` sets `redis://localhost:6379` to satisfy the schema. The client
really dials it, fails, and caches `null` permanently. Consequences: rate limits
fall back to per-process memory (the 5/min auth brute-force cap becomes 5×N),
MFA anti-replay uses an in-process map, the multi-replica warning never fires,
and `redis_up = 0` forever on the one gauge meant to page.

### T4-3 · Audit chain forensic coverage was reverted by migration ordering — **OPEN**
`20991231235996_audit_chain_for_update` sorts *after*
`…235994_audit_chain_forensic_fields` and its `CREATE OR REPLACE` restores the
v1 payload — dropping `hash_version := 2` and the actor/IP/user-agent hashes.
`audit_logs_verify` branches on `hash_version >= 2`, so rows now verify cleanly
as v1 and the daily job stays green while the forensic fields sit **outside** the
tamper-evident hash.

### T4-4 · RLS role assertion fails open, after the socket is already accepting — **OPEN**
`src/config/db.ts:76`, `src/server.ts:48` · If the boot probe throws it is
skipped entirely, and it runs inside the `listen` callback. A deploy coinciding
with a failover serves indefinitely with the check never performed.

---

## Tier 5 — privacy

### T5-1 · pino redaction only reaches depth 2 — **OPEN**
`src/config/logger.ts:16` · pino's `*` matches exactly one level, but the comment
claims the wildcards catch nested request bodies and audit payloads. Empirically
reproduced: `{req:{body:{email,date_of_birth,password}}}` logs all three in
cleartext. This is what makes T5-2 and T5-3 land unredacted, and
`tests/logger-redaction.spec.ts` only asserts depth 2, so the gap is untested.

### T5-2 · Request logging writes student names on every search — **OPEN**
`src/app.ts:113` · `pinoHttp` with no serializer override logs `url` (query
string included) and the parsed `query` object. `GET /students?search=<name>`
therefore writes the name verbatim, twice, on every counsellor lookup.

### T5-3 · `LogProvider` logs recipients and message bodies — **OPEN**
`src/modules/comms/providers/log-provider.ts:40` · `EMAIL_PROVIDER` defaults to
`'log'` with no production guard, and SMS/WhatsApp/in-app are hardwired to it
*unconditionally*. `resend-provider.ts:111` correctly hashes recipients.

### T5-4 · DSAR export bundles are never deleted — **OPEN**
`src/modules/dsar/service.ts:968` · The Art. 15 bundle is one JSON blob of fully
*decrypted* PII. Nothing deletes it, erasure doesn't reach it, and the storage
key stays on the row so a fresh download can be minted indefinitely. A subject
who exercises access-then-erasure leaves a complete decrypted copy behind.

### T5-5 · Export/import files retained forever; the 24h expiry is decorative — **OPEN**
`exports.service.ts:323` sets `expires_at` that no code path reads, and no reaper
is scheduled. Every student CSV and every raw uploaded import file is retained
and re-downloadable indefinitely, and neither is reached by erasure.

### T5-6 · Custom fields are in neither DSAR export nor erasure — **OPEN**
`EntityAttribute` carries an explicit `is_pii` flag and appears in neither path.
The feature shipped days ago and both DSAR paths were missed. `ExternalId` and
`StudentLifecycleEvent` are likewise in neither.

### T5-7 · "Redacted" export still identifies every student — **OPEN**
`exports.service.ts:546` · Masks email/phone but not name, DOB or nationality —
all in the default column set. Two of the masked branches target columns that
don't exist on `Student`. The control gives false assurance.

### T5-8 · Sentry scrubber misses the identity fields this product stores — **OPEN**
`config/sentry.ts:53` · No `given_name`/`family_name`/address/`notes`. It also
runs only on the Sentry path, so the two sinks have divergent protection.

---

## Tier 6 — security

Headline from the red-team lens: **no CRITICAL, and no route is missing
`authenticate`** (all 66 route files verified). No SQL injection, no SSRF, no
path traversal, no tenant id taken from body or params. Tenant isolation is
genuinely good. The damage is concentrated in session revocation, one
authorization gate, and credentials reaching logs.

### T6-1 · `POST /auth/logout` never revokes the access token — **OPEN**
`src/modules/auth/auth.routes.ts:44` · The chain is `originGuard, logout` with no
`authenticate`, so `req.user` is always undefined, so the access-token JTI is
never written. The denylist block in `auth.service.ts:607` is the only writer in
the codebase and it never executes — **the entire denylist is dead code**. A
stolen token keeps full API access for the remaining TTL after the victim clicks
"Log out" and sees success. Compounding: `middlewares/auth.ts:101` reads the
denylist through the un-scoped `prisma` client *before* `tenantContext` sets the
GUC, so even a real row returns null under RLS — **fail-open**.

### T6-2 · The list endpoint bypasses `requireStudentOwnership` — **OPEN**
`src/modules/students/students.routes.ts:45` vs `:58` · `GET /students/:id` is
ownership-gated and returns 403; `GET /students?limit=100` is not scoped to the
caller at all and returns every student in the tenant, with names, DOB, both
emails, both phones, religion, ethnicity and notes. `redactSensitive` strips only
`*_enc` keys. The comment at `:55` claims this hole was closed.

### T6-3 · `POST /users` minted an ADMIN with no MFA step-up — **FIXED**
`src/modules/users/users.routes.ts:31` · Every other privileged route on the
router requires a fresh `X-MFA-Code`; create did not, and `role` is
client-supplied. A stolen ADMIN token could not patch a user — but could create a
new ADMIN with a chosen password and no MFA. That is persistence, and strictly
more valuable than the operations that *were* gated.

Gated, after confirming no bootstrap deadlock: the first admin comes from
`prisma/seed.ts`, not this route, and `/auth/mfa/setup` + `/auth/mfa/verify`
require only `authenticate`, so an unenrolled admin can always self-enrol.

**This also exposed a testing weakness worth keeping in mind elsewhere.**
`tests/users-admin-mfa-routes.spec.ts` cannot mount the real router — it
self-applies `authenticate`, which would need a real JWT — so it re-declares the
routes in a local express app and asserts a COPY of the wiring. Delete
`requireMfa` from the production router and every one of those tests still
passes; that is how this hole survived. Added
`tests/users-routes-mfa-wiring.spec.ts`, which reads the router SOURCE and
asserts every mutating route carries the gate (and that reads deliberately do
not, so it cannot pass by gating everything). Verified it genuinely fails when
the gate is removed rather than being decorative.

Any other spec in this repo that "mirrors production wiring" has the same blind
spot and is worth auditing the same way.

### T6-4 · Plaintext passwords reach logs on malformed JSON — **OPEN**
`src/middlewares/errorHandler.ts:59` · body-parser attaches the raw request body
to its error; pino's error serializer copies every enumerable property. Redaction
is path-based and `err.body` is not a path. `POST /auth/login` with truncated
JSON writes the password unredacted at error level. Same mechanism exposes `pg`
`err.detail`, which embeds failing column values.

### T6-5 · Interview-prep token: 365-day, unrevocable, tenant-wide, in the URL — **OPEN**
`src/modules/interview-prep/token.ts:25` · No `jti`, no `iss`/`aud`, signed with
the same key as user access tokens, passed as `?t=<jwt>` — so it lands in access
logs, browser history and `Referer`. Anyone holding it can enumerate the tenant's
whole question bank with model answers. No revocation short of rotating
`JWT_PRIVATE_KEY`, which would sign out every user in the product.

### T6-6 · Uploads are stamped `av_status: 'CLEAN'` when no scan ran — **OPEN**
`src/modules/documents/documents.service.ts:216` · The scan is conditional on
`CLAMAV_HOST` (optional, off by default) but the row is written CLEAN with a
timestamp unconditionally. The two download gates checking `av_status` become
permanent no-ops, and the DB carries a false attestation.

### T6-7 · `GET /leads/:id` is missing `requireLeadOwnership` — **OPEN**
`src/modules/crm-leads/crm-leads.routes.ts:61` · Every lead *mutation* has the
gate; the single-item read does not.

---

## Tier 7 — product gaps a competitor will demo

### T7-1 · A commission clawback cannot be recorded — **BATTLE CARD CORRECTED**
`PAID`/`WAIVED` are terminal with no outbound transition, and the three guards
that refuse a change on a PAID claim point at a credit-note workflow, a dispute
that itself refuses PAID, and an adjustment model — **none of which exist**
(0 matches for `CommissionAdjustment|CreditNote` in the schema).

**This falsified a claim in the battle card**, which told the seller to ask a
competitor exactly this question. Corrected 2026-08-12; the claim is now recorded
as an open gap in §3.9 and the question removed from §4.

### T7-2 · Claimed-vs-received variance — **FIXED**
`MarkPaidDialog.tsx` sent only `paid_on` + `payment_reference`, so
`received_minor` defaulted to the full claimed amount and the variance was
structurally always zero; no column displayed it either.

Fixed end to end:
- The dialog now takes the amount received, prefilled with the claimed figure
  (settling in full is the common case, so any edit is a deliberate statement
  that less arrived). Entry is in MAJOR units — what the operator reads off the
  remittance advice — converted via `lib/money.majorToMinor`, which uses the
  currency's real ISO-4217 exponent, so it is correct for 0-, 2- and 3-decimal
  currencies rather than assuming cents.
- `received_minor` was missing from the `CommissionRow` type entirely, which is
  why no table could show what the backend was already storing. Added.
- The commissions table gained a **Received** column showing the cash and, when
  it differs, the signed variance ("short 1,600" / "over 200").

**§3.8 of the battle card can be reverted once this ships and is demoed** — the
reconciliation question becomes safe to ask again. Leave it corrected until then.

### T7-3 · Converted lead fees leave every finance rollup — **OPEN**
`FinanceItem` is aggregated nowhere — the dashboard, `/reports/outstanding-by-age`
and exports all read `fee_installments`. The agency's own service fee goes dark
at the moment of conversion.

### T7-4 · Country stage templates are dead seed data — **OPEN**
`prisma/data/country-stage-templates.json` is complete and correct and `seed.ts`
never loads it. Cheapest credibility win available.

### T7-5 · No lead can be created except by syncing an external CRM — **OPEN**
The only creating route is `POST /leads/sync`; there is no `POST /leads` and no
lead importer. For a prospect not already on TheNextMis V2 the entire front half
of the demo is inert.

### T7-6 · No branch model, no bulk anything — **OPEN**
No organisational unit between "one counsellor" and "the whole tenant", and no
bulk assign / transition / message. A departing counsellor's 200 students must be
reassigned one at a time. Also: Import/Export buttons are shown to counsellors
while the backend requires ADMIN — a visible button that 403s.

### T7-7 · The commission "invoice" produces no invoice — **OPEN**
`POST /commissions/:id/invoice` mints an invoice *number* and no document. The
only renderers in the codebase are the student fee-plan `.txt`/`.pdf`. Staff
still build the real invoice in Word.

### T7-8 · XLSX is offered everywhere and always fails — **OPEN**
The writer throws (no `exceljs` dependency) while the dropdown and the admin
console both advertise it. A buyer clicks it in the room and watches it fail.

---

## Tier 8 — accessibility (WCAG 2.1 AA)

Two axes came back **clean**: all 112 icon buttons carry an `aria-label`, and
colour-only status does not exist (every chip pairs icon + text). No focus traps.

### T8-1 · Controls with no accessible name — **OPEN**
Every phone input in the product (`PhoneField` rendered with `label=""` across 9
call sites, inside a `LabeledField` with no `htmlFor`), the inbox reply composer,
and the student/assignee comboboxes in both reminder dialogs. Screen readers
announce "edit, blank". Context: 482 of 523 `LabeledField` usages *do* pass
`htmlFor` — this is a small set of misses in an otherwise sound pattern.

### T8-2 · No `<h1>` anywhere in the authenticated app — **OPEN**
The student detail page's primary heading is a literal `<h6>`; dashboards and
lists start at `<h4>` and skip to `<h6>`. Every KPI tile injects an `<h5>` whose
text is a bare number, so heading navigation returns context-free figures.

---

## What came back clean

Worth knowing where *not* to spend effort. Verified sound by the panel:

- **Contract integrity**: every frontend API call maps to a mounted backend
  route. Zero 404-class drift.
- **Transaction discipline in billing**: `payment.service`, `plan.service` and
  `credit.service` wrap their money movements properly — the late-fee cron is
  the outlier, not the norm.
- **`withTenantTx` and the batched RLS extension** are correct and well-reasoned:
  one round trip, GUC local-scoped, no isolation weakening.
- **Currency handling**: no cross-currency sum anywhere. Every aggregate groups
  per ISO code.
- **`applyScholarship`** largest-remainder allocation is provably exact.
- **Destructive-action coverage**: 23 of 24 `api.delete` sites are behind a
  confirm dialog.
- **Icon-button labels, focus traps, colour-only status**: all genuinely well
  maintained. No findings.
- **Form/submit wiring**: every `formId` resolves to a real form; zero mismatches.
- **`errorHandler`** refuses to echo Prisma messages — the response boundary is
  clean; the leakage is all on the log side.
- **Documents** are envelope-encrypted before storage, and ClamAV runs locally
  so no document bytes leave the perimeter.
- **Fail-open/closed calls that were made deliberately were made correctly** —
  job locks, `sessions_valid_from`, and HIBP all fail closed. The problems above
  are the ones nobody decided.

---

## Recommended order

1. **T0-3, T0-2, T0-4** — silent, permanent, and each falsifies a compliance or
   revenue record.
2. **T0-6** — one change protecting every background job.
3. **T1-2** (my regression), **T1-3**, **T1-1** — money that is wrong today.
4. **T2-1** — highest demo risk, and it corrects a claim already made.
5. **T4-1, T4-2** — one-line config edits with disproportionate payoff.
6. **T3-1** — converts from "slow" to "silently broken" at ~1.1x current data.
