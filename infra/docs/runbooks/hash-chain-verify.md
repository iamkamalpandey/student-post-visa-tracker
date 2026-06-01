# Runbook: Audit-log hash-chain verification

**Owner:** Security on-call.
**Trigger:** Suspected tampering, regulator request, monthly assurance review.

## Background

Every `audit_logs` row has `prev_hash` and `entry_hash` columns set by a `BEFORE INSERT` trigger. The hash function is SHA-256 over a canonical concatenation of the row fields plus `prev_hash`. Any UPDATE or DELETE on `audit_logs` is rejected by triggers, so tampering requires bypassing trigger checks (only a Postgres superuser can do that).

## Verify via REST (admin token)

The chain verifier is exposed as `GET /api/v1/audit-logs/verify` (admin-only,
rate-limited to 5/min). The frontend `/audit` page surfaces this as a "Verify
chain" button with a persisted result chip; for scripting:

```bash
TOKEN=$(curl -sS -X POST "$BE/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"…"}' | jq -r .access_token)

curl -sS "$BE/audit-logs/verify" -H "Authorization: Bearer $TOKEN" | jq .
# {"data":{"tenant_id":"…","broken_count":0,"broken_ids":[]}}
```

Wire this into a nightly cron + alert on `broken_count > 0`. Loud structured
logs already fire on the backend with level=error when a break is detected.

## Verify a single tenant chain (direct SQL)

```sql
SELECT * FROM audit_logs_verify('00000000-0000-0000-0000-000000000000'::uuid);
```

The function returns the **first** row whose hash chain breaks, or zero rows if the chain is intact.

## Verify all tenants

```sql
DO $$
DECLARE r RECORD; broken uuid;
BEGIN
  FOR r IN SELECT id FROM tenants LOOP
    SELECT broken_id INTO broken FROM audit_logs_verify(r.id) LIMIT 1;
    IF broken IS NOT NULL THEN
      RAISE NOTICE 'tenant=% broken at %', r.id, broken;
    END IF;
  END LOOP;
END $$;
```

## If a break is found

1. Freeze writes from the suspected window (the application sets `app.tenant_id` per request — block at the LB).
2. Snapshot the DB.
3. Locate the broken row(s); reconstruct the expected `entry_hash` from the surrounding chain to learn what was modified.
4. Pull recent superuser actions: `SELECT * FROM pg_stat_activity WHERE usename = 'postgres' AND query_start > now() - interval '7 days';`. If your audit-log infra ships statement-level audit (`pgaudit`), query that source.
5. If tampering is confirmed, escalate per the breach-incident runbook within 1 hour.

## Production hardening (deploy before going live)

- Daily cron job recomputes per-tenant Merkle roots (see `apps/backend/src/jobs/hashAnchor.ts`) and writes them to an external WORM store (S3 with Object Lock in `Compliance` mode). The roots become the ground truth; future verifications compare against them.
- Postgres role separation: the application role (`spv_app`) cannot drop triggers; only `spv_admin` can, and `spv_admin` is sealed in KMS-protected break-glass storage.
- Wire the `audit_logs_verify` results into the dashboard's SLO panel; a non-empty result pages the on-call.
