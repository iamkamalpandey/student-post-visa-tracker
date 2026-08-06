# Migration recovery runbook — failed `migrate deploy` (P3009)

## Why this document exists

Migration `20991231235995_rls_institution_program_children` shipped in `b0daaa5`
(2026-08-03) with a policy predicate referencing `program_fees.program_id` — a
column that has never existed in any migration. `program_fees` links to a
program only indirectly, through `program_intake_id`.

Postgres aborts that statement with `42703 undefined_column`, so the migration
could never apply anywhere. Because `.do/app.yaml` runs
`prisma migrate deploy` as a **PRE_DEPLOY job**, and a failed PRE_DEPLOY job
aborts the deployment, no commit after `b0daaa5` could have reached production
through the normal pipeline.

It went unnoticed for 26 commits because `backend-ci` was itself broken at the
`Setup pnpm` step (fixed in `90f5fc1`), so the CI step that runs the real
migrations had never once executed.

Fixed in this change. The chain now replays cleanly from an empty database —
verified by applying all 55 migrations to a virgin Postgres 16.

## Symptom

```
Error: P3009
migrate found failed migrations in the target database, new migrations
will not be applied. Read more about how to resolve migration issues in a
production database: https://pris.ly/d/migrate-resolve
```

Prisma records an attempted migration with `finished_at = NULL`. It refuses to
proceed until that row is resolved, so the failure is **sticky**: every later
deploy fails with P3009 even after the underlying SQL is fixed.

## Recovery

Prisma wraps each migration in a transaction on Postgres, so the aborted
migration left no partial DDL behind. Only the bookkeeping row needs clearing.

Run against the database with the **owner** role (`DATABASE_MIGRATE_URL`, i.e.
`spv` — not the runtime `spv_app`, which cannot run DDL):

1. Confirm what is actually stuck, rather than assuming:

```bash
psql "$DATABASE_MIGRATE_URL" -c "SELECT migration_name, started_at, finished_at, rolled_back_at FROM _prisma_migrations WHERE finished_at IS NULL ORDER BY started_at;"
```

2. Mark the failed migration rolled back. It applied nothing, so this is
   bookkeeping only:

```bash
pnpm --filter backend exec prisma migrate resolve --rolled-back 20991231235995_rls_institution_program_children
```

3. Apply the corrected chain:

```bash
pnpm --filter backend prisma:migrate:deploy
```

The corrected `…235995` is then applied fresh, followed by the ten migrations
stranded behind it:

| Stranded migration | What it carries |
|---|---|
| `…235996_audit_chain_for_update` | audit hash-chain `FOR UPDATE` locking |
| `…235997_sessions_valid_from` | session-wide access-token revocation |
| `…235998_commission_invoice_no_uq` | commission invoice-number uniqueness |
| `…235999_finance_item_partial_paid_and_version` | partial payment + optimistic version |
| `…236000_crm_lead_phone_not_unique` | lead phone uniqueness relaxation |
| `…236001_crm_lead_fee_seed_course_key` | lead-fee seed course key |
| `…236002_perf_list_pagination_indexes` | list pagination indexes |
| `…236003_student_credit_ledger` | student credit ledger |
| `…236004_money_nonneg_checks` | non-negative money CHECK constraints |
| `…236005_rls_reclose_escape_hatch` | re-closes the RLS escape hatch on 21 tables |

## Checking whether a database is affected

`program_fees` carries no `tenant_id` of its own, so RLS is the only tenant
isolation it can have. Absence of the policy is the reliable tell:

```bash
psql "$DATABASE_MIGRATE_URL" -c "SELECT tablename, policyname FROM pg_policies WHERE tablename = 'program_fees';"
```

No row means the migration never applied and `program_fees` is readable across
tenants by any code path that does not filter through the parent program.

## Why it cannot recur

`backend-ci` now runs `prisma migrate deploy` against a real Postgres 16 service
on every push and pull request touching `apps/backend/**`, `packages/**`, or the
workflow itself. A migration that cannot apply now fails the build instead of
waiting to fail a deploy.
