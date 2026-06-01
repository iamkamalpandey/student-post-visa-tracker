# Runbook: JWT key rotation (v1.1 — graceful overlap)

**Scope:** Rotate the RS256 keypair used to sign access tokens
(`JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` / `JWT_KID`) **without forcing every
active user to re-login.**

**Status:** v1.1 (graceful) is the supported procedure. The backend now
holds a multi-`kid` keyset and the JWKS endpoint
(`/.well-known/jwks.json`) publishes every configured public key. The
old "stop-the-world" flow is preserved at the bottom of this document
as **fallback for incident response only** — use it solely when a key
is suspected compromised and you need to burn it immediately.

Design background: [`jwt-key-rotation-graceful-v1-1.md`](./jwt-key-rotation-graceful-v1-1.md).

---

## When to rotate

| Trigger | Cadence | Notes |
| --- | --- | --- |
| Scheduled | At least annually | Calendar reminder owned by the security lead. Use the graceful procedure. |
| Incident-driven | Immediately on suspicion of key compromise | Use the **fallback (stop-the-world)** procedure further down. |
| Staff turnover | Within 24h of any departure of an engineer who had access to the secret store | Graceful procedure is fine — there is no published material from the departing engineer that survives the overlap window. |

---

## How the keyset works

The runtime loads up to three entries from env:

| Role | Envs | Behaviour |
| --- | --- | --- |
| **PRIMARY** | `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`, `JWT_KID` | Required. Used for **signing**. Published in JWKS. Accepted on verify. |
| **NEXT** | `JWT_PRIVATE_KEY_NEXT` (opt), `JWT_PUBLIC_KEY_NEXT`, `JWT_KID_NEXT` | Optional. The key rotating in. Published in JWKS. Accepted on verify. **Not** used for signing — promotion to PRIMARY happens by moving the envs. |
| **PREV** | `JWT_PUBLIC_KEY_PREV`, `JWT_KID_PREV` | Optional. The key rotated out. Public half only. Published in JWKS and accepted on verify so still-live tokens validate. |

Boot-time env validation (`apps/backend/src/config/env.ts`):

- `_PUBLIC_KEY_NEXT` set without `_KID_NEXT` → fail fast.
- `_PRIVATE_KEY_NEXT` set without `_PUBLIC_KEY_NEXT` → fail fast.
- `_PUBLIC_KEY_PREV` set without `_KID_PREV` → fail fast.

---

## Procedure (graceful, zero re-login)

> Prerequisites: access to the production secret store, ability to roll
> backend instances, and a DB superuser session for the audit row.

### 1. Generate a new RSA keypair

```bash
openssl genrsa -out new_private.pem 2048
openssl rsa -in new_private.pem -pubout -out new_public.pem
```

(Equivalent to `infra/scripts/gen-jwt-keys.sh`.)

Choose a fresh `kid`, e.g. `prod-key-2026-11`.

### 2. Stage the new key as NEXT (optional pre-warm)

This step is optional but recommended — it lets JWKS consumers (frontends,
third-party verifiers) pull the new public key before any token is signed
with it.

In the secret store, set:

- `JWT_PUBLIC_KEY_NEXT` — the **new** public key (PEM, single line, literal `\n`).
- `JWT_KID_NEXT` — the new kid.
- (Do **not** set `JWT_PRIVATE_KEY_NEXT` yet — it is unused for signing and
  only adds attack surface.)

Roll the backend. JWKS now returns 2 keys: PRIMARY + NEXT. Signing still
uses PRIMARY. Verify still works for existing tokens.

Wait long enough for downstream JWKS caches to refresh
(`/.well-known/jwks.json` is served with `Cache-Control: public, max-age=300`,
so **≥ 5 min**; allow 1 hour to be safe).

### 3. Promote NEXT → PRIMARY

In the secret store, **swap the values together**:

- `JWT_PRIVATE_KEY` ← the new private key.
- `JWT_PUBLIC_KEY` ← the new public key (previous `JWT_PUBLIC_KEY_NEXT`).
- `JWT_KID` ← the new kid (previous `JWT_KID_NEXT`).
- `JWT_PUBLIC_KEY_PREV` ← the **old** public key (previous `JWT_PUBLIC_KEY`).
- `JWT_KID_PREV` ← the **old** kid (previous `JWT_KID`).
- Unset `JWT_PUBLIC_KEY_NEXT` and `JWT_KID_NEXT` (promotion is complete).

Push **all** of these in a single secret-store revision. Partial updates
leave the process serving tokens with a `kid` that doesn't match the
published keyset.

Roll the backend. JWKS now returns 2 keys: new PRIMARY + PREV (old).

**Result:** new sessions sign with the new key. In-flight tokens signed
with the old key still verify against PREV. No user-visible re-login.

### 4. Wait for the overlap window to drain (T + 7 days)

The longest possible session age is `REFRESH_TOKEN_TTL_SECONDS` = 7 days
(refresh hands sessions back as new-key tokens organically as the 15-min
access TTL cycles, so most rotate within minutes — but a single idle 7-day
refresh is the worst case).

Wait **≥ 7 days**.

### 5. Drop PREV

In the secret store, unset:

- `JWT_PUBLIC_KEY_PREV`
- `JWT_KID_PREV`

Roll the backend. JWKS now returns 1 key (the new PRIMARY). The old key
is fully retired.

### 6. Write the audit rows

The runtime code does not auto-emit `auth.jwt.*` events. Insert them
manually so the audit chain reflects who drove the rotation:

```sql
-- At step 3 (promotion):
INSERT INTO audit_logs (action, entity_type, entity_id, actor_id, tenant_id, metadata, created_at)
VALUES ('auth.jwt.rotated', 'system', NULL, '<operator_user_id>', '<tenant_id>',
        jsonb_build_object('old_kid', '<old>', 'new_kid', '<new>',
                           'mode', 'graceful', 'reason', '<scheduled|turnover>'),
        now());

-- At step 5 (PREV dropped, ≥7d later):
INSERT INTO audit_logs (action, entity_type, entity_id, actor_id, tenant_id, metadata, created_at)
VALUES ('auth.jwt.prev.dropped', 'system', NULL, '<operator_user_id>', '<tenant_id>',
        jsonb_build_object('retired_kid', '<old>'),
        now());
```

---

## Recovery if the rotation fails

Each step is independently reversible because both keys live in the
keyset during the overlap.

- **Step 2 failed (NEXT staged badly):** unset `JWT_PUBLIC_KEY_NEXT` /
  `JWT_KID_NEXT`. Back to PRIMARY-only. No user impact.
- **Step 3 failed (bad promotion):** restore the prior secret-store
  revision (the secret store should tag every push — use the
  pre-rotation tag). Roll backend. Old PRIMARY is active again; in-flight
  new-key tokens become invalid, but the overlap kept the old ones
  working, so impact is bounded to the brief window the new key was
  PRIMARY.
- **Step 5 failed (PREV dropped too early):** restore the `*_PREV` envs.
  Tokens that were rejected during the misconfiguration window will be
  re-issued on next refresh or login.

File a post-mortem for any rollback past step 3.

---

## Post-rotation checklist

- [ ] All backend pods report ready on `/api/v1/health/readyz`.
- [ ] `/.well-known/jwks.json` returns the expected number of keys for
      the current phase (2 during overlap, 1 after PREV is dropped).
- [ ] Smoke-test login → access token → `/auth/me` round-trip.
- [ ] Smoke-test that a token issued **before** step 3 still verifies
      during the overlap window (capture one in step 1, replay at step 3+1min).
- [ ] Audit row `auth.jwt.rotated` exists for this UTC date.
- [ ] Calendar reminder set for step 5 (T + 7 days).
- [ ] After step 5: audit row `auth.jwt.prev.dropped` exists; tag the
      retired secret entry `retired-<UTC-date>`.
- [ ] File a ticket to delete the retired secret snapshot after 30 days.
- [ ] Update the rotation calendar with the next-due date.

---

## Fallback: stop-the-world (incident response only)

> Use this **only** when a key is suspected compromised and you need to
> invalidate every session right now. The graceful procedure above is
> the supported path for scheduled rotations and routine staff turnover.

This is the v1 procedure. It rejects every token signed under the old
key the instant the new key loads — users are force-logged-out and must
re-authenticate. Expected user-visible impact: ~5 min per active user
(time to notice 401, re-enter password + MFA). Background integrations
holding bearer tokens fail until they re-authenticate.

### Steps

1. **Generate** a new keypair (see graceful step 1).
2. **Store** in the secret store, tag the prior version
   `pre-rotation-<UTC-date>`.
3. **Update PRIMARY only** (no NEXT, no PREV) — push all three vars in
   one revision:
   - `JWT_PRIVATE_KEY`
   - `JWT_PUBLIC_KEY`
   - `JWT_KID`
   - Explicitly unset any `JWT_*_NEXT` and `JWT_*_PREV` vars so they
     don't accidentally accept the compromised key.
4. **Restart** backend instances. Every old-key token is now rejected.
5. **Sweep** dead refresh tokens (the access tokens they'd mint are
   useless under the new key):

   ```sql
   DELETE FROM refresh_tokens
    WHERE issued_at < '<rotation_ts_utc>';
   ```

6. **Audit row:**

   ```sql
   INSERT INTO audit_logs (action, entity_type, entity_id, actor_id, tenant_id, metadata, created_at)
   VALUES ('auth.jwt.rotated', 'system', NULL, '<operator_user_id>', '<tenant_id>',
           jsonb_build_object('old_kid', '<old>', 'new_kid', '<new>',
                              'mode', 'stop-the-world', 'reason', 'incident'),
           now());
   ```

7. **Coordinate** with integration owners — long-lived bearer tokens
   need to be re-minted.

Rollback: restore the prior secret-store revision and restart backend.
Old-key tokens are valid again, but you've now effectively given the
attacker a second window — only roll back if the rotation itself broke
the service (bad PEM, restart loop). Never roll back to recover user
sessions during a real incident.
