# Runbook: Rotate KMS_KEK + JWT keypair + DB password (zero-downtime)

**Scope:** Production rotation of `KMS_KEK_BASE64`, `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY`/`JWT_KID`, and the Postgres `spv_app` password. Every step assumes ≥2 backend replicas behind the LB so rolling restarts cause no outage.

**Pre-flight:** Snapshot DB. Confirm `/api/v1/health/livez` green on all pods. Notify on-call. Take a backup of current secrets to a sealed vault entry tagged `pre-rotation-<UTC-date>`.

---

## 1. JWT keypair (RS256) — dual-key window

The codebase already supports `JWT_KID` in token headers. Rotate by trusting the new public key first, then signing with the new private key.

1. Generate new keypair:
   ```bash
   openssl genpkey -algorithm RSA -out jwt_new.pem -pkeyopt rsa_keygen_bits:2048
   openssl rsa -in jwt_new.pem -pubout -out jwt_new_pub.pem
   ```
2. **Phase A (verify-both):** Add the new public key as `JWT_PUBLIC_KEY_NEXT` alongside the existing one and roll backend. Keep `JWT_PRIVATE_KEY` (old) as signer. Wait one full `ACCESS_TOKEN_TTL_SECONDS` (15 min) so no in-flight tokens are stranded.
3. **Phase B (sign-new):** Swap `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, and bump `JWT_KID` (e.g. `prod-key-2026-05`). Keep the *previous* public key as `JWT_PUBLIC_KEY_PREV`. Roll backend.
4. Wait one `REFRESH_TOKEN_TTL_SECONDS` (7 days) before removing `JWT_PUBLIC_KEY_PREV`. Roll backend a final time.

Rollback: re-apply pre-rotation secret snapshot and roll. Old `kid` is still trusted until step 4.

---

## 2. KMS_KEK (envelope encryption)

DEKs are encrypted with the KEK. Rotation must re-wrap existing DEKs, not re-encrypt data.

1. Generate new KEK: `openssl rand -base64 32`.
2. Deploy backend with `KMS_KEK_BASE64` = old, `KMS_KEK_NEXT_BASE64` = new. Decryption tries current then next; new writes still use current. Roll.
3. Run the re-wrap one-shot job (see `kms-rotation.md` for the exact CLI) — it iterates `data_encryption_keys`, decrypts each DEK with old KEK, re-encrypts with new KEK, updates `kek_version`. Idempotent and resumable.
4. Promote: set `KMS_KEK_BASE64` = new, drop `KMS_KEK_NEXT_BASE64`. Roll.
5. Verify: `SELECT COUNT(*) FROM data_encryption_keys WHERE kek_version <> $current` returns 0.

Rollback: while step 3 is running, demoting is safe (both KEKs are accepted). After step 4, rollback requires restoring the prior KEK as `KMS_KEK_NEXT_BASE64`.

---

## 3. Postgres `spv_app` password

Use Postgres' ability to authenticate any of the listed `password` hashes during the change window (achieved via a transient secondary role).

1. In DB as superuser:
   ```sql
   ALTER ROLE spv_app WITH PASSWORD '<new-strong-password>';
   ```
   Existing pooled connections survive — only new auths use the new password.
2. Update `DATABASE_URL` in the secret store with the new password.
3. Roll backend one replica at a time. Each new pod opens fresh connections with the new password; old pods continue serving on their existing pool until terminated.
4. After rollout, run `SELECT usename, count(*) FROM pg_stat_activity GROUP BY 1;` to confirm only the expected app role is active.
5. Do **not** rotate `DATABASE_MIGRATE_URL` (`spv` owner) in the same window — schedule that separately to keep blast radius small.

Rollback: `ALTER ROLE spv_app WITH PASSWORD '<old>';` then re-roll with the old secret.

---

**Post-rotation:** Tag the secret vault entry `rotated-<UTC-date>`. File a ticket to delete the prior secret snapshot after 30 days.
