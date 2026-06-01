# Runbook: KEK rotation (data encryption envelope key)

**Owner:** Platform on-call.
**Trigger:** Quarterly schedule, suspected KEK compromise, retirement of an HSM key version.
**Scope:** This runbook covers the per-row re-wrap of envelope-encrypted PII columns AND the independent rotations of `REFRESH_TOKEN_PEPPER` and `LOG_HMAC_KEY_BASE64` (a.k.a. `CORRELATION_HMAC_KEY`). The legacy `kms-rotation.md` is preserved as the architecture primer and links here for the actual procedure.

## Background

| Secret                  | Purpose                                                  | Storage         | Rotation impact                                                   |
|-------------------------|----------------------------------------------------------|-----------------|-------------------------------------------------------------------|
| KEK                     | Wraps per-field DEKs (envelope encryption)               | KMS provider    | Re-wrap script must run; otherwise old KEK destruction loses data |
| `REFRESH_TOKEN_PEPPER`  | HMAC pepper on `refresh_tokens.token_hash`               | env var (hex)   | All issued refresh tokens become invalid (forces re-login)        |
| `LOG_HMAC_KEY_BASE64`   | HMAC key for `ip_hash` / `ua_hash` / `email_hash`        | env var (b64)   | Audit-log correlation namespace re-bases (operators lose pivots)  |

All three are **independent** — rotating one MUST NOT silently rotate the others. Previously the correlation key was derived from `JWT_PRIVATE_KEY`, which made JWT rotation silently invalidate the audit-log correlation namespace; that linkage is now severed (see `tests/hashing.spec.ts` — `correlation hashes survive JWT rotation`).

---

## Procedure: KEK rotation (with re-wrap)

### Phase 1 — pre-flight

1. **Page security on-call** and open a change-control ticket. Tag the ticket with current `KMS_KEY_ID`.
2. **Capture the current state**:
   ```bash
   pnpm --filter backend tsx scripts/rewrap-secrets.ts --dry-run | tee rewrap-preflight.log
   ```
   The dry-run decrypts every row to confirm readability under the active KEK. Fail-stop if any row fails to decrypt — that is a corrupted-blob incident, not a rotation incident.
3. **Estimate duration**. The dry-run prints a per-column count. Production estimate: ~500 rows/sec on a `db.r6g.large` with `--batch-size 500`. Multiply by your row count, then add 20% headroom for KMS rate-limit backoff.

### Phase 2 — provision the new KEK

1. **Create the new key version** in the KMS provider:
   - AWS: `aws kms create-key --description "spv KEK v$N"`
   - GCP: `gcloud kms keys versions create --location=<l> --keyring=<r> --key=<k>`
   - Vault: `vault write -force transit/keys/<key>/rotate`
2. **Promote the new version to primary** for fresh wraps. KEEP the old version enabled — the re-wrap script needs to unwrap legacy blobs through it.
3. Set `OLD_KEK_HANDLE=<old-key-id>` in the deploy environment. The script reads it via `--old-kek-id`; for `LocalKms`, also export `OLD_KEK_BASE64=<old-base64>` so the unwrap path can find the prior key material.

### Phase 3 — deploy the runtime with dual-KMS

1. Roll the app with `KMS_KEY_ID` pointing at the NEW key. Fresh wraps now use new; unwrap silently falls through to old when the KMS provider sees an old-version ciphertext blob.
2. Smoke-test by reading a known encrypted field through any admin endpoint that decrypts (e.g. retrieve a student record). 200 OK = round-trip works.

### Phase 4 — re-wrap

Tenant-batched so a large tenant can be scheduled separately:

```bash
# Per-tenant re-wrap (parallelism via xargs):
psql -At -c "SELECT id FROM tenants WHERE deleted_at IS NULL" \
  | xargs -P 4 -I{} pnpm --filter backend tsx scripts/rewrap-secrets.ts \
      --tenant {} \
      --old-kek-id "$OLD_KEK_HANDLE" \
      --new-kek-id "$KMS_KEY_ID" \
      --batch-size 500
```

(If `--tenant` is omitted the script walks ALL rows — fine for small fleets, but per-tenant lets you stagger and resume.)

For very large single tables (typically `audit_logs`), restrict to one table at a time with `--table`:

```bash
pnpm --filter backend tsx scripts/rewrap-secrets.ts \
  --table audit_logs \
  --old-kek-id "$OLD_KEK_HANDLE" \
  --new-kek-id "$KMS_KEY_ID" \
  --batch-size 500
```

`--table` fails fast on an unknown name (so a typo can't silently no-op the rotation). Known tables are listed in `apps/backend/scripts/rewrap-secrets.ts:ENCRYPTED_COLUMNS` and pinned by the `rewrap-secrets.spec.ts` schema-coverage assertion.

The script writes progress to `kek_rotation_progress`. A crash mid-rotation is recovered by re-running with identical args.

### Phase 5 — verify

```bash
# Every row should be in kek_rotation_progress with new_kek_id matching the new key:
psql -c "
  SELECT table_name, column_name, COUNT(*) AS rewrapped
    FROM kek_rotation_progress
   WHERE new_kek_id = '$KMS_KEY_ID'
   GROUP BY 1, 2"
```

Cross-check against expected counts from the dry-run preflight log.

### Phase 6 — retire the old KEK

1. **Disable** (not delete) the old KMS key version. Wait 30 days minimum.
2. Remove `OLD_KEK_HANDLE` / `OLD_KEK_BASE64` from the deploy environment.
3. After the cool-off, you may schedule deletion of the old key version. **Never** delete an old KEK before verifying every encrypted column has been re-wrapped — the data becomes permanently unreadable.

---

## Procedure: `REFRESH_TOKEN_PEPPER` rotation

Independent of KEK rotation. Effects: every issued refresh token becomes invalid on the next refresh request — users will be silently bounced to login.

1. Generate a new pepper: `openssl rand -hex 32`.
2. Roll the app with the new `REFRESH_TOKEN_PEPPER`. No DB migration is needed — the existing `refresh_tokens.token_hash` column simply stops matching the new HMAC.
3. Notify the user-experience team so support is staffed for the "I had to re-login" volume spike.

No re-wrap script exists for refresh tokens because the hash is a one-way HMAC — there is nothing to "decrypt and re-encrypt", and the natural-expiry mechanism is acceptable.

---

## Procedure: `LOG_HMAC_KEY_BASE64` (correlation key) rotation

Independent of both KEK and refresh pepper. Effects: pre-rotation `ip_hash` / `ua_hash` / `email_hash` values no longer match newly-computed HMACs for the same plaintexts. Operators can still query the audit log; they just can't pivot across the rotation boundary on a single hash value.

1. Generate a new key: `openssl rand -base64 32`.
2. Roll the app with the new `LOG_HMAC_KEY_BASE64`.
3. Document the rotation in the audit-log forensic guide. Investigators querying by IP/email after the rotation need to compute the HMAC under BOTH the old and new keys to recover events spanning the cutover.

The legacy spelling `CORRELATION_HMAC_KEY` (hex) is still accepted. When both are set, the base64 form wins.

---

## What if a key is compromised?

| Compromised secret          | Immediate action                                                                                   |
|-----------------------------|----------------------------------------------------------------------------------------------------|
| KEK                         | Disable old version, rotate per phases 2–6, **force re-wrap** before destroying old KEK, rotate MFA seeds |
| `REFRESH_TOKEN_PEPPER`      | Rotate now; users force-logged-out on next refresh                                                 |
| `LOG_HMAC_KEY_BASE64`       | Rotate now; document cutover for forensic queries                                                  |
| JWT signing key             | Follow `jwt-key-rotation.md` (separate runbook)                                                    |

File a `BreachIncident` row and follow `incident-response.md` for any S1 / S2 grade compromise.
