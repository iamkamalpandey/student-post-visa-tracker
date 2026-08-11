# SPVT competitive battle card

**Purpose.** A well-resourced competitor with a mature product will do exactly
what we just did: read the repo, take a trial, and build a slide deck out of
what breaks. This document is the result of attacking our own product on their
behalf, so nothing on their slide is news to us.

**How to use it.** Section 1 is what they *would* have found and what we did
about it. Section 2 is where we are genuinely stronger and should push. Section
3 is what is still true and unfixed — say it plainly if asked, because being
caught concealing a known gap costs more than the gap.

Every claim below was verified against the code or a real Postgres 16 on
2026-08-12. Do not repeat a number from this document that you have not seen
re-verified — a claim that fails a live test in the room is worse than no claim.

---

## 1. Attacks that were live, and are now closed

### 1.1 "Their invoice shows a scholarship and then bills the full amount"

**This was their best slide, and it was true.** `scholarship_minor` was stored on
the fee plan and printed on both the text and PDF invoice renderers, but
`plan.service.ts` set `total_minor` to the raw sum of the schedule lines and
created every installment at full `gross_minor`. The discount was applied to
nothing. A student awarded 250,000 was invoiced a document that said
"Scholarship 250,000" and then billed them the entire undiscounted amount,
across every installment, with no error raised anywhere.

**Fixed.** The scholarship is now allocated across the schedule proportionally,
with a largest-remainder pass so the cuts sum to the award exactly and no
installment can be driven negative. `total_minor` stays gross (it is fed from
the enrolment's tuition), and the invariant
`sum(installments) == total_minor - scholarship_minor` is pinned by 14 tests,
including a property sweep over awkward splits. Both renderers now print the
deduction signed, followed by "Net Payable", so the document reconciles against
itself in front of the customer.

**If raised:** "That was real, it is fixed, and here is the test that proves the
arithmetic." Then show the invoice reconciling. Do not minimise it.

### 1.2 "Half their tables have pagination that does nothing"

Also true. `DataTable` rendered a fully styled pagination footer whenever the row
count exceeded the page size, reporting an accurate "1–25 of 340" — but the
handler was an optional call, and **26 of 31 tables passed no handler**. Clicking
next page did nothing. Row 26 was unreachable on those screens.

**Fixed.** The component now owns pagination when the caller does not: callers
that do server-side paging are unchanged, and callers that hand over the full row
set get real client-side paging with page clamping when a filter shrinks the
result. All 26 screens were repaired without touching a call site. Nine DOM tests
cover both modes, including the click-through that the old build could never
satisfy.

### 1.3 "A part payment makes the rest of the debt disappear"

`markFeePaid` refused a payment *larger* than the billed fee, but wrote
`status: 'PAID'` unconditionally. A lead billed 10,000 who paid 2,500 was booked
PAID. The 7,500 left the open-fee queries, dropped out of the receivables
rollup, had its chase reminders dismissed, and was never invoiced again.

**Fixed.** `CrmFeeStatus` gained `PARTIAL` (migration `…236006`), and the status
now follows the arithmetic. A part-paid fee stays open, stays in receivables,
keeps its reminders, carries its balance through lead→student conversion, and
records the outstanding amount in the audit trail. Eleven tests cover it,
including the guard against a "payment" that silently lowers what was already
recorded.

### 1.4 "There is no error tracking in production"

True, and worse than it looked. `config/sentry.ts` is a careful, complete
integration — PII scrubbing, tenant/user/request-id scoping on every event — but
it imports `@sentry/node` dynamically and swallows the failure with a single
WARN line. The package was **absent from the lockfile entirely**. Every
deployment ran with no error tracking while the code read as fully instrumented.

**Fixed.** `@sentry/node@10` is installed as a production dependency and a test
now fails the build if it is ever dropped again or if the API surface the
integration depends on disappears. `SENTRY_DSN` is already declared as a secret
in the deployment spec.

> **Action required before the pitch:** the DSN secret must actually be set in
> DigitalOcean. The SDK is installed and wired, but with no DSN it initialises
> to disabled. Do not claim live error tracking until you have seen an event
> arrive.

### 1.5 "They ship dead code in the billing engine"

The late-fee block — roughly eighty lines of correct, idempotent, capped
machinery — was gated on a policy object built by `parsePolicy(null)`. `enabled`
was therefore always false. It had never executed once, for any tenant, while
reading as a shipped feature. The comment above it blamed a `tenant.settings`
JSON column that **does not exist on the Tenant model in any migration**.

**Fixed.** The policy is now read per fee plan from `FeePlan.late_fee_policy`,
the field that actually exists. This is also the safe default: a plan with no
policy stays disabled, so nothing starts charging anyone as a side effect of the
fix. Malformed amounts in the JSON are rejected per-installment rather than
crashing the run.

### 1.6 "Their tenant isolation has holes" — and it did, in one place

We claim database-enforced multi-tenancy. Auditing the *live schema* rather than
the migration files found that `interview_attempts` and `interview_questions`
both carry a `tenant_id` and had **no row-level security at all** — and
`interview_attempts` stores `candidate_name` and `candidate_email`.

**Fixed** (migration `…236007`), with the tightened policy shape and FORCE, plus
a parent-join policy for `interview_answers`. More importantly, the fix is now
**structural**: the RLS integration suite gained three schema-wide invariants —
every table with a `tenant_id` has RLS, every such table FORCEs it (one
documented exception, below), and no policy anywhere reintroduces the
`app_current_tenant() IS NULL` escape hatch. A new tenant-owned table can no
longer ship unprotected.

### 1.7 "They advertise four languages and ship one"

`messages/ar.json` and `messages/hi.json` were verbatim English copies. `ne.json`
still is, and says so in its own metadata. The product offered a four-language
switcher over one language of content.

**Partly fixed, deliberately.** `ar` and `hi` are deleted; the supported set is
now `en` + `ne`. The language switcher remains unmounted **on purpose** — see
§3.1. Shipping a toggle that reloads the page and changes no text is a worse
demo moment than having no toggle, and machine-translating fee, visa and
contractual wording for Nepali agents is not acceptable on a money-handling
product.

### 1.8 "Their deployments have been broken for days"

Their technical evaluator would have found this in the commit history. A
migration referencing a column that has never existed (`program_fees.program_id`)
meant `prisma migrate deploy` aborted — and because that runs as a PRE_DEPLOY
job, **no commit after 2026-08-03 could reach production through the pipeline**.
CI had not caught it because CI itself had never run past its setup step.

**Fixed.** The migration chain now replays cleanly from an empty database (all
57 migrations verified against a virgin Postgres 16), CI applies the real
migrations against a real Postgres on every push, and the recovery procedure is
written up in [SPVT-MIGRATION-RECOVERY.md](SPVT-MIGRATION-RECOVERY.md).

> **Action required before the pitch:** production still needs the documented
> `migrate resolve --rolled-back` step before it can deploy again. Do a full
> deploy and smoke test well before any demo.

---

## 2. Where we are genuinely stronger — lead with these

These are not marketing claims; each is checkable in the room.

**Tenant isolation is enforced by Postgres, not by application code.**
100 tables carry a `tenant_isolation` policy and FORCE row-level security, so
even the table owner is bound. Zero policies contain the
`app_current_tenant() IS NULL` escape hatch. This is verified by an integration
test that runs as a deliberately `NOSUPERUSER NOBYPASSRLS` role and asserts that
fact *first*, so the suite cannot pass vacuously. Most competitors filter by
tenant in the ORM; a single missed `where` clause is then a cross-tenant leak.
For us it is zero rows.

*Ask them:* "What happens in your product if a developer forgets the tenant
filter in one query?" Our answer is "nothing — the database returns no rows."

**Money is integer minor units end to end, never floating point**, with
property-based invariant tests over remainder distribution, balance identity,
FIFO allocation, currency exponents (JPY has no minor units), and now
scholarship allocation. Cross-currency netting is refused rather than silently
summed.

**The audit log is tamper-evident at the database level.** A Postgres trigger
computes the authoritative hash chain — application code cannot forge it — and
the chain covers the forensic fields (actor email, IP, user-agent hashes), so a
database-level attacker cannot rewrite who did what from where without
detection. Verified against a real database across a hash-version boundary.

**PII is envelope-encrypted with rotatable keys.** Version-2 envelopes record
which key wrapped them, so rotating a key does not orphan existing ciphertext,
and there is a resumable re-wrap tool for post-compromise key destruction.

**Subject-access and erasure are implemented**, including the CRM record estate
that a naive implementation misses because it links by lead rather than student.

**Every migration is exercised on every push** against a real Postgres 16, not
`db push`. Broken migrations fail the build instead of failing a deploy.

---

## 3. Still true, still unfixed — say it plainly

Concealing these is the actual risk. Each has a defensible answer.

### 3.1 Nepali is not translated
`ne.json` is English placeholders. The i18n framework (next-intl, cookie-based
locale) is fully wired and the switcher component is written — it is simply not
mounted until the content is real.
**Answer:** "The framework is in place and Nepali is next. We won't machine-
translate fee and visa terminology for a product that moves your money — we'd
rather ship it right than ship it fast." Offer a date.

### 3.2 No tested disaster recovery
There is no backup or restore automation in the deployment spec and no restore
drill has been performed. Managed-database snapshots exist at the infrastructure
layer, but *untested backups are not backups*.
**Answer:** own it, and commit to a documented restore drill with a measured RPO
and RTO. If they claim theirs is better, ask when they last performed a restore
and what the measured RTO was — most cannot answer either.

### 3.3 No alerting or on-call path
Sentry is now installed, but nothing pages a human. Metrics are exposed; no
alert rules consume them.
**Answer:** Sentry lands this week, alert routing follows. Do not overstate it.

### 3.4 Four complete features still have no user interface
Saved views, notes, tags and student credits all have full, role-gated, audited
backends and no screens. Custom fields shipped recently and is the template for
the rest.
**Answer:** this is a sequencing choice, not missing capability, and it is why
the next release is short. Demo custom fields to prove the pattern.

### 3.5 One documented RLS exception
`audit_anchors` has RLS enabled but not FORCEd, because the nightly integrity
job writes an anchor for every tenant from one unscoped system connection.
Forcing it would silently kill tamper-evidence. The residual exposure is limited
to the owner role, which already holds schema privileges. This exception is
encoded in the test suite with its reason, so it is a decision rather than drift.

### 3.6 No formal certification
No SOC 2 or ISO 27001. If the buyer requires certification, we do not qualify
today.
**Answer:** describe the controls that are actually implemented and verifiable —
forced RLS, envelope encryption with key rotation, a tamper-evident audit chain,
subject-access and erasure, MFA, session-wide token revocation, breach-password
checks that fail closed. Certification attests to controls; we can demonstrate
the controls.

### 3.7 Coverage is measured but not gated, and there are no end-to-end tests in CI
1,361 backend tests and 86 frontend tests pass, and every migration runs in CI.
Coverage thresholds exist but do not yet block a merge, and the Playwright specs
have no CI job.

---

## 4. Questions to put to them

A pitch that only defends loses. These are where a post-visa product is usually
weakest, and where our design is deliberate.

1. **"Where does your student lifecycle end?"** Every readable competitor stops
   at visa granted or enrolled. Ours continues through arrival, compliance
   checks, graduation and the post-study work route.
2. **"How do you reconcile commission you claimed against commission you were
   actually paid?"** Most cannot, at all.
3. **"What happens to a commission when a student withdraws after you have been
   paid?"** Clawback is a first-class event here, not a manual edit.
4. **"Show me your tenant isolation at the database layer."** Not the ORM — the
   database.
5. **"When did you last restore from backup, and what was the measured RTO?"**
   Ask this only if §3.2 has been addressed, or it comes straight back.

---

## 5. Pre-pitch checklist

- [ ] Set `SENTRY_DSN` in DigitalOcean and confirm a test event arrives
- [ ] Run the `migrate resolve --rolled-back` recovery, deploy, and smoke test
- [ ] Create a fee plan with a scholarship and confirm the invoice reconciles
- [ ] Page through a long list on three different screens
- [ ] Record a part payment on a lead fee and confirm the balance stays owed
- [ ] Re-verify every number quoted from this document
