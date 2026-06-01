# Runbook: Database point-in-time restore

**Owner:** Platform on-call.
**Trigger:** Confirmed data corruption, accidental destructive operation, or regulator-requested rollback.
**Target RTO:** 60 minutes. **Target RPO:** ≤ 5 minutes (depends on managed Postgres tier).

## Pre-flight

1. Confirm the incident in `#ops-incidents` and open a status-page entry.
2. Page the data-protection officer if the incident may have exposed subject data.
3. Stop **only** the workloads that write to the affected dataset (the API). The frontend can stay up serving cached reads.
4. Snapshot the current state before restoring — even corrupt state is forensic evidence.

## Restore

### Neon (recommended)

```bash
neonctl branches create \
  --project-id "$NEON_PROJECT" \
  --name "restore-$(date +%Y%m%d%H%M)" \
  --parent-timestamp "2026-05-14T10:42:00Z"
```

Update `DATABASE_URL` to point at the new branch, smoke-test, then promote.

### AWS RDS

```bash
aws rds restore-db-instance-to-point-in-time \
  --source-db-instance-identifier spv-prod \
  --target-db-instance-identifier spv-prod-restore-"$(date +%Y%m%d%H%M)" \
  --restore-time "2026-05-14T10:42:00Z"
```

Wait for status `available`, smoke-test, swap the endpoint via Route 53.

### Self-hosted Postgres

If you take nightly `pg_basebackup` snapshots and ship WAL to S3 with `wal-g`:

```bash
wal-g backup-fetch /var/lib/postgresql/data LATEST
echo "restore_command = 'wal-g wal-fetch %f %p'" >> /var/lib/postgresql/data/recovery.conf
echo "recovery_target_time = '2026-05-14 10:42:00 UTC'" >> /var/lib/postgresql/data/recovery.conf
systemctl start postgresql
```

## Post-restore verification

1. `SELECT count(*) FROM students` and key tables — sanity check.
2. Run `audit_logs_verify('00000000-0000-0000-0000-000000000000')` per tenant; investigate any returned IDs.
3. Re-run the integration test suite against the restored DB.
4. Bring the API back online; tail logs for refresh-token reuse warnings (some sessions may have lost their server-side state).
5. Notify users via in-app banner if any client-side state may be stale.

## Aftermath

- Open a postmortem within 48 hours; root-cause and remediation in writing.
- Schedule a restore drill within 30 days to verify the runbook still works.
