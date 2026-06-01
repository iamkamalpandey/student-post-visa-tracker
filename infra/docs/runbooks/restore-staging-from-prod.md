# Runbook: Refresh staging DB from a scrubbed prod snapshot

**Owner:** Platform on-call.
**Trigger:** Monthly cadence, or when staging data is too stale for meaningful QA.

## Why scrub

Real production PII must never live in staging. Staff laptops sync to staging credentials more loosely than to prod, and staging logs are retained on a cheaper plan. The scrub:

- Replaces every `email_primary` / `email_secondary` with `staging+<id>@example.invalid`.
- Replaces every `phone_primary_e164` / `phone_secondary_e164` with `+10000000000` plus 6 deterministic digits.
- Re-encrypts every `*_enc` column with the staging KMS key (so even if a staging backup leaks, prod KMS is unaffected).
- Truncates `audit_logs` (staging does not need prod's tamper-evident chain).
- Truncates `documents` and the corresponding object-storage prefix.

## Procedure

```bash
# 1. Take a fresh prod snapshot (managed Postgres handles this).
PROD_SNAPSHOT=$(neonctl branches create --project-id "$NEON_PROJECT_PROD" --name "scrub-source-$(date +%Y%m%d)")
PROD_DB_URL=$(neonctl branches get-connection-uri --branch-id "$PROD_SNAPSHOT" --project-id "$NEON_PROJECT_PROD")

# 2. Spin a temporary scrub workspace on the staging cluster.
SCRUB_BRANCH=$(neonctl branches create --project-id "$NEON_PROJECT_STAGING" --name "scrub-$(date +%Y%m%d)")
SCRUB_DB_URL=$(neonctl branches get-connection-uri --branch-id "$SCRUB_BRANCH" --project-id "$NEON_PROJECT_STAGING")

# 3. Logical dump → restore.
pg_dump --no-owner --no-acl --schema=public "$PROD_DB_URL" | psql "$SCRUB_DB_URL"

# 4. Apply the scrub script.
psql "$SCRUB_DB_URL" -f infra/scripts/scrub-staging.sql

# 5. Re-encrypt PII columns under the staging KMS key.
DATABASE_URL="$SCRUB_DB_URL" KMS_KEK_BASE64="$STAGING_KMS_KEK" \
  pnpm --filter backend tsx infra/scripts/rewrap-secrets.ts --confirm

# 6. Promote the scrub branch to main staging.
neonctl branches set-default --project-id "$NEON_PROJECT_STAGING" --branch "$SCRUB_BRANCH"

# 7. Notify staging users in #staging that data was refreshed.
```

## Pre-flight checks

- The `infra/scripts/scrub-staging.sql` script must complete without errors against a small fixture before running on a real snapshot.
- KMS keys for staging and production must never be the same id.
- The DPO must approve the procedure before the first real run; subsequent runs follow the documented playbook.

## Rollback

If the refresh breaks staging:

```bash
neonctl branches set-default --project-id "$NEON_PROJECT_STAGING" --branch "previous-default-id"
```

The scrub branch is preserved for forensic review until the next refresh.
