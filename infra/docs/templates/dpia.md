# Data Protection Impact Assessment (DPIA) — Template

Complete one of these for every new processing activity that involves systematic monitoring, large-scale special-category data, or other GDPR Art. 35(3) triggers. Store the completed DPIA alongside the ROPA entry.

## 1. Processing summary

- **Processing name:**
- **Owner (controller representative):**
- **DPO consulted on:**
- **Legal basis (per Art. 6):**
- **If special category, basis under Art. 9:**

## 2. Description

- **Nature of the processing:** what is collected, how, where, by whom, to whom.
- **Scope:** volume, frequency, geography of subjects.
- **Context:** sensitivity, subject expectations, regulatory environment.
- **Purposes:** specific, explicit, legitimate.

## 3. Necessity and proportionality

- Is each data category necessary for the stated purpose? Yes / no — justify.
- Are retention periods documented? Where (`document_types.retention_days`, `consent_records`, etc.)?
- Are subjects informed via the privacy notice?

## 4. Risks identified

| Risk | Likelihood (L/M/H) | Impact (L/M/H) | Mitigation |
|---|---|---|---|
| Cross-tenant disclosure | L | H | RLS + per-request `SET LOCAL app.tenant_id`. |
| KMS compromise | L | H | Per-tenant DEKs; rotation runbook; HSM in production. |
| Bulk export abuse | M | M | Rate limit + admin step-up + signed single-use URLs + audit. |
| ... | | | |

## 5. Measures

- Technical: encryption, RLS, MFA, rate limits, audit chain, documented in the SECURITY policy.
- Organisational: DPO oversight, training, incident-response runbook, access reviews.
- Legal: DPA with sub-processors, SCC where applicable.

## 6. Residual risk

If any residual risk is **High**, consult the supervisory authority (GDPR Art. 36) before processing begins.

## 7. Decision

- Proceed / Proceed with conditions / Do not proceed.
- Conditions, if any:
- Review date:
- Signed:
