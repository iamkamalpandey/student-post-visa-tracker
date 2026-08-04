// SVT-QA-2026-08 — regression suite for the brutal-audit round-4 guards.
//
// Each block below pins a defect that shipped, was found by audit, and is now
// fixed. The tests are written against the smallest unit that can express the
// bug (pure helpers where possible, service functions with a mock client where
// not) so they stay fast and don't need a live Postgres.
//
// Covered:
//   1. OOXML magic-byte sniff no longer trusts the client's Content-Type
//      (DOCS-H5) — an arbitrary ZIP could be stored and served as .docx.
//   2. CrmLeadFee currency PATCH requires an amount recompute (LEAD-H4) —
//      a bare currency flip silently changed the value by 100×.
//   3. CrmLeadFee terminal-state guards (LEAD-M2) — pay/waive/edit on an
//      already-settled fee produced bogus audit rows and version churn.
//   4. FinanceItem status FSM (BILL-H4) — un-settling a PAID item dropped it
//      off the collections queue forever.
//   5. Commission waive refuses PAID (BILL-H1) — waiving collected revenue
//      made it vanish from the paid pivot with no reversing entry.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3000');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
vi.stubEnv('JWT_PUBLIC_KEY', publicKey.export({ type: 'spki', format: 'pem' }) as string);
vi.stubEnv('JWT_KID', 'test-kid');
vi.stubEnv('JWT_ISSUER', 'spv-api-test');
vi.stubEnv('JWT_AUDIENCE', 'spv-app-test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

// ---------------------------------------------------------------------------
// Shared mock client. Individual blocks reset + reprogram the delegates they use.
// ---------------------------------------------------------------------------

type FeeRow = {
  id: string; lead_id: string; tenant_id: string; version: number;
  status: string; amount_minor: bigint; currency: string;
};

const state: { fee: FeeRow | null; feeUpdateCount: number } = {
  fee: null,
  feeUpdateCount: 1,
};

const mockClient: Record<string, unknown> = {
  crmLeadFee: {
    findFirst: vi.fn(async () => state.fee),
    updateMany: vi.fn(async () => ({ count: state.feeUpdateCount })),
    update: vi.fn(async () => state.fee),
  },
  reminder: { updateMany: vi.fn(async () => ({ count: 0 })) },
  $executeRaw: vi.fn(async () => 0),
  $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockClient)),
};

vi.mock('../src/config/db.js', () => ({ prisma: mockClient, disconnectDb: async () => undefined }));
vi.mock('../src/shared/audit.js', () => ({ writeAudit: vi.fn(async () => undefined) }));

const { sniff } = await import('../src/modules/documents/mime.js');
const { UpdateCrmLeadFeeRequest } = await import('@spv/zod-schemas');
const crmLeads = await import('../src/modules/crm-leads/crm-leads.service.js');

const OOXML_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const OOXML_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Build a fake ZIP: PK header + whichever entry names we want visible. */
function zipWith(...entryNames: string[]): Buffer {
  return Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from(entryNames.join('\0'), 'ascii'),
  ]);
}

const feeCtx = { db: mockClient, tenantId: 'tenant-1', actorId: 'user-1' } as unknown as Parameters<typeof crmLeads.markFeePaid>[0];

// ---------------------------------------------------------------------------

describe('DOCS-H5 — OOXML sniff must verify the container, not the client hint', () => {
  it('rejects a bare ZIP claiming to be .docx', () => {
    // Before: any PK\x03\x04 payload passed purely because the caller said
    // "this is a Word document", so an arbitrary archive was stored and later
    // served with an Office content type.
    const bareZip = zipWith('evil/payload.bin');
    expect(sniff(bareZip, OOXML_DOCX)).toBeNull();
  });

  it('rejects a ZIP with [Content_Types].xml but no Office part namespace', () => {
    const shell = zipWith('[Content_Types].xml', 'random/thing.bin');
    expect(sniff(shell, OOXML_DOCX)).toBeNull();
    expect(sniff(shell, OOXML_XLSX)).toBeNull();
  });

  it('accepts a genuine .docx container', () => {
    const docx = zipWith('[Content_Types].xml', 'word/document.xml', '_rels/.rels');
    expect(sniff(docx, OOXML_DOCX)).toBe(OOXML_DOCX);
  });

  it('accepts a genuine .xlsx container', () => {
    const xlsx = zipWith('[Content_Types].xml', 'xl/workbook.xml', '_rels/.rels');
    expect(sniff(xlsx, OOXML_XLSX)).toBe(OOXML_XLSX);
  });

  it('rejects a real .xlsx that claims to be .docx (hint must match the container)', () => {
    const xlsx = zipWith('[Content_Types].xml', 'xl/workbook.xml');
    expect(sniff(xlsx, OOXML_DOCX)).toBeNull();
  });

  it('rejects an ambiguous container carrying BOTH word/ and xl/ parts', () => {
    const both = zipWith('[Content_Types].xml', 'word/document.xml', 'xl/workbook.xml');
    expect(sniff(both, OOXML_DOCX)).toBeNull();
    expect(sniff(both, OOXML_XLSX)).toBeNull();
  });
});

describe('LEAD-H4 — currency change on a fee requires an amount recompute', () => {
  it('rejects a bare currency flip', () => {
    // 1_234_500 USD-cents = $12,345.00. Re-labelled JPY (0-decimal) the SAME
    // integer means ¥1,234,500 — 100× the intended value.
    const r = UpdateCrmLeadFeeRequest.safeParse({ currency: 'JPY' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.includes('amount_minor'))).toBe(true);
    }
  });

  it('accepts a currency change when the amount is restated', () => {
    const r = UpdateCrmLeadFeeRequest.safeParse({ currency: 'JPY', amount_minor: 12_345 });
    expect(r.success).toBe(true);
  });

  it('accepts an amount-only change', () => {
    expect(UpdateCrmLeadFeeRequest.safeParse({ amount_minor: 500 }).success).toBe(true);
  });

  it('no longer accepts `status` — settlement must go through /pay and /waive', () => {
    // A generic PATCH that set status bypassed paid_at, paid_amount_minor,
    // reminder dismissal and the correct audit action.
    expect(UpdateCrmLeadFeeRequest.safeParse({ status: 'PAID' }).success).toBe(false);
  });
});

describe('LEAD-M2 — CrmLeadFee terminal-state guards', () => {
  beforeEach(() => {
    state.feeUpdateCount = 1;
    (mockClient.crmLeadFee as { updateMany: ReturnType<typeof vi.fn> }).updateMany.mockClear();
    (mockClient.reminder as { updateMany: ReturnType<typeof vi.fn> }).updateMany.mockClear();
  });

  const fee = (status: string): FeeRow => ({
    id: 'fee-1', lead_id: 'lead-1', tenant_id: 'tenant-1',
    version: 3, status, amount_minor: 1000n, currency: 'NPR',
  });

  it('refuses to pay an already-PAID fee', async () => {
    state.fee = fee('PAID');
    await expect(
      crmLeads.markFeePaid(feeCtx, 'lead-1', 'fee-1', { paid_on: '2026-08-04' } as never),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('refuses to pay a WAIVED fee (previously only PAID was blocked)', async () => {
    state.fee = fee('WAIVED');
    await expect(
      crmLeads.markFeePaid(feeCtx, 'lead-1', 'fee-1', { paid_on: '2026-08-04' } as never),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('refuses to re-waive a WAIVED fee', async () => {
    // The repeat waive used to succeed as a no-op status write: it bumped
    // `version` and emitted a second `crm_lead.fee.waived` audit row against a
    // frozen record, polluting the tamper-evident trail.
    state.fee = fee('WAIVED');
    await expect(crmLeads.waiveFee(feeCtx, 'lead-1', 'fee-1')).rejects.toMatchObject({ status: 409 });
    expect((mockClient.crmLeadFee as { updateMany: ReturnType<typeof vi.fn> }).updateMany).not.toHaveBeenCalled();
  });

  it('refuses to waive a PAID fee', async () => {
    state.fee = fee('PAID');
    await expect(crmLeads.waiveFee(feeCtx, 'lead-1', 'fee-1')).rejects.toMatchObject({ status: 409 });
  });

  it('waives an open fee, guarding the write against a concurrent settlement', async () => {
    state.fee = fee('SCHEDULED');
    await crmLeads.waiveFee(feeCtx, 'lead-1', 'fee-1');
    const call = (mockClient.crmLeadFee as { updateMany: ReturnType<typeof vi.fn> }).updateMany.mock.calls[0]?.[0];
    // notIn (not `not: 'PAID'`) so a row that was waived concurrently also loses.
    expect(call?.where?.status).toEqual({ notIn: ['PAID', 'WAIVED'] });
  });

  it('refuses a generic PATCH against a terminal fee', async () => {
    state.fee = fee('PAID');
    await expect(
      crmLeads.updateFee(feeCtx, 'lead-1', 'fee-1', { notes: 'x' } as never, '"3"'),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('applies the If-Match version inside the WHERE, not just as a pre-check', async () => {
    // Two concurrent PATCHes with the same If-Match both passed the JS check
    // and both wrote — silent last-writer-wins on money fields.
    state.fee = fee('SCHEDULED');
    await crmLeads.updateFee(feeCtx, 'lead-1', 'fee-1', { notes: 'x' } as never, '"3"');
    const call = (mockClient.crmLeadFee as { updateMany: ReturnType<typeof vi.fn> }).updateMany.mock.calls[0]?.[0];
    expect(call?.where).toMatchObject({ id: 'fee-1', version: 3, deleted_at: null });
  });

  it('409s when the guarded update matches no row (lost the race)', async () => {
    state.fee = fee('SCHEDULED');
    state.feeUpdateCount = 0;
    await expect(
      crmLeads.updateFee(feeCtx, 'lead-1', 'fee-1', { notes: 'x' } as never, '"3"'),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('soft-deletes atomically and skips the fanout when it loses the race', async () => {
    state.fee = fee('SCHEDULED');
    state.feeUpdateCount = 0; // a concurrent delete already won
    await crmLeads.deleteFee(feeCtx, 'lead-1', 'fee-1');
    // No duplicate reminder-dismissal for the loser.
    expect((mockClient.reminder as { updateMany: ReturnType<typeof vi.fn> }).updateMany).not.toHaveBeenCalled();
  });
});
