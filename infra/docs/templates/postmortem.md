# Postmortem — `<incident-title>`

> Template per `infra/docs/runbooks/incident-response.md` Phase 6. Fill within
> 5 business days of incident closure. Blameless — focus on systems, not people.

## Summary

- **Incident ID**: `INC-YYYY-MM-DD-NN`
- **Severity**: SEV-1 / SEV-2 / SEV-3
- **Status**: Closed
- **Detected at** (UTC): `YYYY-MM-DD HH:MM:SSZ`
- **Acknowledged at**: `YYYY-MM-DD HH:MM:SSZ`
- **Mitigated at**: `YYYY-MM-DD HH:MM:SSZ`
- **Resolved at**: `YYYY-MM-DD HH:MM:SSZ`
- **MTTR (detect → mitigate)**: `_h _m`
- **Customer impact**: `<tenants affected, requests dropped, duration>`
- **Data impact**: `<none | corrupted X table | leaked Y records>`
- **Regulator notification required?**: yes / no (link BreachIncident `<id>` if yes)
- **DPO notified?**: yes / no
- **On-call author**: `<name>`

## Timeline (UTC)

| Time | Event | Actor |
|------|-------|-------|
| `HH:MM` | First symptom (e.g. dashboard alert) | system |
| `HH:MM` | Page received | on-call |
| `HH:MM` | Investigation started | on-call |
| `HH:MM` | Hypothesis formed | on-call |
| `HH:MM` | Mitigation applied | on-call |
| `HH:MM` | Verified recovery | on-call |
| `HH:MM` | Customer comms sent | on-call / DPO |
| `HH:MM` | All-clear | on-call |

## Root cause

`<single-sentence root cause + 1-2 paragraphs of detail. Link relevant
commit / PR / log lines / audit IDs.>`

## What went well

- `<observable signals fired correctly>`
- `<runbook accurately described mitigation>`
- `<rollback worked first try>`

## What went badly

- `<missed signal — explain why we didn't catch it earlier>`
- `<runbook gap — what we wish we'd had documented>`
- `<tool failure — pager didn't fire, dashboard misleading, etc.>`

## Where we got lucky

- `<near-miss — what could have made it worse but didn't>`

## Action items

| # | Action | Owner | Due | Severity | Status |
|---|--------|-------|-----|----------|--------|
| 1 | `<concrete, single-deliverable action>` | `<owner>` | `YYYY-MM-DD` | P0/P1/P2 | OPEN |
| 2 | `<add alert for X>` | `<owner>` | `YYYY-MM-DD` | P1 | OPEN |
| 3 | `<update runbook section Y>` | `<owner>` | `YYYY-MM-DD` | P2 | OPEN |

> All P0/P1 items must have a tracking issue + owner within 2 business days
> of postmortem publication.

## Evidence + audit trail

- Audit log IDs spanning incident window: `<from-id ... to-id>`
- BreachIncident: `<id or N/A>`
- Sentry / log links: `<links>`
- Commit landing fix: `<sha>`
- Restore drill executed?: `<no | yes — `infra/docs/test-results/restore-drill-INC-…`>`

## Process check

- [ ] Customer / regulator comms sent within SLA
- [ ] BreachIncident closed (`closed_at` set) if applicable
- [ ] All affected sub-systems' health re-confirmed
- [ ] Action items filed as issues with owners + due dates
- [ ] Postmortem published to engineering channel within 5 business days
