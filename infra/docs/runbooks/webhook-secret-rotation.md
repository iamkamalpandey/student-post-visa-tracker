# Runbook: Webhook signing-secret rotation (Resend)

**Scope:** Rotate the HMAC signing secret that protects our inbound Resend
bounce/complaint webhook endpoint.

| Provider | Env var                  | Endpoint                          | Signature header   | Verifier |
|----------|--------------------------|-----------------------------------|--------------------|----------|
| Resend   | `RESEND_WEBHOOK_SECRET`  | `POST /api/v1/webhooks/resend`    | `svix-signature` (+ `svix-id`, `svix-timestamp`) | [`webhooks.routes.ts › verifySignature`](../../../apps/backend/src/modules/comms/webhooks.routes.ts) |

The secret is **optional** at the Zod env layer (`apps/backend/src/config/env.ts`)
— missing secret => the route rejects in prod / accepts in dev with a warning.
That makes rotation safe to attempt on stage without taking the app down.

> Note (2026-05-19): the Stripe webhook + Checkout integration was removed
> entirely — this product is positioned as information-management / CRM and the
> Payment ledger is manual-entry only. See
> [`decisions/2026-05-19-rip-stripe.md`](../decisions/2026-05-19-rip-stripe.md).

---

## When to rotate

| Trigger | Cadence | Notes |
| --- | --- | --- |
| Scheduled | Annually | Calendar reminder owned by the security lead. Aligns with the JWT-rotation cycle. |
| Incident-driven | Immediately on suspicion of leak | Anyone who handled the secret leaving, accidental commit, secret-store breach, third-party-tool leak (e.g. CI logs, error tracker). |
| Provider-side change | When Resend marks the secret as deprecated, or when the endpoint is recreated in their dashboard. | Provider emails the security contact — do not ignore. |

---

## Cost

**Stop-the-world for the Resend webhook only**, and only briefly:

- Resend events delivered between "old secret deactivated" and "new secret
  deployed" fail signature verification (`401`) and are **auto-retried by
  Resend's Svix-based delivery layer with exponential backoff for ~72 hours**.

So a rotation window of a few minutes is invisible to the business. A window
of hours is still safe (events get redelivered). A window of days risks losing
events at the tail of the retry curve — don't let a rotation stall.

---

## Resend procedure

> Prerequisites: Resend Dashboard access with **admin** on the account;
> secret-store write access; ability to roll backend instances. Resend uses
> Svix-style signatures (`v1,<base64>` parts in `svix-signature`, signed over
> `${svix-id}.${svix-timestamp}.${rawBody}`) — see
> [`webhooks.routes.ts:43-74`](../../../apps/backend/src/modules/comms/webhooks.routes.ts).

### 1. Rotate the signing secret in the Resend Dashboard

1. Resend Dashboard -> **Webhooks**.
2. Select the endpoint (e.g. `https://api.example.com/api/v1/webhooks/resend`).
3. Click **Rotate signing secret** (or delete + recreate the endpoint if the
   tenant has no rotation control).
4. Copy the new secret. Resend's secret is **base64** — the verifier expects
   that and decodes via `Buffer.from(SECRET, 'base64')`
   ([`webhooks.routes.ts:58`](../../../apps/backend/src/modules/comms/webhooks.routes.ts)).
   If Resend gives you `whsec_<base64>`, strip the `whsec_` prefix before
   storing.

Resend / Svix does **not** support a dual-secret grace window — there is a
true cutover. Plan the rotation alongside the backend restart and keep the
gap short.

### 2. Update `RESEND_WEBHOOK_SECRET` in the secret store

- Push the new value. Tag the prior revision `pre-rotation-<UTC-date>`.

### 3. Roll the backend

Rolling restart. Until every pod has the new secret, the un-restarted pods
will `401` Resend deliveries (signature mismatch). Resend retries failed
deliveries on the Svix exponential schedule (~72h total), so a
30-second to 30-minute rolling restart is invisible to compliance:
bounces and complaints buffered during the gap are redelivered once every
pod is happy.

Smoke-test with Resend Dashboard -> endpoint -> **Send test event** ->
`email.bounced`. Expect a `200 OK` and the absence of
`webhooks/resend: signature verification failed` in the backend logs.

### 4. Write the audit row

```sql
INSERT INTO audit_logs (action, entity_type, entity_id, actor_id, tenant_id, metadata, created_at)
VALUES ('webhook.resend.secret_rotated', 'system', NULL,
        '<operator_user_id>', NULL,
        jsonb_build_object('reason', '<scheduled|incident|provider-side>',
                           'rolled_at_utc', now()::text),
        now());
```

---

## Recovery if the rotation fails

Symptoms: backend logs are full of `webhooks/resend: signature
verification failed`; Resend dashboard shows endpoint deliveries
failing with `401`.

1. **Roll back the env.** Restore the `pre-rotation-<UTC-date>` revision of
   the secret in the secret store.
2. **Restart** the backend (rolling).
3. **Confirm** in logs that signature verification succeeds again.
4. **Replay window:** Resend auto-retries failed deliveries for ~72h on
   exponential backoff. Nothing operator-driven is required — events land as
   soon as the secret is correct again. The Resend dashboard also exposes a
   **Replay** action per attempt.
5. **File a post-mortem** for any rollback. Re-attempt the rotation only
   after the root cause is understood (almost always: wrong secret pasted,
   `whsec_` prefix not stripped, or PEM-style `\n` escaping applied to a
   non-PEM secret).

---

## Post-rotation checklist

- [ ] Resend Dashboard endpoint health: last 100 deliveries show `2xx`.
- [ ] No `signature verification failed` warnings in backend logs over the
      last 1 hour.
- [ ] Audit row `webhook.resend.secret_rotated` exists for this UTC date.
- [ ] Prior secret-store revision is tagged `pre-rotation-<UTC-date>`; ticket
      filed to delete that snapshot after 30 days.
- [ ] Calendar reminder set for the next scheduled rotation (T + 12 months).
