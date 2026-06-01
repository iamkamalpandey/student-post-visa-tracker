# Runbook: Third-party provider outage

**Owner:** Backend on-call.
**Trigger:** Provider status page reports degraded service, or our health checks against the provider fail.

## Providers in the critical path

| Provider | Used for | Degrade behaviour |
|---|---|---|
| Postgres (Neon / RDS) | Everything | The app cannot serve requests; show a maintenance page at the LB. |
| Redis (Upstash / Elasticache) | Rate limiter, idempotency cache, JTI denylist | Fall back to in-memory stores per instance; user logout no longer revokes globally — accept the risk for the outage window. |
| KMS (AWS KMS / Vault) | Field-level encryption | New encrypted writes fail; reads of existing data continue (DEK is wrapped in storage). Disable any flow that creates new encrypted fields (student create, doc upload) until KMS recovers. |
| ClamAV | Document AV scan | Mark `av_status='ERROR'` and quarantine; do not return the document to clients until a human reviews. New uploads queued. |
| Email / SMS / WhatsApp provider | Outbound comms | Mark messages `FAILED`; surface a banner in the inbox; retry on recovery. |
| Object storage (R2 / S3) | Document storage, exports, imports | Reads/writes fail; do not delete metadata rows. |

## Decision matrix

1. **Is this an outage or a partial degradation?** Check the provider status page and run the health probe (`infra/scripts/probe-providers.sh`).
2. **What user-facing flows are affected?** Disable only those routes. The platform stays up for unaffected work.
3. **Do we have a contractual SLA?** If so, capture the outage window for credit reconciliation.
4. **Is subject data at risk?** If yes (e.g. KMS unavailable means new PII writes might fall back to plaintext) — STOP the affected write path and escalate. Never accept "ship it without encryption for now."

## Communication

- Status page entry within 15 minutes.
- In-app banner via the `/dashboard/banner` endpoint (TODO ship in v2; for now hand-edit the frontend env flag).
- Email to admins for outages > 1 hour.

## Recovery

- Restart workers; verify queues drain (imports, comms).
- Reconcile any dropped data: provider webhooks should re-fire; for ones that don't (Twilio, some webhooks), run `infra/scripts/reconcile-comms.ts` to mark statuses correctly.
- Postmortem if outage exceeded the SLO budget.
