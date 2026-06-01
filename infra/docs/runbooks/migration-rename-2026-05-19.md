# Migration Rename — 2026-05-19

## Why

A CTO sign-off audit found two pairs of Prisma migrations sharing the same
14-digit numeric prefix:

| Old prefix      | Old directories                                                                           |
| --------------- | ----------------------------------------------------------------------------------------- |
| `20991231235980` | `20991231235980_mfa_recovery_hashes`, `20991231235980_stripe_payment_columns`             |
| `20991231235982` | `20991231235982_audit_anchor_delta_watermark`, `20991231235982_perf_indexes_v2`           |

Prisma's `_prisma_migrations` table is keyed by the full directory name, so
there is no PK collision — but within a same-prefix pair the apply order on
a fresh database is determined by filesystem sort. This differs subtly
between OSes and FS implementations, and (more importantly) means a fresh
prod deploy could apply the pair in the opposite order from the order in
which they were originally applied in dev. For these specific pairs the
inter-migration ordering happens to be benign today, but the audit flagged
this as a footgun and required disambiguation before sign-off.

## What changed

Each colliding directory was renamed with a single-letter suffix appended
to the numeric prefix. The letter was assigned by the existing alphabetical
sort of the directory-name suffix (so dev DBs that have already applied
these migrations in alphabetical order are not retroactively reordered):

| Old directory                                  | New directory                                   |
| ---------------------------------------------- | ----------------------------------------------- |
| `20991231235980_mfa_recovery_hashes`            | `20991231235980a_mfa_recovery_hashes`            |
| `20991231235980_stripe_payment_columns`         | `20991231235980b_stripe_payment_columns`         |
| `20991231235982_audit_anchor_delta_watermark`   | `20991231235982a_audit_anchor_delta_watermark`   |
| `20991231235982_perf_indexes_v2`                | `20991231235982b_perf_indexes_v2`                |

The migration SQL inside each directory is byte-identical to the
pre-rename version other than (a) a `RENAMED 2026-05-19` provenance header
appended to the top of each file, and (b) the `prisma migrate resolve`
self-reference inside `20991231235982b_perf_indexes_v2/migration.sql`
being updated to use the new name.

The code comment in `apps/backend/src/modules/auth/mfa.service.ts` that
referenced the old migration name was also updated.

## Operator action required (existing dev DBs only)

Fresh deployments (CI ephemeral DBs, fresh prod) need nothing — Prisma
will simply apply the four migrations under their new directory names.

Engineers with a long-lived local dev DB (or anyone with a staging/preview
DB that has already applied these four migrations under the old names)
must rename the rows in `_prisma_migrations` so Prisma does not try to
re-apply them. Run all four UPDATEs in a single transaction against the
target DB:

```sql
BEGIN;

UPDATE _prisma_migrations
   SET migration_name = '20991231235980a_mfa_recovery_hashes'
 WHERE migration_name = '20991231235980_mfa_recovery_hashes';

UPDATE _prisma_migrations
   SET migration_name = '20991231235980b_stripe_payment_columns'
 WHERE migration_name = '20991231235980_stripe_payment_columns';

UPDATE _prisma_migrations
   SET migration_name = '20991231235982a_audit_anchor_delta_watermark'
 WHERE migration_name = '20991231235982_audit_anchor_delta_watermark';

UPDATE _prisma_migrations
   SET migration_name = '20991231235982b_perf_indexes_v2'
 WHERE migration_name = '20991231235982_perf_indexes_v2';

COMMIT;
```

Each statement should report `UPDATE 1`. If any reports `UPDATE 0` the
target DB never applied that migration under its old name and no action
is needed for that row — proceed normally with `prisma migrate deploy`
(or `prisma migrate dev`) and it will be applied fresh under the new
name.

## Verification

After the UPDATEs, run:

```bash
pnpm --filter backend prisma migrate status
```

It must report `Database schema is up to date!`. If it instead reports
that the four renamed migrations are pending, you have a partially-
updated `_prisma_migrations` table — re-check the four `UPDATE` row
counts above.

## Rollback

If something is wrong and the rename needs to be reverted, run the
inverse UPDATEs (swap WHERE and SET values in each of the four
statements above) and `git revert` the rename commit.
