# Runbook: Database backup & restore (P0)

> **Last drill: 2026-05-19 (DRY-RUN, Docker engine unreachable) — see [`drill-logs/`](drill-logs/). A wet drill is still outstanding to close the P0 audit item; next due 2026-06-19.**

**Owner:** Platform on-call.
**Trigger (backup):** Continuous (PITR) + nightly cron (logical snapshot).
**Trigger (restore):** Confirmed data corruption, accidental destructive operation, regulator-requested rollback, or monthly drill.
**RTO:** ≤ 60 minutes. **RPO:** ≤ 5 minutes (managed Postgres with PITR) / ≤ 24 hours (self-hosted fallback).

This runbook supersedes `db-restore.md` for the backup *cadence + encryption* dimension; that file remains the operational PITR cheat-sheet for an active incident. Both must stay in sync.

---

## 1. Backup strategy

### Option A — Managed Postgres (recommended)

Use one of the providers listed in the README (`Neon`, `Supabase`, `AWS RDS`). All three give us:

- Continuous WAL archiving with point-in-time recovery to any second within the retention window.
- Server-side encryption at rest on the snapshot bucket (AES-256, provider-managed keys).
- Per-snapshot integrity checksums managed by the provider.

| Provider  | PITR window default | Where to extend it |
| --------- | ------------------- | ------------------ |
| Neon      | 7 days (free), 30 days (paid) | Project settings → History retention |
| AWS RDS   | 1 day (default), up to 35 days | `--backup-retention-period 30` on `modify-db-instance` |
| Supabase  | 7 days (Pro), 14 days (Team), 28 days (Enterprise) | Project → Settings → Database → PITR |

**Required production setting: PITR window ≥ 7 days, target 30 days.** This is the P0 ship-blocker the CTO audit flagged.

### Option B — Self-hosted Postgres (fallback)

Only choose this if regulatory data-residency forbids the managed providers above.

- Base backup: `pg_basebackup -D /var/lib/postgresql/basebackup -Ft -z -P -X stream` on a daily cron.
- Continuous WAL: `wal-g wal-push` (or `pgbackrest`) shipping every completed segment to `s3://$BACKUP_BUCKET/wal/`.
- The same `infra/scripts/backup-snapshot.sh` script writes the **logical** dump (`pg_dump -Fc`) — keep both physical + logical, they protect against different failure modes (physical handles PITR, logical handles "I need rows X out of one table without restoring the whole cluster").

---

## 2. Cadence & retention

| Artefact                 | Cadence                          | Where it runs                                      | Retention                                |
| ------------------------ | -------------------------------- | -------------------------------------------------- | ---------------------------------------- |
| WAL / PITR stream        | Continuous                       | Managed provider OR `wal-g` sidecar                | ≥ 7 days (target 30)                     |
| Logical snapshot (`-Fc`) | Daily @ 02:00 UTC                | `.github/workflows/db-backup.yml`                  | Daily ≥ 30 days                          |
| Weekly retention copy    | Sunday 02:30 UTC                 | S3 lifecycle rule (`copy → glacier-ir` at 30 days) | Weekly ≥ 3 months (13 weeks)             |
| Monthly retention copy   | 1st of month, 02:30 UTC          | S3 lifecycle rule (`copy → glacier-deep` at 90 d)  | Monthly ≥ 1 year (12 monthlies)          |
| Restore drill            | First Monday each month, business hours | Manual (this runbook)                       | Drill log retained 24 months             |

Bucket layout:

```
s3://$BACKUP_BUCKET/
  db/
    2026/05/19/svt-prod-20260519T020000Z.pgdump.age
  wal/
    000000010000001A000000F2.lz4   (wal-g, self-hosted only)
  drills/
    2026-05/drill-log-restore-2026-05-06.txt
```

Lifecycle rules (Terraform / S3 console — set these *before* writing the first backup so the retention horizon starts ticking from day one):

- `db/`: transition to `STANDARD_IA` after 30 days, `GLACIER_IR` after 90, expire daily-tagged objects after 31 days. Weekly + monthly tagged objects survive their retention.
- `wal/`: expire after `max(PITR_WINDOW_DAYS, 8)` to leave headroom for the most recent restore.

---

## 3. Encryption

### Managed provider

- Bucket SSE: enable `SSE-KMS` with a customer-managed key (CMK). Do **not** use `SSE-S3` — the keys live in the same account boundary as the bucket and don't satisfy SOC2 CC6.1.
- Snapshot SSE: provider-default for Neon / Supabase; for RDS set `--storage-encrypted` + `--kms-key-id` at instance creation (cannot be retro-fitted without a snapshot-restore-into-new-instance cycle).

### Self-hosted (and belt-and-braces for managed)

The `infra/scripts/backup-snapshot.sh` script pipes the dump through [`age`](https://age-encryption.org/) when `BACKUP_PUBKEY` is set:

```
pg_dump -Fc … | age -r age1xyz…publickey > svt-prod-….pgdump.age
```

The recipient key (`age1xyz…`) is checked into ops config; the matching identity (`AGE-SECRET-KEY-1…`) is sealed in the KMS-protected break-glass store and **must never be committed to git or stored alongside the backups**. Restore requires both `BACKUP_PUBKEY` (to verify recipient) and an operator-supplied `BACKUP_IDENTITY_FILE` (or env `BACKUP_AGE_IDENTITY`).

Two-person rule: rotating or re-issuing the `age` identity follows `kms-rotation.md` — one operator drafts the new key, a second approves before the bucket-side recipient is swapped.

---

## 4. Restore procedure

### A. Point-in-time restore — managed (RPO ≤ 5 min, RTO ≤ 1 h)

Use this when the requirement is "roll back to 14:32:08 UTC, drop nothing else". See `db-restore.md` for the per-provider commands; the short form:

```bash
# Neon
neonctl branches create --project-id "$NEON_PROJECT" \
  --name "restore-$(date +%Y%m%d%H%M)" \
  --parent-timestamp "2026-05-19T14:32:08Z"

# RDS
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier svt-prod \
  --target-db-instance-identifier svt-prod-restore-"$(date +%Y%m%d%H%M)" \
  --restore-time "2026-05-19T14:32:08Z"
```

Then update `DATABASE_URL` / `DATABASE_MIGRATE_URL` to point at the new branch / instance, run the smoke checklist (README §Smoke), and swap the production endpoint.

### B. Restore from logical snapshot — `pg_restore` (RPO ≤ 24 h, RTO ≤ 1 h)

Use this when:

- The provider PITR window has been exceeded.
- You need to restore into a *different* cluster (e.g. staging, drill, forensic copy).
- You want to restore a single schema and re-apply diffs.

```bash
# Fetch
SNAPSHOT=s3://$BACKUP_BUCKET/db/2026/05/19/svt-prod-20260519T020000Z.pgdump.age

infra/scripts/restore-from-snapshot.sh "$SNAPSHOT"
# Behind the scenes:
#   aws s3 cp "$SNAPSHOT" -            \
#     | age -d -i "$BACKUP_AGE_IDENTITY" \
#     | pg_restore -c -Fc --no-owner --no-acl -d "$DATABASE_URL"
```

After the restore completes, run the verifier:

```bash
DATABASE_URL=… pnpm --filter backend tsx ../../infra/scripts/verify-restore.ts
```

### Time-to-recover SLO

| Path                          | RPO    | RTO       |
| ----------------------------- | ------ | --------- |
| Managed PITR (Neon/RDS branch)| ≤ 5 m  | ≤ 30 m    |
| Logical snapshot restore      | ≤ 24 h | ≤ 1 h     |
| Self-hosted `wal-g` PITR      | ≤ 5 m  | ≤ 2 h     |

A drill that overshoots either column is a P1 (file an issue, update this runbook *before* closing it).

---

## 5. Monthly restore drill — checklist

Run on the **first Monday of each month** (calendar invite owned by Platform on-call). Drills are not optional; an untested backup is a hope, not a control.

```text
[ ] 0. Open a drill issue: title "Restore drill YYYY-MM"; attach this checklist.
[ ] 1. Provision an empty Postgres (Neon dev branch, ephemeral RDS, or
       throwaway local container — `docker compose up -d postgres` with a
       distinct DB name works).
[ ] 2. Identify the latest production snapshot in s3://$BACKUP_BUCKET/db/.
[ ] 3. Run infra/scripts/restore-from-snapshot.sh "<snapshot-url>" against the
       throwaway target (set DATABASE_URL + DATABASE_MIGRATE_URL to the throwaway).
[ ] 4. Confirm schema parity:
       pnpm --filter backend prisma migrate status
       (Expect: "Database schema is up to date!")
[ ] 5. Confirm row counts + audit chain:
       DATABASE_URL=… pnpm --filter backend tsx ../../infra/scripts/verify-restore.ts
       (Expect: exit 0; all critical tables non-zero; broken_count = 0 per tenant.)
[ ] 6. Capture stdout of steps 3–5; attach to the drill issue.
[ ] 7. Tear down the throwaway DB.
[ ] 8. File a follow-up issue for any anomaly (slow restore, missing rows,
       broken chain). Update this runbook to reflect what changed.
[ ] 9. Close the drill issue with a one-line summary in #ops-incidents.
```

If a drill **fails for any reason**:

1. Page the on-call.
2. Treat as P1 — backups not provably restorable equals "no backups".
3. Do not ship to production until the next drill succeeds.

---

## 6. Operational notes

- The backup job MUST run from a host that can reach the production database **and** the backup bucket. The GitHub Actions workflow does this via the `production` environment secrets; if you move it to a self-hosted runner, mirror the secrets there.
- `pg_dump -Fc` against a hot read-replica is preferable for large datasets to avoid lock contention on the writer.
- Never store the `age` identity in the same vault as `DATABASE_URL` — if the vault is breached, the attacker should not get both data + key.
- The verifier script uses the *runtime* `DATABASE_URL` (RLS role), so it deliberately exercises the same access path the application uses; if RLS gets accidentally relaxed, the drill catches it.
