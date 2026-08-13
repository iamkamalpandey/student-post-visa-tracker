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

### T0-7 · Jobs and the audit writer read through RLS with no tenant GUC — zero rows in production, reported as success — **FIXED**

**Found while fixing T1-6. This is the largest defect in the register and it is
invisible in every environment we have run so far.**

The final RLS policy on every tenant-scoped table is

```sql
USING (tenant_id = app_current_tenant())
```

with no `OR app_current_tenant() IS NULL` branch — `20991231235983_rls_remove_escape_hatch`
stripped it and `20991231236005_rls_reclose_escape_hatch` re-closed the three
migrations that had re-opened it. `app_current_tenant()` is
`NULLIF(current_setting('app.tenant_id', true), '')::uuid`, so on a connection
with the GUC unset it is NULL and **every row fails the policy**.

`shared/tenantTx.ts` says so in its own header: *"service functions that reach
for the raw `prisma` singleton bypass the extension, so their queries see zero
rows when RLS is enforced."* The reclose migration says it too: *"A connection
that forgets the GUC now sees zero rows. That fails safe and is loudly
debuggable."* It fails safe. It is **not** loud.

Six jobs run their reads on the bare `prisma` singleton with no GUC anywhere:

| Job | What silently stops | Table |
|---|---|---|
| `billingDaily` | the **entire receivables pipeline** — invoicing, DUE, OVERDUE, late fees, plan completion | `fee_installments`, `fee_plans`, `fee_adjustments`, `tenants` |
| `reminderDispatcher` | every reminder send (writes are correctly scoped; the read that *finds* them is not) | `reminders` |
| `dsarSlaWatch` | DSAR SLA breach detection | `dsar_requests` |
| `commsCleanup` | comms retention | `comms_messages` |
| `idempotencyCleanup` | the idempotency table is never pruned and grows forever | `idempotency_records` |
| `retentionErasure` | document retention never executes | `documents` |

`billingDaily` is the clearest proof. Its first statement per tenant is

```ts
const tenant = await prisma.tenant.findFirst({ where: { id: tenantId, is_active: true } });
if (!tenant || !tenant.billing_enabled) return { …all zeros… };
```

The `tenants` policy is `id = app_current_tenant()`, so in production that
`findFirst` returns null for **every** tenant and the job returns all-zero
counters through its normal success path. No error, no throw, no alert — a
green cron run that did nothing. The business would see zero receivables and no
dunning, exactly as if no student owed anything.

**Why no environment has caught it.** RLS does not apply to superusers or
BYPASSRLS roles. Dev and CI run a single-role database — `config/db.ts` even
logs *"OK for a single-role dev DB"* on that path — so every job works
perfectly right up until `DATABASE_URL` points at the de-privileged `spv_app`
role, which is step 3 of the launch runbook. **The act of correctly securing
the database is what breaks the billing engine.**

The `billingDaily` comment claiming *"every query below explicitly filters
`tenant_id = tenantId`, so RLS only ever served as belt-and-braces here"* was
true when written — the escape hatch still existed. It has been false since
`…235983`.

**It reaches past the jobs.** `shared/audit.ts` writes **every** tenant-scoped
audit row — from request paths too — on the top-level client, deliberately, so
an audit row survives a caller's rollback. That client has no GUC, so the insert
fails the `WITH CHECK`, and `writeAudit` swallows its own errors by design. The
tamper-evident chain this product sells as forensic integrity would have
recorded nothing but system rows.

**And past the jobs entirely.** The same class runs through request-path code,
where it is just as silent. Everything below was verified by hand and converted:

| Surface | What silently broke |
|---|---|
| `middlewares/auth.ts` | the ownership gates — `assertStudentOwnership`, `requireLeadOwnership` and 18 child resolvers. Reads returned null, which the call sites treat as "not authorised": **fails closed**, no leak, but every COUNSELLOR 403'd out of every child resource. ADMIN short-circuits before the lookup, so admin-only testing shows the app working. |
| `middlewares/auth.ts` (`bumpIdleStamp`) | `last_used_at` never advanced, so every active session looked idle and users were signed out mid-work |
| `middlewares/requireMfa.ts` | answered "Invalid session" for everyone, locking admins out of exactly the routes MFA protects |
| `users.service.ts` | every method but `list()` — user administration did not work at all |
| `mfa.service.ts` | MFA enrolment, verify, disable and recovery all failed |
| `exports.service.ts` | counts returned 0 and the row stream yielded nothing: empty files, jobs stuck RUNNING |
| `imports.service.ts` | reads empty, writes rejected — bulk import did not work |
| `billing/middleware.ts` | `billing_enabled` read false and was then **cached**, 403ing the billing surface for the TTL |
| `dsar/controller.ts` | every completed DSAR export answered 404 |
| `interview-prep/controller.ts` | public token routes: empty question sets, valid links reporting "Invalid access token" |
| `comms/webhooks.routes.ts` | bounce/complaint suppression never happened — invisible until sender reputation drops |
| `comms/unsubscribe.routes.ts` | unsubscribes did nothing, hidden behind the anti-enumeration "silently succeed" branch |

**Fixed.** Cross-tenant discovery reads (which tenants exist, which have overdue
work, which tenant owns this job) go through `prismaAdmin` and are greppable as
deliberate; everything per-tenant runs inside `withTenantTx` — the pattern
`commsDispatcher`, `commsDigest` and `v2Ingest` already used, and the one the
reclose migration prescribes. Auth-domain primitives keyed by the session's own
user id (MFA, the idle stamp, the MFA gate) use the `adminDb` idiom
`auth.service.ts` already established, since they run before any tenant context
exists.

One design point worth keeping: in `users.service.ts` the old fallback for a
missing client was the bare singleton, so a caller who forgot to pass `db` was
silently wrong. The new `scoped()` helper falls back to `withTenantTx` instead —
forgetting to thread `req.db` now costs one extra transaction rather than an
empty result set. **A default that is merely slower beats a default that is
quietly incorrect.** I got this wrong once mid-fix: the controller's actor-MFA
lookup initially fell back to `null`, which reads as "actor has no MFA" and
turned a defence-in-depth check into a hard block on every role change. An
existing test caught it. `audit.ts` routes tenant rows through `withTenantTx`, which is still
an independent transaction so the survives-a-rollback property is preserved
exactly; system rows keep the plain path and land via the `tenant_id IS NULL`
branch. That also makes the DB trigger *correct* rather than merely permitted:
`audit_logs_hash_chain()` chains per tenant and runs as the invoker, so it needs
to see that tenant's rows to find the true chain head.

`tests/rls-guc-source-guard.spec.ts` is the regression net — it fails CI when a
job or a converted request-path file touches a tenant-scoped table through the
bare singleton, naming the file, the delegate, and the consequence, and needs no
database so it runs everywhere. Its allowlist names the exact delegates each
infrastructure job may use, so growing a new one has to be argued for rather
than waved through.

**Closure verified**, not assumed: `grep -rP "(?<![A-Za-z])prisma\.[a-zA-Z]+\."
src` returns nothing outside `config/db.ts`, where the client is defined. Every
remaining database access in the backend now goes through `req.db`,
`withTenantTx`, or an explicitly-named `prismaAdmin`/`adminDb` call.

Two files were checked and deliberately left alone: `jobs/service.ts` and
`comms/controller.ts` touch only `job_runs`, which has no tenant dimension.

**Why nothing caught this, which is the part worth keeping:**
`rls-enforcement.integration.spec.ts` proves tenant A cannot read tenant B.
Nothing proved the app can still read its **own** rows once RLS is real. Both
halves matter and only one was tested.

**CONFIRMED IN PRODUCTION (2026-08-13).** This was not theoretical. Queried the
live `spvt-db` directly:

- The runtime role is `spv_app` with `rolsuper = f, rolbypassrls = f` — RLS
  genuinely applies, so launch runbook step 3 is already satisfied and T0-7 was
  live.
- `audit_logs` holds **3,528 rows, every single one `tenant_id IS NULL`**. Zero
  tenant-scoped rows, ever.

That is the exact predicted signature. The policy is
`tenant_id = app_current_tenant() OR tenant_id IS NULL`, so on the GUC-less
client the system rows land via the NULL branch while every tenant-scoped write
fails the `WITH CHECK` and is swallowed by `writeAudit`'s catch. **The live
system has been running with a completely empty tenant audit trail** — the
feature sold as forensic integrity — and nothing anywhere reported it.

Static analysis predicted it; production data confirms it.

### T0-8 · The audit chain calls `digest()` from pgcrypto, which no migration ever installed — **FIXED**

**Found by standing a real de-privileged Postgres up and running the actual code
against it** — something this repo had never done.

> **Scope correction, checked against production on 2026-08-13.** `pgcrypto` was
> **already installed** in the live database (`pg_extension` shows 1.3, and
> `audit.chain.verify` — which calls `digest()` — has succeeded daily since at
> least Aug 9, before this migration existed). So this was **latent here, not an
> active outage**: something installed the extension at some point, and the
> audit chain has been working in this particular database.
>
> The defect is still real and still worth fixing: on a **virgin** database the
> extension is absent, which is exactly what a fresh environment is — a restore
> into a new instance, a second region, a self-hosted customer, disaster
> recovery. I proved it on a virgin PostgreSQL 18.3, where the whole migration
> chain applied cleanly and the first audit insert then failed. The migration
> turns "works because this database happens to have pgcrypto" into a guarantee.
>
> I originally wrote this up as though the production audit trail was dead. It
> was not. The correct claim is narrower and I should have checked before making
> the broader one.

`audit_logs_hash_chain()` and `audit_logs_verify()` hash every row with
`encode(digest(payload,'sha256'),'hex')`. `digest()` is not built in; it comes
from **pgcrypto**. Six call sites across three migrations, and not one of them
runs `CREATE EXTENSION pgcrypto`. The only extension the chain creates is
`pg_trgm`, for search.

Two things kept it invisible, and they compound:

1. **PL/pgSQL bodies are not resolved at CREATE time, only at EXECUTE time.**
   The whole migration chain applies to a virgin database and reports success.
   The failure waits for the first `INSERT` into `audit_logs`, which answers
   `42883: function digest(text, unknown) does not exist`.
2. **`writeAudit` catches its own errors by design** — correctly, so an audit
   failure can never take down the business operation that triggered it. But
   with (1), the tamper-evident audit trail is simply empty and nothing says so.

Every unit test mocks Prisma, so none could see it.

**Correction, from checking production directly (2026-08-13):** pgcrypto *is*
already installed on the live `spvt-db` (`pg_trgm`, `pgcrypto`, `plpgsql`), so
T0-8 was **not** biting production — someone installed it out-of-band at some
point. I originally wrote that the audit trail "would have recorded nothing"
because of this; in production the cause was T0-7, not T0-8.

T0-8 remains a genuine P0, but a **latent** one: it breaks any database built
from the migrations alone — CI, a new environment, and above all **the restore
drill in launch step 6**. A restore that cannot write an audit row is not a
usable recovery, and that is precisely when nobody is in a position to debug it.

Fixed by `20991231236008_pgcrypto_for_audit_chain`. Postgres 11+ does have a
built-in `sha256(bytea)`, but switching to it changes how every `entry_hash` is
computed, and a subtly wrong text→bytea encoding would silently invalidate
existing chains rather than fail loudly. Installing the extension the code
already expects changes no hash, is idempotent, is on DigitalOcean's supported
list, and the PRE_DEPLOY job runs as the owner. If the role ever cannot create
it, the migration fails at deploy and the deployment aborts — the right failure.

`tests/migration-extension-deps.spec.ts` is the guard: it scans the migrations
for calls to functions that only exist inside an extension and requires that
extension to be created. No database needed.

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

### T1-4 · Refund mints a second credit for the same cash — **FIXED**
`src/modules/billing/payment.service.ts`, `credit.service.ts`

`completeRefund` never retired the StudentCredit the payment minted (compare
`voidPayment`, which does). An overpayment creates Credit A; the refund throws
with guidance to pass `credit_carryforward=true`; following that instruction
mints Credit B. Net cash movement zero, outstanding credit liability
**doubled**, both spendable against real installments.

Fixed with `retireCreditsForRefund`, called **before** the allocation unwind.
Retiring first is not just convenient — the credit is the least-committed money
the payment created, so refunding an overpayment should consume it rather than
unwind an installment that is legitimately settled. With that in place,
`surplus` finally means what its error says: the refund exceeded the payment's
whole gross, not merely its allocated part, so the carryforward escape is left
for genuine goodwill refunds.

Partial retirement uses reverse-and-re-post rather than editing the row —
`reversed_at` exists precisely for retirement-without-deletion and
`sum(applications) == consumed_minor` is an invariant — so a credit refunded in
part is reversed in full and the residual re-posted. A credit already spent on
other installments refuses with a 409, matching `reverseCreditsForSource`:
refunding it as cash while it also settles an installment spends it twice.

The audit entry now records which credits a refund extinguished; without it the
credit vanished from the student's balance with nothing linking it to the cause.

`tests/billing-payment-actions.spec.ts` · 5 new tests.

### T1-5 · Reversal restores a balance onto a WAIVED installment — **FIXED**
`src/modules/billing/payment.service.ts`, `fsm-def.ts`

Status was only rewritten when currently PAID or PARTIAL, so a WAIVED row kept
WAIVED while regaining a live balance. The DB CHECK passes. That balance was
then invisible to `getOutstanding` and the dashboard but *visible* to
`outstandingByAge` — two finance screens disagreeing about one row, an agency
never chasing money it was genuinely owed, and no API path able to repair it
because the FSM had no outbound WAIVED edge.

The arithmetic was never wrong. A waiver forgives the **remainder**: it writes a
negative adjustment lowering `net_minor` to what was already paid, so
`newBalance = net_minor - newPaid` correctly becomes positive when the payment
behind it is reversed. Only the status lied. WAIVED now joins PAID/PARTIAL in
both reversal loops, and `fsm-def.ts` gains the WAIVED → PARTIAL / INVOICED /
REFUNDED edges — which its own comment already claimed existed ("PAID + WAIVED
are terminal *unless* a refund reverses them — modelled as explicit transitions
below"). The waiver itself is untouched: `net_minor` keeps the forgiven
reduction, so the student owes the 400 they never really paid, not the original
1,000.

### T1-5b · A partial waiver marks an installment WAIVED while money is still owed — **FIXED**
`src/modules/billing/payment.service.ts` · **Found while fixing T1-5**, and it
reaches the same corrupt row with no reversal involved. A WAIVER is capped at
the balance but may be *smaller* than it, and the status flip was
unconditional — so forgiving 100 of a 600 balance stamped the row WAIVED with
500 still owed. That is exactly the "WAIVED row showing money owed" state the
guard at the top of `applyAdjustment` was written to prevent, arriving through a
different door, and the comment beneath the cap asserted the opposite ("WAIVER
zeros the balance via the WAIVED status transition further down" — nothing
zeroed it).

A partial waiver is a legitimate act, so the fix is not to forbid it: the
negative adjustment already records the forgiveness in `net_minor`, and the
remainder stays collectable under the row's existing status. WAIVED is now
reached only when the waiver actually clears the balance.

`tests/billing-payment-actions.spec.ts` · 4 new tests across T1-5 and T1-5b.

### T1-6 · Late-fee recompute is an unlocked read-modify-write — **FIXED**
`src/jobs/billingDaily.ts`

Four statements, no transaction, no version predicate — unlike `applyAdjustment`
which holds `FOR UPDATE` throughout. A payment landing mid-sequence yields a
**PAID installment carrying a balance**, excluded from every collection path and
never rescanned. Crashing mid-sequence orphans the adjustment permanently,
because the same-day idempotency guard then skips the recompute forever.

Fixed alongside T0-7, which required the transaction anyway. The recompute now
re-reads the installment `FOR UPDATE` and computes the new balance from the
**locked** `paid_minor`, so it cannot be written from a stale snapshot.

Two further races the same lock closes, both consequences of a scan capped at
5,000 rows: the row's status is re-checked (it may have been paid, waived or
cancelled since the scan — charging a late fee on money already received is its
own customer-facing error), and the same-day idempotency guard is re-checked
under the lock rather than only from the scan's snapshot, since the advisory job
lock is session-scoped and Prisma does not pin connections (T0-6).

`tests/billing-late-fee-lock.spec.ts` · 6 tests.

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

### T1-9 · Idempotency recorded FAILED for writes that committed — **FIXED**
`src/shared/idempotency.ts`

The SUCCESS write sat *inside* the same `try` as the operation, so a transient
error while **recording** a committed payment landed in the same catch as an
error thrown **by** the payment — and the row was stamped FAILED. The client
retries and is replayed the failure; the operator re-enters the payment with a
fresh key — **a second payment**, taken by the mechanism whose mandatory
Idempotency-Key exists to prevent exactly this.

Fixed by splitting the two into separate try blocks, because they are
epistemically different states: `run()` throwing means the operation reported
failure (record FAILED, unchanged); `run()` returning and the persist throwing
means the operation **definitely succeeded**, so the only honest outcomes are
success to the caller and *unknown* in the cache. The row is left PENDING —
which already means "never auto-rerun, 409 until an operator reconciles" — and
the caller still receives its success, since telling it otherwise is the defect.

Two adjacent defects closed in the same path:
- A failure to persist FAILED used to replace the original error, so the caller
  saw a DB message instead of why the operation failed. The original now
  always propagates.
- `admin/idempotency.routes.ts` lets an operator sweep PENDING → FAILED. That
  now has a stated precondition: since a PENDING row can mean "succeeded but
  unwritten", sweeping the wrong one re-creates the same lie by hand and turns
  one payment into two. Its stale "older than 30 minutes" claim (the constant is
  5 minutes) and `idempotency.ts`'s advice to "delete the orphan row" (the admin
  API deliberately exposes no delete) were both corrected.

`tests/idempotency-record.spec.ts` · 3 new tests. The two pre-existing tests
asserting FAILED-on-throw still pass unchanged — that policy was deliberate and
was not touched here.

**Not changed, deliberately:** a genuine 5xx from `run()` is still cached and
replayed for 24h. If the operation was non-atomic and partially applied, that
replay is as misleading as the bug fixed above. Narrowing the FAILED cache to
deterministic 4xx would address it, but it reverses a documented May-2026 audit
decision and needs its own sign-off rather than riding along here. Logged as
T1-13.

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

### T1-13 · A cached 5xx is replayed as a settled failure — **OPEN, needs sign-off**
`src/shared/idempotency.ts` · Raised while fixing T1-9. `withIdempotency` caches
and replays a FAILED outcome for 24h regardless of the error class. For a
deterministic 4xx that is correct and useful. For a 5xx it asserts a certainty
the server does not have: if `run()` was not atomic and partially applied before
throwing, the replay tells the client "this failed" about work that partly
happened, and the operator's re-entry under a fresh key duplicates it — the same
shape as T1-9, reached by a different route.

Every current money-mover wraps `run()` in a transaction, so a throw means a
rollback and the replay is honest today. The exposure is that `withIdempotency`
is generic and cannot verify that property of its callers.

Options: (a) cache FAILED only for 4xx and leave 5xx PENDING — safest, but
reverses the documented May-2026 audit decision and makes transient 5xx errors
need operator action; (b) let callers declare atomicity and branch on it;
(c) accept and document. **Product/ops call, not a unilateral fix** — the cost
lands on operators, not on the code.

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

> ### ⚠ `.do/app.yaml` IS NOT THE SOURCE OF TRUTH — read before trusting T4-1/T4-2
>
> Verified against the running app on 2026-08-13: the live App Platform spec is
> managed in the DigitalOcean console and **does not track the repo file**. The
> two differ today:
>
> | Setting | Repo `.do/app.yaml` | **Live spec** |
> |---|---|---|
> | backend `health_check.http_path` | `/api/v1/health/readyz` | **`/api/v1/health/livez`** |
> | `REDIS_URL` | removed | **`redis://localhost:6379`** |
>
> So T4-1 and T4-2 are fixed **in the repo and inert in production**. I marked
> them FIXED on the strength of the committed file without confirming the change
> reached the running system, and that was wrong — editing a config file is not
> the same as changing a deployment.
>
> Live consequences, right now:
> - The platform still promotes on `/livez`, which returns 200 unconditionally.
>   The readiness gate built for T4-4 runs and passes, but **the platform is not
>   using it as the promotion gate**, so a deploy with a broken `DATABASE_URL`
>   would still be promoted healthy.
> - Rate limiting runs per-process while the config claims Redis, and `redis_up`
>   sits at 0, so an alert on that gauge would page continuously.
>
> Both need an edit to the **live spec**, which is a production configuration
> change and therefore an operator decision, not something to apply unilaterally.

### T4-1 · Health check probed an endpoint that checks nothing — **FIXED IN REPO, NOT LIVE**
Moved to `/readyz` in `.do/app.yaml`, after confirming `/readyz` 503s only on the
DB probe so an absent Redis cannot turn it into a deploy blocker. Also stopped
`/readyz` echoing the driver error, which leaked DB host/port/role on a route
that is unauthenticated and is now the public platform probe. **That last part
did ship** — it is application code. The health-check path did not: see the
warning above.

### T4-1-ORIGINAL · (superseded)
`.do/app.yaml` → `/livez`, which returns `{status:'ok'}` unconditionally.
`/readyz` probes the DB and nothing uses it. A deploy with a bad `DATABASE_URL`
is promoted as healthy while every request 500s.

### T4-2 · `REDIS_URL` dummy degraded every Redis-backed control — **PARTLY FIXED; DUMMY STILL LIVE**
The env-schema half shipped (application code): `REDIS_URL` is genuinely
optional now, which is what unblocked CI. The **dummy value is still set in the
live spec** (`redis://localhost:6379`), so every consequence below is still
true in production — confirmed by `/readyz` reporting `redis: unavailable`.
See the warning at the top of this tier.

The placeholder was not inert:
`server.ts` gates its multi-replica MFA-replay warning on
`!process.env.REDIS_URL`, so a fake value permanently silenced the one warning
that says scaling past one instance breaks TOTP anti-replay and splits every
rate limiter into per-process buckets. It also pinned `redis_up` at 0 forever.

**Bonus finding:** `backend-ci.yml` never set `REDIS_URL`, and the env schema
required it. CI has no `.env` (local runs get it via `tests/setup.ts`), so
backend env validation would have `process.exit(1)` there — a latent CI blocker
that this change also removes. Worth confirming on the next CI run.

### T4-2-ORIGINAL · (superseded)
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

### T4-4 · RLS role assertion fails open, after the socket is already accepting — **FIXED**
`src/config/db.ts`, `src/modules/health/health.routes.ts` · If the boot probe
threw it was skipped entirely, and it ran inside the `listen` callback. A deploy
coinciding with a failover served indefinitely with the check never performed —
and if `DATABASE_URL` pointed at the admin role, RLS would be off for the whole
application with no other symptom.

Fixed by tracking whether the role has been *positively proven* RLS-enforced
(`isRlsRoleVerified()`) and gating `/readyz` on it in production. Crash-looping
on a transient blip would be the wrong trade; readiness is the right lever, and
it only became usable once T4-1 pointed the platform health check at `/readyz`.
An unverified instance never receives traffic and the previous version keeps
serving. Non-production marks itself verified on a privileged role so a
single-role dev DB still comes ready — the production branch has already
`process.exit(1)`d by that point, so it cannot mask a real misconfiguration.

`tests/readyz-rls-gate.spec.ts` · 5 tests, including that the response
distinguishes "DB down" from "DB up but isolation unproven" (different
incidents, different responses) and that it never echoes driver detail.

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

### T6-1 · `POST /auth/logout` never revoked the access token — **FIXED**
`src/modules/auth/auth.routes.ts:44` · The chain is `originGuard, logout` with no
`authenticate`, so `req.user` is always undefined, so the access-token JTI is
never written. The denylist block in `auth.service.ts:607` is the only writer in
the codebase and it never executes — **the entire denylist is dead code**. A
stolen token keeps full API access for the remaining TTL after the victim clicks
"Log out" and sees success. Compounding: `middlewares/auth.ts:101` reads the
denylist through the un-scoped `prisma` client *before* `tenantContext` sets the
GUC, so even a real row returns null under RLS — **fail-open**.

> Fixed on both halves, because either alone leaves it inert.
> **Write:** the route deliberately omits `authenticate` so an expired token can
> still clear its cookie, which meant `req.user` was always undefined and the
> JTI always null. The controller now verifies the bearer itself — a valid token
> yields a JTI to revoke, anything else falls through to the same
> cookie-clearing behaviour, so logout still cannot fail.
> **Read:** `isTokenDenylisted` used the tenant-scoped client while running
> *before* `tenantContext` sets the GUC. Under RLS the row was FILTERED, so
> `findUnique` returned null without throwing — which the call site's
> fail-closed catch could never see, because filtering is not an exception. Now
> uses `prismaAdmin`, matching `getSessionsValidFromMs` in the same file.
> 7 tests; there had been none on this path at all.

### T6-2 · The list endpoint bypasses `requireStudentOwnership` — **OPEN, panel convened**
Three expert lenses (security, agency-domain, codebase archaeology) all
concluded: scope it. Archaeology verdict **INTENDED SCOPED** — 16 of 19
student-linked read surfaces already scope for non-ADMIN, the docs promise it,
and `comms/controller.ts` fixed the identical defect with the reasoning written
out. Blocked on one product decision (rollout flag default), and on the
prerequisites below, both now done:
- unassigned-student lockout — **FIXED** (see T6-2a)
- `list()` and the export now share one predicate — **FIXED**

### T6-2a · Counsellors were locked out of students they created — **FIXED**
`assertStudentOwnership` compared `assigned_to_id !== sub`, and `null !== uuid`
is true, so every UNASSIGNED student 403'd for non-admins. Unassigned is the
normal arrival state: `create()` defaults it to null and quick-create never
sends one. A counsellor pressed "Add student", got a row, and was refused on
opening it — and could not repair it, since only ADMIN may reassign. The
realistic response is to create it again, so the symptom was duplicate records
rather than a reported error. `requireLeadOwnership` in the same file already
had the carve-out. 7 tests.

### T6-2b · `list()` did not use the shared predicate builder — **FIXED**
`buildStudentListWhere` was extracted for the export and the export pointed at
it, but `list()` kept an inline copy — while the builder's docstring promised
"the list and the export cannot drift apart again" and `exports.service.ts`
called it "the exact builder /students uses". Neither was true, and they had
begun to diverge. Consolidating also gives caseload scoping one place to land
instead of two kept in step by hand.

### T6-2-ORIGINAL · (superseded by T6-2 above)
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
