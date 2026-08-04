-- SVT-QA-2026-08 — FinanceItem: partial-payment tracking + optimistic concurrency.
--
-- Two defects this closes:
--
-- 1) LEAD-H5 — silent partial-payment data loss on lead→student convert.
--    CrmLeadFee carries `paid_amount_minor` (markFeePaid can record a payment
--    BELOW the full amount). The convert flow migrated CrmLeadFee → FinanceItem
--    but FinanceItem had no equivalent column, so a fee with
--    amount_minor=1000000 / paid_amount_minor=250000 / status=PAID became a
--    FinanceItem with amount_minor=1000000 / status=PAID — implying the whole
--    10,000 was collected when only 2,500 was. The 7,500 obligation vanished
--    from the ledger with no trace.
--
-- 2) BILL-H3 — FinanceItem update accepted an `expected` (If-Match) version
--    from the controller but had no `version` column to guard against, so the
--    optimistic-concurrency contract was a no-op. Two counsellors correcting
--    the same amount_minor concurrently silently last-writer-wins on a money
--    field.
--
-- Both columns are additive and nullable/defaulted, so existing rows are
-- untouched and the migration is safe to re-run.

ALTER TABLE finance_items
  ADD COLUMN IF NOT EXISTS paid_amount_minor BIGINT;

ALTER TABLE finance_items
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
