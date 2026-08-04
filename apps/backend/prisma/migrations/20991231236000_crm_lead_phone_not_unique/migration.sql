-- SVT-QA-2026-08 (LEAD-H6) — drop the (tenant_id, phone_number) UNIQUE on crm_leads.
--
-- Phone number is NOT a valid natural key for applicant data. Real V2 records
-- routinely share one mobile across a family (siblings/spouses applying in the
-- same intake, one WhatsApp number on file). The ingest upsert keys on
-- (tenant_id, v2_lead_id), so the second family member with the same phone
-- takes the CREATE branch, hits P2002 on this unique index, and is dropped by
-- the per-row try/catch in v2Ingest.up(). Every child row of that lead
-- (applications, lead-courses, history, payments, fees) is then skipped by the
-- `if (!leadId) continue` guards.
--
-- Net effect before this fix: an entire visa-accepted applicant silently never
-- appears in the post-visa work queue, and re-syncing never repairs it because
-- the constraint fires again every pass. The FE only reports an aggregate
-- rows_processed count, so nobody sees the loss.
--
-- Dedup remains correct via the (tenant_id, v2_lead_id) unique index, which is
-- the actual source-system identity. Phone keeps a NON-unique index so
-- lookup-by-phone stays fast.

DROP INDEX IF EXISTS crm_lead_phone_uq;

CREATE INDEX IF NOT EXISTS crm_leads_tenant_phone_idx
  ON crm_leads (tenant_id, phone_number);
