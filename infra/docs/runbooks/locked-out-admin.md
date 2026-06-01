# Locked-out admin recovery (MFA force-disable)

Use this runbook when a customer admin reports they cannot log in because they
have lost **BOTH** their TOTP authenticator device **AND** every recovery code
issued at MFA enrolment.

Previously the only recovery was direct `psql` access (CTO audit P0). The
platform now ships an admin-driven force-disable flow — exposed both in the
admin UI ("Force disable MFA" row-menu action on the Users page) and as a
backend route — so another admin in the same tenant can clear the
locked-out user's second factor without DBA involvement.

## Pre-conditions / triage

Before running this procedure, confirm in this order:

1. **Identity proof.** Verify the requester via your customer-support process
   (signed email from the registered billing contact, video call against the
   tenant's verified phone, etc.). Phishing for an MFA reset is an obvious
   pivot for an attacker — treat the request like a password reset for a
   privileged account.
2. **The user really has lost both factors.** Walk them through:
   - Re-installing their authenticator on a new device and scanning the original
     QR (rarely possible — most users don't keep the QR).
   - Checking the 10 single-use recovery codes (PDF download offered at
     enrolment, often saved to a password manager).
   - Checking any backup TOTP they may have configured.
3. **There is another admin in the same tenant.** Run:
   ```sql
   SELECT id, email, role, mfa_enabled
   FROM users
   WHERE tenant_id = '<tenant-uuid>'
     AND role = 'ADMIN'
     AND is_active = true
     AND deleted_at IS NULL;
   ```
   At least one admin OTHER than the locked-out user must exist. If the
   locked-out user is the tenant's only admin, escalate to the on-call SRE —
   that scenario requires the legacy psql path because no in-tenant admin can
   invoke the API (the route refuses self-targeting on purpose).

## Procedure (admin UI — primary path)

The admin UI is the supported path. The row-menu action and confirm dialog
live in `apps/frontend/app/(app)/users/Client.tsx` and call the same
`POST /users/:id/mfa/disable` route as the curl fallback below.

1. **Acting admin signs in** to the customer's tenant with their own
   credentials AND completes their own TOTP step-up at login. The action is
   `requireRole('ADMIN') + requireMfa`-gated server-side, so the acting
   admin must be an `ADMIN` (not `COUNSELLOR`) and must have MFA enrolled.
   A stolen ADMIN session alone is not enough.

2. **Navigate to Users.** Open the left-nav **Users** page. The locked-out
   account appears in the table with `MFA: enabled`.

   <!-- TODO: paste screenshot of the Users page with the row-menu open -->

3. **Open the row menu** (three-dot `⋮` button at the right of the
   locked-out user's row) and choose **"Force disable MFA"**.

   The menu item is disabled and shows a tooltip if the action is not
   available for that row (e.g. acting admin targeting themselves — use the
   self-serve password-stepped flow instead, or escalate to SRE if you are
   the only admin in the tenant).

4. **Fill in the confirm dialog.** A modal opens titled "Force disable MFA"
   showing the target email and a required **Reason (required, audited)**
   text area.

   <!-- TODO: paste screenshot of the confirm dialog with reason field -->

   Type a reason that includes:
   - The support ticket ID (e.g. `SUP-1234`).
   - How you verified the requester's identity (e.g. "verified via signed
     billing-contact email", "verified via video call against tenant's
     registered phone").
   - That both factors are confirmed lost.

   Example: `Customer lost TOTP + recovery codes; ticket SUP-1234; verified
   caller via signed billing-contact email`.

   The field enforces 3–500 chars after trimming (helper text shows the live
   count). The red **Force disable MFA** button stays disabled until the
   reason is valid.

5. **Confirm.** Click **Force disable MFA**. On success the dialog closes
   and the row updates to `MFA: disabled`. All of the target's active
   sessions are revoked atomically with the MFA clear.

6. **Notify the locked-out user.** They can now log in with their email +
   password. Tell them to:
   - Log in immediately.
   - Re-enrol MFA via **Settings → Security → Enable MFA**.
   - Download the 10 recovery codes and store them in a password manager
     this time.

7. **(Optional) Spot-check the audit row.** Compliance reviews these on the
   monthly audit pass, but you can confirm the entry landed:
   ```sql
   SELECT created_at, actor_id, entity_id, action
   FROM audit_log
   WHERE action = 'auth.mfa.force_disabled_by_admin'
     AND entity_id = '<target-user-uuid>'
   ORDER BY created_at DESC
   LIMIT 1;
   ```
   You should see one row with `actor_id` = the acting admin's UUID and the
   `reason` text persisted verbatim in the envelope-encrypted `after` blob.

## Fallback (no FE access)

Use this only when the admin UI is unreachable (FE outage, your support
workstation cannot reach the SPA, etc.). The endpoint is identical — the
dialog just wires the headers and reason JSON for you.

1. **Acting admin logs in** and captures:
   - Their `access_token` (Bearer JWT). Easiest: open DevTools on any
     reachable SPV admin UI page, copy from the `Authorization` header on
     any API call.
   - A fresh 6-digit TOTP code from their authenticator (`X-MFA-Code`).

2. **Identify the locked-out user's UUID:**
   ```sql
   SELECT id, email, mfa_enabled
   FROM users
   WHERE tenant_id = '<tenant-uuid>'
     AND email = '<lockedout-email>';
   ```

3. **Fire the force-disable:**
   ```bash
   curl -X POST 'https://<api-host>/api/v1/users/<target-user-uuid>/mfa/disable' \
     -H "Authorization: Bearer <acting-admin-access-token>" \
     -H "X-MFA-Code: <acting-admin-totp-now>" \
     -H "Content-Type: application/json" \
     -d '{"reason":"Customer lost TOTP + recovery codes; ticket SUP-1234; verified caller via signed billing-contact email"}'
   ```

   Expected: `204 No Content`. The `reason` field is REQUIRED (3–500 chars
   after trimming) and is persisted verbatim in the audit row.

4. **Confirm the audit row landed** (same SQL as step 7 of the primary
   path) and **notify the locked-out user** (same instructions as step 6).

## Failure modes and responses

| Symptom | Cause | Fix |
|---|---|---|
| `403 Forbidden` "Use /auth/mfa/disable…" | Acting admin set their own user as the target | Use another admin's session, OR have the target use the password-stepped self flow |
| `403 Forbidden` (no message) | Acting account isn't `ADMIN` (e.g. COUNSELLOR) | Use an `ADMIN` account |
| `401 mfa_required` | Acting admin has MFA enrolled but didn't send `X-MFA-Code` | Add the header with a fresh TOTP and retry |
| `401 mfa_invalid` | Wrong TOTP or stale code | Wait for the authenticator to roll, retry |
| `401 mfa_replay` | Same code submitted twice in 60s | Wait for the next 30s window |
| `404 Not Found` | Target user UUID wrong, or in a different tenant | Re-check the UUID via the SQL above |
| `422 Unprocessable Entity` | `reason` missing or under 3 chars after trimming | Supply a meaningful reason |

## Defence-in-depth notes

- The route is `requireRole('ADMIN') + requireMfa`. A captured ADMIN session
  alone cannot clear another user's MFA — the attacker would also need the
  acting admin's TOTP device.
- The self-guard (`actorId === targetUserId → 403`) means the route cannot be
  used to bypass the password step-up on your own account. If your own MFA
  is lost AND you're the only admin, escalate to SRE for the legacy psql
  recovery path.
- All refresh tokens for the target are revoked atomically with the MFA
  clear. Any live session on the target's account is invalidated — they must
  re-login (and the next step-up against any MFA-gated route will pass
  through because MFA is now disabled until they re-enrol).
- The audit row is tamper-evident via the hash chain. The `reason` field
  ends up in the envelope-encrypted `after` blob on the audit row.
