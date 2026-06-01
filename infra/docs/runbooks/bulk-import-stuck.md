# Runbook: Bulk import worker stuck

**Owner:** Backend on-call.
**Trigger:** `ImportJob` row stays in status `APPLYING` for > 30 minutes, or `import.row_processed` stops advancing.

## Diagnose

1. Find the job:

    ```sql
    SELECT id, status, row_processed, row_total, created_at, started_at, completed_at
      FROM import_jobs
      WHERE status = 'APPLYING'
        AND started_at < now() - interval '30 minutes';
    ```

2. Check application logs for the job id (request_id correlation):

    ```bash
    grep "<job_id>" /var/log/spv/backend-*.log | tail -200
    ```

3. Look for stuck row patterns: same row number repeated, lock wait timeouts, ClamAV timeouts (only if file storage is uploaded as part of the import).

## Common causes

| Cause | Resolution |
|---|---|
| Postgres advisory lock held by a crashed worker | `SELECT pg_advisory_unlock_all();` from a maintenance session, then mark job FAILED so the operator can re-apply. |
| ClamAV not responding | Restart the clamav container; the import does not require AV (only documents do), so this is rare; check that the import worker isn't accidentally calling `scanBuffer`. |
| KMS rate limit exceeded | Check provider dashboard; pause the worker for 60s and resume; consider batching DEK operations. |
| Source file corrupted mid-stream | Mark FAILED, generate `errors.jsonl`, ask the operator to re-upload. |

## Recover

```bash
# Mark the stuck job FAILED so the operator can act.
psql "$DATABASE_URL" -c "UPDATE import_jobs SET status='FAILED', completed_at=now() WHERE id='<job_id>';"

# Re-run with the same Idempotency-Key — already-applied rows are no-ops via ExternalId upsert.
curl -X POST "$API/imports/<resource>" -F "file=@<source.csv>" -H "Authorization: Bearer $TOKEN"
# then call /imports/:id/apply with a fresh Idempotency-Key
```

## Long-term hardening

- Move imports to BullMQ (Redis) so a heartbeat can detect stuck jobs automatically.
- Add a row-level checkpoint table so resume continues from `row_processed + 1` instead of restarting.
- Surface the stuck-import alert in the SLO dashboard.
