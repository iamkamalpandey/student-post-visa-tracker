# Runbook: Incident response (security / privacy)

**Owner:** Security on-call (primary) + Data Protection Officer (privacy escalation).
**Trigger:** Any of: suspected unauthorised access, confirmed data exposure, ransomware, prolonged service outage with PII risk, or regulator inquiry.

## Phase 1 — Triage (target: 30 min)

1. **Acknowledge** the alert in `#sec-incidents`. Assign an Incident Commander (IC).
2. Open a status page entry — "Investigating" — and start a private incident channel.
3. Capture initial evidence: alert payload, screenshots, time of detection.
4. Decide severity (S1 active exfil / S2 contained breach / S3 suspicious anomaly).

## Phase 2 — Contain (target: 60 min)

- **Credential compromise** — rotate the affected user's password, revoke all `RefreshToken` rows for the user, add active access JTIs to `AccessTokenDenylist`.
- **Token leak** — rotate the JWT signing key (`JWT_KID`); old tokens are rejected by the JWKS pin update.
- **Mass data export** — temporarily disable the export endpoints (set `EXPORTS_DISABLED=true` and redeploy) and audit recent `ExportJob` rows for anomalous volume.
- **Compromised admin** — `BYPASSRLS` role credentials in KMS are rotated; revoke the admin's user row; verify the audit chain (`audit_logs_verify`).
- **Active SQLi / RCE** — pull the suspect endpoint behind a maintenance page; preserve logs.

## Phase 3 — Investigate (parallel to remediation)

- Pull the relevant slice of `audit_logs` (filter by `actor_id`, `entity_type`, time window). Decrypt `before_enc`/`after_enc` only with two-person approval; capture the decryption event itself in audit.
- Cross-reference application logs (Pino structured JSON) by `request_id`.
- Snapshot the DB for forensic preservation.
- Engage the Data Protection Officer to assess whether subject data was accessed.

## Phase 4 — Notify (privacy track)

- **Within 24 hours** — internal stakeholders (engineering leads, legal, exec sponsor).
- **Within 72 hours of becoming aware** (GDPR Art. 33) — supervisory authority via `BreachIncident` table + the regulator's portal. The DPO is the responsible filer.
- **Without undue delay** (GDPR Art. 34) — affected data subjects, when the breach is likely to result in a high risk to their rights and freedoms.
- Update the `breach_incidents` row with each timestamp.

## Phase 5 — Recover

- Follow the DB restore runbook if data integrity was affected.
- Re-issue MFA secrets for affected users.
- Issue customer comms; offer credit-monitoring or additional safeguards if warranted.

## Phase 6 — Postmortem (target: 5 business days)

- Blameless analysis: timeline, contributing factors, missed detections, what worked.
- Action items with owners and due dates; track to closure in the next quarterly review.
- Update this runbook if the team learned something the runbook didn't already say.

## Templates

- `infra/docs/templates/breach-notification.md` — first-draft user notification (placeholder).
- `infra/docs/templates/dpia.md` — Data Protection Impact Assessment (placeholder).
- `infra/docs/templates/regulator-letter.md` — supervisory authority filing (placeholder).
