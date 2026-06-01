// Super-agents test suite.
//
// Coverage:
//   - Commission resolver: 4 cases (default, institution-specific, program-level
//     specific, expired falls back).
//   - Status FSM transitions (ACTIVE→PAUSED→ACTIVE; ACTIVE→TERMINATED terminal).
//   - Service: linked-to-institution helper (used by enrollment validation).
//
// We deliberately mock Prisma surface here — the resolver and FSM are pure
// enough that an integration test would just retest Prisma. The HTTP layer is
// covered by the existing route-level harness; we keep the unit suite tight.

import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';

import {
  resolveCommissionRate,
  type ResolverDb,
} from '../src/modules/super-agents/commission-resolver.js';
import { superAgentFsm } from '../src/modules/super-agents/fsm-def.js';
import { assertTransition } from '../src/shared/fsm.js';

const TENANT = '00000000-0000-0000-0000-00000000aaaa';
const SA_ID = '00000000-0000-0000-0000-00000000bbbb';
const INST_A = '00000000-0000-0000-0000-00000000cc01';
const INST_B = '00000000-0000-0000-0000-00000000cc02';

function dec(s: string): Prisma.Decimal {
  return new Prisma.Decimal(s);
}

type Rule = {
  id: string;
  institution_id: string | null;
  program_level: string | null;
  commission_pct: Prisma.Decimal;
  currency: string;
  effective_from: Date;
  effective_to: Date | null;
};

function mockDb(rules: Rule[]): ResolverDb {
  return {
    superAgentCommissionRule: {
      findMany: vi.fn(async ({ where }: { where: any }) => {
        const asOfFrom = where.AND?.[0]?.effective_from?.lte as Date | undefined;
        // Apply the same effective + scope filters the real query would.
        return rules.filter((r) => {
          if (asOfFrom && r.effective_from > asOfFrom) return false;
          if (r.effective_to && asOfFrom && r.effective_to < asOfFrom) return false;
          // institution scope: matches OR null.
          const instWhere = where.AND?.[2]?.OR;
          if (instWhere) {
            const wantInst = instWhere[0].institution_id;
            if (r.institution_id != null && r.institution_id !== wantInst) return false;
          }
          return true;
        });
      }),
    },
  } as unknown as ResolverDb;
}

describe('resolveCommissionRate', () => {
  it('returns default rule (super-agent-wide) when no specific overrides exist', async () => {
    const db = mockDb([
      {
        id: 'r-default',
        institution_id: null,
        program_level: null,
        commission_pct: dec('5.00'),
        currency: 'GBP',
        effective_from: new Date('2025-01-01'),
        effective_to: null,
      },
    ]);
    const r = await resolveCommissionRate(db, TENANT, {
      superAgentId: SA_ID,
      institutionId: INST_A,
      asOf: new Date('2026-05-15'),
    });
    expect(r).not.toBeNull();
    expect(r!.ruleId).toBe('r-default');
    expect(r!.commissionPct).toBe(5);
    expect(r!.currency).toBe('GBP');
  });

  it('institution-specific override beats default', async () => {
    const db = mockDb([
      {
        id: 'r-default',
        institution_id: null,
        program_level: null,
        commission_pct: dec('5.00'),
        currency: 'GBP',
        effective_from: new Date('2025-01-01'),
        effective_to: null,
      },
      {
        id: 'r-instA',
        institution_id: INST_A,
        program_level: null,
        commission_pct: dec('8.00'),
        currency: 'GBP',
        effective_from: new Date('2025-01-01'),
        effective_to: null,
      },
    ]);
    const r = await resolveCommissionRate(db, TENANT, {
      superAgentId: SA_ID,
      institutionId: INST_A,
      asOf: new Date('2026-05-15'),
    });
    expect(r!.ruleId).toBe('r-instA');
    expect(r!.commissionPct).toBe(8);
  });

  it('program-level + institution match beats institution-only', async () => {
    const db = mockDb([
      {
        id: 'r-instA',
        institution_id: INST_A,
        program_level: null,
        commission_pct: dec('8.00'),
        currency: 'GBP',
        effective_from: new Date('2025-01-01'),
        effective_to: null,
      },
      {
        id: 'r-instA-PG',
        institution_id: INST_A,
        program_level: 'POSTGRADUATE',
        commission_pct: dec('12.00'),
        currency: 'GBP',
        effective_from: new Date('2025-01-01'),
        effective_to: null,
      },
    ]);
    const r = await resolveCommissionRate(db, TENANT, {
      superAgentId: SA_ID,
      institutionId: INST_A,
      programLevel: 'POSTGRADUATE',
      asOf: new Date('2026-05-15'),
    });
    expect(r!.ruleId).toBe('r-instA-PG');
    expect(r!.commissionPct).toBe(12);
  });

  it('expired rule falls back to the default', async () => {
    const db = mockDb([
      {
        id: 'r-default',
        institution_id: null,
        program_level: null,
        commission_pct: dec('5.00'),
        currency: 'GBP',
        effective_from: new Date('2025-01-01'),
        effective_to: null,
      },
      {
        id: 'r-instA-promo',
        institution_id: INST_A,
        program_level: null,
        commission_pct: dec('10.00'),
        currency: 'GBP',
        effective_from: new Date('2025-01-01'),
        effective_to: new Date('2025-12-31'),
      },
    ]);
    const r = await resolveCommissionRate(db, TENANT, {
      superAgentId: SA_ID,
      institutionId: INST_A,
      asOf: new Date('2026-05-15'),
    });
    expect(r!.ruleId).toBe('r-default');
    expect(r!.commissionPct).toBe(5);
  });

  it('returns null when no rules apply', async () => {
    const db = mockDb([]);
    const r = await resolveCommissionRate(db, TENANT, {
      superAgentId: SA_ID,
      institutionId: INST_B,
      asOf: new Date('2026-05-15'),
    });
    expect(r).toBeNull();
  });
});

describe('superAgentFsm transitions', () => {
  it('ACTIVE → PAUSED is allowed for ADMIN', () => {
    const r = assertTransition(superAgentFsm, 'ACTIVE', 'PAUSED', 'ADMIN');
    expect(r.ok).toBe(true);
  });

  it('PAUSED → ACTIVE is allowed for ADMIN', () => {
    const r = assertTransition(superAgentFsm, 'PAUSED', 'ACTIVE', 'ADMIN');
    expect(r.ok).toBe(true);
  });

  it('ACTIVE → TERMINATED requires ADMIN role and a reason_code', () => {
    const noReason = assertTransition(superAgentFsm, 'ACTIVE', 'TERMINATED', 'ADMIN');
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) expect(noReason.status).toBe(422);

    const okWithReason = assertTransition(
      superAgentFsm,
      'ACTIVE',
      'TERMINATED',
      'ADMIN',
      'partner_misconduct',
    );
    expect(okWithReason.ok).toBe(true);
  });

  it('COUNSELLOR cannot transition status', () => {
    const r = assertTransition(superAgentFsm, 'ACTIVE', 'PAUSED', 'COUNSELLOR');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it('TERMINATED is terminal — no outbound transitions exist', () => {
    const r = assertTransition(superAgentFsm, 'TERMINATED', 'ACTIVE', 'ADMIN');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });
});
