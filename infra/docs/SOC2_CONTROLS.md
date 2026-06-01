# SVT SOC 2 Type II Controls Matrix (CC1–CC9)

> Mapping each Trust Services Criteria control to the SVT artefact that
> evidences it. Evidence pipeline (CC4.x monitoring + CC9.2 vendor mgmt
> automation) is on the roadmap; this document is the inventory of what
> exists today and what to demonstrate to an auditor.

Last reviewed: 2026-05-18.

## CC1 — Control Environment (COSO)

| Sub | Evidence | Location |
|-----|----------|----------|
| CC1.1 | Code of conduct / engineering values | `infra/docs/architecture-decisions.md` |
| CC1.2 | Board / management oversight (single-founder org — N/A; record in management memo when team grows) | N/A v1 |
| CC1.3 | Org structure / reporting lines | `.github/CODEOWNERS` |
| CC1.4 | Hiring / competency (out of scope: tracked in HR system) | N/A v1 |
| CC1.5 | Accountability for control performance | PR template "Security checklist" |

## CC2 — Communication & Information

| Sub | Evidence | Location |
|-----|----------|----------|
| CC2.1 | Quality information identified, captured, used | Structured pino logging (`apps/backend/src/config/logger.ts`) + audit log chain (`apps/backend/src/shared/audit.ts`) |
| CC2.2 | Internal communication of policies | `SECURITY.md`, this doc, runbooks under `infra/docs/runbooks/` |
| CC2.3 | External communication of relevant matters | Public DPO contact (TODO: publish at `/.well-known/dpo`), breach-notification template `infra/docs/templates/breach-notification.md` |

## CC3 — Risk Assessment

| Sub | Evidence | Location |
|-----|----------|----------|
| CC3.1 | Objectives set | `infra/docs/PRODUCTION_CHECKLIST.md` |
| CC3.2 | Identify + analyse risk | `infra/docs/THREAT_MODEL.md` |
| CC3.3 | Fraud risk assessment (financial) | Billing concurrency tests (Wave 4 backlog) + `apps/backend/src/jobs/billingDaily.ts` |
| CC3.4 | Identify + assess significant change | ADR-style PRs gated via CODEOWNERS |

## CC4 — Monitoring Activities

| Sub | Evidence | Location |
|-----|----------|----------|
| CC4.1 | Ongoing + separate evaluations | Daily `audit.chain.verify` job (`apps/backend/src/jobs/scheduler.ts`) |
| CC4.2 | Communicate deficiencies | TODO: alert routing (`infra/docs/runbooks/alerts.md`) — currently logs only |

## CC5 — Control Activities

| Sub | Evidence | Location |
|-----|----------|----------|
| CC5.1 | Selects + develops control activities | RBAC matrix in `apps/backend/src/middlewares/auth.ts` |
| CC5.2 | Selects + develops general controls over technology | Helmet headers, Zod input validation, FSM gates (`apps/backend/src/shared/fsm.ts`) |
| CC5.3 | Deploys via policies + procedures | `.github/workflows/*` + `infra/docs/runbooks/` |

## CC6 — Logical & Physical Access

| Sub | Evidence | Location |
|-----|----------|----------|
| CC6.1 | Restrict logical access | JWT RS256 + JTI denylist (`apps/backend/src/modules/auth/`) |
| CC6.2 | Authentication | Argon2id passwords (`apps/backend/src/shared/passwords.ts`); MFA TOTP |
| CC6.3 | Authorise access | RBAC + Postgres RLS (every tenant-scoped table) |
| CC6.4 | Restrict physical access (cloud-hosted) | Inherited from cloud provider SOC 2 |
| CC6.5 | Discontinue access | `users.service.softDelete` + access-token denylist on logout |
| CC6.6 | External access — secure | TLS termination at proxy + HSTS (`apps/frontend/middleware.ts`) |
| CC6.7 | Transmission of sensitive info | Envelope encryption AES-256-GCM (`apps/backend/src/shared/encryption.ts`) for PII at rest |
| CC6.8 | Anti-malware (file uploads) | ClamAV scan on every Document upload (`apps/backend/src/modules/documents/av.ts`) |

## CC7 — System Operations

| Sub | Evidence | Location |
|-----|----------|----------|
| CC7.1 | Vulnerability detection | osv-scanner + Trivy in `.github/workflows/security.yml`, Dependabot |
| CC7.2 | Anomaly monitoring | TODO: Prometheus metrics endpoint (`infra/docs/runbooks/alerts.md` placeholder) |
| CC7.3 | Security events evaluated | Audit log hash chain + `audit.chain.verify` cron; BreachIncident workflow (`apps/backend/src/modules/breach/`) |
| CC7.4 | Incident response plan | `infra/docs/runbooks/incident-response.md` |
| CC7.5 | Recovery from incidents | `infra/scripts/restore_drill.sh` |

## CC8 — Change Management

| Sub | Evidence | Location |
|-----|----------|----------|
| CC8.1 | Authorise + design changes | `.github/CODEOWNERS` (auth, audit, billing under @kamal) |
| CC8.1 | Test before deploy | CI: typecheck + vitest + supertest + Trivy (688/688 green gate) |
| CC8.1 | Document + approve changes | PR template + branch protection on `main` |

## CC9 — Risk Mitigation

| Sub | Evidence | Location |
|-----|----------|----------|
| CC9.1 | Identify + mitigate disruption | Restore drill (`infra/scripts/restore_drill.sh`) + cross-region backup policy in `infra/docs/ENVIRONMENTS.md` |
| CC9.2 | Vendor risk management | SubProcessor register + `/api/v1/admin/ropa` (Art 30 + Art 28(2)) |

## Open gaps to close before SOC 2 Type II audit

1. **CC4.2**: alert routing (Sentry + on-call paging) — currently logs-only.
2. **CC7.2**: Prometheus / OTLP metrics endpoint — not yet implemented.
3. **CC8.1**: change-management evidence (every prod deploy → tagged release + signed image via cosign).
4. **CC9.1**: quarterly restore drill execution log under `infra/docs/test-results/`.
5. **Risk register** quarterly review (template at `infra/docs/templates/risk-register.md` — TODO).
6. **Access review** quarterly snapshot at `infra/docs/test-results/access-review-YYYY-Q.csv` — TODO.
