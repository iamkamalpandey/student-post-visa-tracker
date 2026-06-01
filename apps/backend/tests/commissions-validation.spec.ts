import { describe, it, expect } from 'vitest';

import {
  CommissionListQuery,
  CommissionStatusEnum,
  DisputeRequest,
  InvoiceRequest,
  MarkPaidRequest,
  UpdateCommissionRequest,
} from '@spv/zod-schemas';

// ============================================================================
// Pure-zod validation tests for the commissions module. No backend stack.
// ============================================================================

describe('CommissionStatusEnum', () => {
  it('lists every Postgres CommissionStatus value', () => {
    expect(CommissionStatusEnum.options).toEqual([
      'PENDING',
      'CLAIMED',
      'INVOICED',
      'PAID',
      'DISPUTED',
      'WAIVED',
    ]);
  });
});

describe('MarkPaidRequest', () => {
  it('accepts a minimal payload (paid_on only)', () => {
    const r = MarkPaidRequest.safeParse({ paid_on: '2026-05-14' });
    expect(r.success).toBe(true);
  });

  it('accepts paid_on + payment_reference', () => {
    const r = MarkPaidRequest.safeParse({
      paid_on: '2026-05-14',
      payment_reference: 'BACS-99887766',
    });
    expect(r.success).toBe(true);
  });

  it('rejects missing paid_on', () => {
    expect(MarkPaidRequest.safeParse({}).success).toBe(false);
    expect(MarkPaidRequest.safeParse({ payment_reference: 'X' }).success).toBe(false);
  });

  it('rejects malformed paid_on (not ISO 8601 date)', () => {
    expect(MarkPaidRequest.safeParse({ paid_on: '14/05/2026' }).success).toBe(false);
    expect(MarkPaidRequest.safeParse({ paid_on: '2026-05-14T00:00:00Z' }).success).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    const r = MarkPaidRequest.safeParse({ paid_on: '2026-05-14', extra: true });
    expect(r.success).toBe(false);
  });

  it('rejects payment_reference longer than 120 chars', () => {
    const r = MarkPaidRequest.safeParse({
      paid_on: '2026-05-14',
      payment_reference: 'x'.repeat(121),
    });
    expect(r.success).toBe(false);
  });
});

describe('InvoiceRequest', () => {
  it('accepts an empty body (server auto-generates invoice_no)', () => {
    const r = InvoiceRequest.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.invoice_no).toBeUndefined();
  });

  it('accepts a custom invoice_no', () => {
    const r = InvoiceRequest.safeParse({ invoice_no: 'COM-2026-05-000042' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.invoice_no).toBe('COM-2026-05-000042');
  });

  it('rejects empty invoice_no string', () => {
    expect(InvoiceRequest.safeParse({ invoice_no: '' }).success).toBe(false);
  });

  it('rejects invoice_no longer than 60 chars', () => {
    expect(InvoiceRequest.safeParse({ invoice_no: 'A'.repeat(61) }).success).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(InvoiceRequest.safeParse({ invoice_no: 'X', other: 1 }).success).toBe(false);
  });
});

describe('DisputeRequest', () => {
  it('accepts a minimal valid reason (1 char)', () => {
    const r = DisputeRequest.safeParse({ dispute_reason: 'x' });
    expect(r.success).toBe(true);
  });

  it('rejects an empty dispute_reason', () => {
    expect(DisputeRequest.safeParse({ dispute_reason: '' }).success).toBe(false);
  });

  it('rejects missing dispute_reason', () => {
    expect(DisputeRequest.safeParse({}).success).toBe(false);
  });

  it('rejects dispute_reason longer than 2000 chars', () => {
    expect(DisputeRequest.safeParse({ dispute_reason: 'x'.repeat(2001) }).success).toBe(false);
    expect(DisputeRequest.safeParse({ dispute_reason: 'x'.repeat(2000) }).success).toBe(true);
  });

  it('rejects unknown keys (strict)', () => {
    expect(DisputeRequest.safeParse({ dispute_reason: 'r', extra: 1 }).success).toBe(false);
  });
});

describe('UpdateCommissionRequest', () => {
  it('accepts an empty patch (no-op)', () => {
    expect(UpdateCommissionRequest.safeParse({}).success).toBe(true);
  });

  it('coerces amount_minor to bigint and accepts numeric string', () => {
    const r = UpdateCommissionRequest.safeParse({ amount_minor: '12500' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.amount_minor).toBe(12500n);
  });

  it('rejects negative amount_minor', () => {
    expect(UpdateCommissionRequest.safeParse({ amount_minor: '-1' }).success).toBe(false);
  });

  it('accepts well-formed commission_pct', () => {
    expect(UpdateCommissionRequest.safeParse({ commission_pct: '12.50' }).success).toBe(true);
    expect(UpdateCommissionRequest.safeParse({ commission_pct: '0' }).success).toBe(true);
  });

  it('rejects malformed commission_pct', () => {
    expect(UpdateCommissionRequest.safeParse({ commission_pct: '12.345' }).success).toBe(false);
    expect(UpdateCommissionRequest.safeParse({ commission_pct: 12.5 }).success).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(
      UpdateCommissionRequest.safeParse({ status: 'PAID' }).success,
    ).toBe(false);
  });
});

describe('CommissionListQuery', () => {
  it('coerces limit and accepts valid filters', () => {
    const r = CommissionListQuery.safeParse({
      limit: '50',
      status: 'PAID',
      claimed_from: '2026-01-01',
      claimed_to: '2026-12-31',
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.limit).toBe(50);
      expect(r.data.status).toBe('PAID');
    }
  });

  it('rejects unknown filter keys (strict)', () => {
    expect(CommissionListQuery.safeParse({ paid_when: '2026-01-01' }).success).toBe(false);
  });

  it('rejects malformed UUID filters', () => {
    expect(CommissionListQuery.safeParse({ student_id: 'nope' }).success).toBe(false);
  });
});
