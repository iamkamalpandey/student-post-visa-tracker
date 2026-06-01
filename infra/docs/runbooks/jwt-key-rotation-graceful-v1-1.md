# Roadmap: Graceful JWT key rotation (v1.1)

**Status:** **Implemented.** This document is preserved as the design record.
The operator procedure now lives in [`jwt-key-rotation.md`](./jwt-key-rotation.md);
follow that runbook to perform a rotation. The env var names that shipped
differ slightly from the names in this sketch — see the
[Implementation notes](#implementation-notes) section below.

**Goal:** Eliminate the stop-the-world re-login that v1 rotation forces on
every active user. Sessions issued under the previous key should keep
working until they expire naturally.

---

## Design — multi-`kid` overlap window

Two signing keys are loaded at any time:

- `JWT_PRIVATE_KEY_PRIMARY` (with `JWT_KID_PRIMARY`) — used for **signing**.
- `JWT_PRIVATE_KEY_SECONDARY` (with `JWT_KID_SECONDARY`) — accepted for
  **verification** only.

Behaviour:

- **Sign:** always with primary. The protected header carries
  `kid = JWT_KID_PRIMARY`.
- **Verify:** read the `kid` from the incoming token's header, pick the
  matching public key from the in-memory keyset, then verify. Reject if
  the `kid` matches neither.
- **JWKS** (`/.well-known/jwks.json`): publishes **both** public keys with
  their respective `kid` values so JWKS consumers (frontends, future
  third-party verifiers) can verify either.

### Rotation flow under this design

1. **T0 — promote new key.** Move the current primary to secondary; load
   the freshly-generated key as primary. Roll backend.
2. **T0 → T+7d — overlap.** New sessions sign with the new key. Old
   sessions continue to verify against the secondary (now the old key).
   Refresh hands sessions back as new-key tokens organically as the access
   TTL (15m) cycles.
3. **T+7d — drop secondary.** Once the longest possible session age
   (refresh TTL = 7 days) has passed, unset `JWT_PRIVATE_KEY_SECONDARY` /
   `JWT_KID_SECONDARY` and roll backend. Old key is fully retired.

Zero user-visible re-login. Same audit trail as v1
(`auth.jwt.rotated`, plus a `auth.jwt.secondary.dropped` event at T+7d).

### Incident-driven rotation (key suspected compromised)

Skip the overlap and force re-login: load the new key as primary **without**
populating secondary. This is identical to the v1 stop-the-world flow —
preserved as a deliberate option for "burn the old key now" scenarios.

---

## Schema impact

None. `RefreshToken.issued_at` already exists, which is all the cleanup
sweep needs. No migration required.

---

## Code touches

Roughly **~50 lines** across two files:

- `apps/backend/src/shared/jwt.ts`
  - Replace the two singleton `importPKCS8` / `importSPKI` promises with
    a small keyset map keyed by `kid`.
  - `signAccessToken` looks up the primary; `verifyAccessToken` resolves
    the verification key from `protectedHeader.kid`.
  - `jwks()` returns both pubkeys when secondary is set.
- `apps/backend/src/config/env.ts`
  - Add optional `JWT_PRIVATE_KEY_SECONDARY` / `JWT_PUBLIC_KEY_SECONDARY`
    / `JWT_KID_SECONDARY`. Keep existing `JWT_*` vars as the primary
    aliases for backwards compatibility, or rename to `JWT_*_PRIMARY` with
    a one-release deprecation window.

The JWKS endpoint
(`apps/backend/src/modules/wellknown/wellknown.routes.ts`) needs no change
beyond what `jwks()` already returns.

**Estimate:** 1 engineer-day including unit tests covering primary-only,
overlap, and secondary-only verification paths.

---

## Out of scope for v1.1

- Externally-rotated keys via a KMS-signing API (e.g. AWS KMS asymmetric
  sign). v1.1 keeps in-process PEMs.
- Per-tenant signing keys. Single global keyset for now.
- Automated rotation cron. Operator still drives the rotation; the runbook
  just stops forcing re-login.

---

## Implementation notes

The shipped envs renamed `*_SECONDARY` → split `*_NEXT` and `*_PREV` so the
rotation flow reads naturally end-to-end:

| Sketch name | Shipped name | Role |
| --- | --- | --- |
| `JWT_PRIVATE_KEY_PRIMARY` / `JWT_PUBLIC_KEY_PRIMARY` / `JWT_KID_PRIMARY` | `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` / `JWT_KID` | Required; signs. Backward-compat with v1 deployments. |
| `JWT_*_SECONDARY` (verify-only, key being phased out) | `JWT_PUBLIC_KEY_PREV` / `JWT_KID_PREV` | Optional; public-only; accepts in-flight tokens. |
| _(not in sketch)_ | `JWT_PUBLIC_KEY_NEXT` / `JWT_KID_NEXT` (`JWT_PRIVATE_KEY_NEXT` optional) | Optional; published in JWKS before promotion so downstream caches warm up. |

Files touched:

- `apps/backend/src/shared/jwt.ts` — multi-`kid` keyset; verify resolves the
  key from `protectedHeader.kid`; `signAccessToken` always uses PRIMARY.
- `apps/backend/src/config/env.ts` — optional NEXT/PREV envs + fail-fast
  pairing checks (`_PUBLIC_KEY_NEXT` requires `_KID_NEXT`, etc.).
- `apps/backend/tests/jwt-rotation.spec.ts` — coverage for sign-with-primary,
  verify-under-PREV, unknown-kid rejection, JWKS keyset size.
- `apps/backend/src/modules/wellknown/wellknown.routes.ts` — unchanged
  (delegates to `jwks()` as the sketch predicted).
