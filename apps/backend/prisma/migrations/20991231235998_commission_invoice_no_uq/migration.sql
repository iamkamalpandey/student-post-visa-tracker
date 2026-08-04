-- SVT-QA-2026-08 — commissions.invoice_no unique per tenant.
--
-- `nextInvoiceNumber` mints COM-YYYY-MM-NNNNNN via a per-month count + retry
-- loop. Without a unique index, two concurrent `POST /commissions/:id/invoice`
-- calls in the same millisecond both saw count=N, both minted the same
-- number, both wrote. Downstream reconciliation joined on invoice_no would
-- silently merge the two claims. The retry loop in service.ts is now
-- backed by a real DB constraint that raises P2002; the loop catches and
-- picks the next candidate.
--
-- Partial index (WHERE invoice_no IS NOT NULL) so PENDING/CLAIMED/DISPUTED
-- rows (no invoice_no yet) don't collide on NULL.

CREATE UNIQUE INDEX IF NOT EXISTS commission_claims_tenant_invoice_no_key
  ON commission_claims (tenant_id, invoice_no)
  WHERE invoice_no IS NOT NULL;
