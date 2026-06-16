# Shared-DB option — single instance, V2 + SPVT (SVT-SHARED-DB-2026-06)

The expert-recommended alternative to the `crm_*` mirror **for the same-company, same-instance, SPVT-read-only case**. Eliminates the sync pipeline + staleness: SPVT reads V2 **live** through a stable view contract and keeps only its own overlay locally, with a **DB-enforced** read-only guarantee on V2.

> **Status: design + scripts, NOT applied.** It requires co-locating both DBs on one Postgres instance (today V2 is on DigitalOcean, SPVT on `:7654` — two servers). Ripping out the working mirror before that would break the app. Apply when you co-locate; the mirror keeps running until then.

## When this beats the mirror
- ✅ Same company, **one Postgres instance**, SPVT is a read + overlay consumer, freshness matters, small team.
- ❌ Keep the **mirror** instead if: the two stay on separate servers (you literally can't cross-schema join), V2's uptime/locks must be isolated from SPVT, or you want fully independent deploy/scale. Then mirror or a V2 API are the only options.

## Architecture
```
one Postgres instance
├── schema core       ← V2 owns + writes (untouched by SPVT)
├── schema core_pub   ← V2-owned VIEWS = stable contract (SPVT reads ONLY these)
└── schema spv        ← SPVT owns: lead_overlay + lead_fee (+ RLS, audit)
roles: core_owner (V2)  ·  spv_app (SELECT core_pub, full spv, NO write on core)
```
`spv.lead_fee.core_lead_id` / `lead_overlay.core_lead_id` reference V2's `Lead.id`
(soft ref by default → V2 stays free to evolve; swap to a real cross-schema FK if you
accept the coupling). SPVT joins `core_pub.*` + `spv.*` in one query — fresh, indexed.

## Prerequisite: co-locate
1. Provision one Postgres instance (or use V2's instance).
2. V2's schema becomes `core` on it (rename `public`→`core`, or keep `public` and adjust the view DDL).
3. Add `core_pub` + `spv` schemas there (scripts below).

## Apply order
1. `01-roles-schemas-grants.sql` — as instance admin (roles, schemas, grants, `statement_timeout`/conn caps, revoke write-on-core).
2. `02-core-contract-and-spv-overlay.sql` — Part A views as `core_owner` (verify each column vs V2's live schema); Part B overlay as `spv_app` (fail-closed RLS).

## Code cutover (apps/backend)
Replace the mirror read-path with live reads + overlay:
- **Reads:** `crm-leads.service.ts` — swap `db.crmApplication/crmLead/...` (crm_* tables) for `core_pub.*` views joined with `spv.lead_overlay`/`spv.lead_fee`. Model the views in Prisma as `view` blocks (read-only) + the spv tables as normal models, OR read core_pub via `$queryRaw` and keep Prisma for the spv overlay.
- **Writes:** fees/status/notes/convert now write `spv.*` (was `crm_lead_fees` + crm_leads spv cols).
- **Delete:** `jobs/v2Ingest.ts`, `integrations/v2-mis/*` (pool + queries), the `v2.ingest` cron in `scheduler.ts`, the `crm_*` tables/enums (after data migration), and the **"Sync from V2"** button + `useJobRuns` freshness UI (data is always fresh now — no sync to show).
- **Connection:** SPVT connects to the shared instance as **`spv_app`** (its own pool, separate from V2's). `statement_timeout` is set on the role. Drop the second `pg` pool entirely.

## Data migration (existing overlay → spv)
One-off: copy SPVT-owned data off the mirror, keyed by `v2_lead_id`:
```sql
INSERT INTO spv.lead_overlay (tenant_id, core_lead_id, spv_status, assigned_to_id, spv_notes,
                              student_id, converted_at, converted_by_id, created_at)
SELECT tenant_id, v2_lead_id, spv_status::text::spv.spv_lead_status, assigned_to_id, spv_notes,
       student_id, converted_at, converted_by_id, created_at
FROM crm_leads WHERE deleted_at IS NULL;

INSERT INTO spv.lead_fee (tenant_id, core_lead_id, session_label, amount_minor, currency, due_on,
                          status, paid_at, paid_amount_minor, notes, created_at)
SELECT f.tenant_id, l.v2_lead_id, f.session_label, f.amount_minor, f.currency, f.due_on,
       f.status::text::spv.spv_fee_status, f.paid_at, f.paid_amount_minor, f.notes, f.created_at
FROM crm_lead_fees f JOIN crm_leads l ON l.id = f.lead_id
WHERE f.deleted_at IS NULL;
```

## Rollback / safe cutover
- Keep the `crm_*` mirror + ingest running. Put the read-path behind a flag (`SPV_READ_MODE=mirror|shared`).
- Flip to `shared`, verify list/detail/fees/convert match the mirror, watch V2 instance load + `statement_timeout` hits.
- Only after a clean window: drop `crm_*` tables, the ingest, the V2 pool.

## Tradeoffs (honest)
| | Mirror (current) | Shared-DB (this) |
|---|---|---|
| Freshness | stale between syncs | live |
| Pipeline | ingest job to run/own | none |
| V2 schema change | breaks sync (caught at sync time) | breaks SPVT live unless via `core_pub` views |
| V2 uptime/locks | isolated | shared instance (mitigate: timeouts, caps, replica) |
| Read-only guarantee | app-level `BEGIN READ ONLY` (+ superuser risk) | **DB-enforced role privilege** ✅ |
| Cross-server | works | impossible — needs co-location |

## Decision
Co-located + same team + SPVT read-only → adopt this, retire the mirror. Separate
servers or need V2 isolation/independent scale → keep the mirror (or build a V2 API).
