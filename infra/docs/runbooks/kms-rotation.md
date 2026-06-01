# Runbook: KMS key rotation

**Owner:** Platform on-call.
**Trigger:** Quarterly schedule, suspected key exposure, or end-of-life of an algorithm.

## Architecture recap

Field-level secrets (passport / visa / insurance numbers, sponsor income, MFA seeds, audit-log diffs) are encrypted with envelope encryption:

- A **Key Encryption Key (KEK)** is held in the KMS provider. It never leaves the HSM.
- A fresh **Data Encryption Key (DEK)** is generated per encrypted field and wrapped under the KEK at write time.
- The wrapped DEK is stored inline with the ciphertext (`[ver][wrappedDekLen][wrappedDek][iv][ciphertext][tag]`).

Rotating the KEK does **not** require rewriting ciphertext: the KMS layer keeps both old and new KEK versions and unwraps the DEK using the version embedded in the wrapped blob.

## Rotation procedure

1. **Audit before** — record current key id from `JWT_KID` and from the KMS console.
2. **Generate new key version** in the KMS provider (`aws kms create-key`, `gcloud kms keys versions create`, Vault `transit/keys/<key>/rotate`).
3. **Set the new version as primary** for new wraps. Keep the old version enabled for unwrap.
4. **Restart the application** — the KMS abstraction lazy-loads the active version on next request.
5. **Smoke-test** — encrypt-then-decrypt a test field via the admin endpoint (or run `pnpm --filter backend test -- encryption`).
6. **Re-wrap** — if compliance requires that all secrets be wrapped under the new KEK (or if the old KEK was compromised), run:

   ```bash
   # First, dry-run to verify every row decrypts under the current KMS:
   pnpm tsx infra/scripts/rewrap-secrets.ts --dry-run

   # Then, do the real rewrap. KEK ids are written to kek_rotation_progress
   # for audit; they do not affect the actual crypto.
   pnpm tsx infra/scripts/rewrap-secrets.ts \
     --old-kek-id "<kms-key-id-being-retired>" \
     --new-kek-id "<kms-key-id-now-active>"
   ```

   The script is idempotent (progress is persisted in `kek_rotation_progress`); a crash is recovered by simply re-running. Batches default to 500 rows; override with `--batch-size`.

   Lazy re-wrap is acceptable for routine rotations (the security boundary is the active KEK, which is now new). It is NOT acceptable for compromise events — destroying the old KEK before re-wrap leaves any un-touched ciphertext permanently unreadable.
7. **Disable the old version** after the change-control window (recommended: 30 days). Set status to `Disabled`, never `Pending Deletion` until you have verified no ciphertext still references it.
8. **Audit after** — record the new key version id; update the CHANGELOG; close the rotation ticket.

## JWT signing key (RS256)

Different from data encryption — the JWT key is rotated by:

1. Generating a new RSA keypair (`infra/scripts/gen-jwt-keys.sh`).
2. Adding the new public key to the JWKS endpoint with a new `kid` (the JWKS handler will need to support multi-key — a small follow-up).
3. Setting the new `JWT_KID` and `JWT_PRIVATE_KEY` for the next deploy; the old public key continues to be served until the longest access-token TTL elapses (15 min by default).
4. Removing the old key from JWKS after the cutover window.

## What if a key is compromised?

- Treat as a S1 incident: page security on-call.
- **Data KEK** — disable the compromised version (do not delete); generate replacement; force re-wrap of every encrypted field via the rewrap script (priority: passport / visa / sponsor income); rotate user MFA seeds (force re-enrolment).
- **JWT signing key** — remove from JWKS immediately; revoke all `RefreshToken` rows; force re-login for every user; audit recent token issuance for anomalies.
- File a `BreachIncident` row and follow the incident-response runbook.
