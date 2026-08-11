-- SVT-FIN-2026-08 — CrmFeeStatus gains PARTIAL so a short payment stays owed.
--
-- markFeePaid() bounded the settled amount from ABOVE (a payment larger than
-- the billed fee is a 422) but wrote `status: 'PAID'` unconditionally. A lead
-- billed 10,000 who paid 2,500 was therefore recorded as PAID with
-- paid_amount_minor = 2,500: the 7,500 shortfall left the open-fee queries
-- (OPEN_FEE_STATUSES = SCHEDULED|DUE|OVERDUE), disappeared from the receivables
-- rollup, and nothing ever chased it. The money was silently forgiven.
--
-- The billing-side FeeInstallment FSM has had PARTIAL since it shipped; only
-- the CRM lead-fee path lacked it. This closes that asymmetry.
--
-- ADD VALUE IF NOT EXISTS is idempotent (Postgres 12+). The value is only
-- ADDED here, never used in this same transaction, which is the restriction
-- that applies to enum additions inside a transaction block.

ALTER TYPE "CrmFeeStatus" ADD VALUE IF NOT EXISTS 'PARTIAL';
