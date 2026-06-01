// Commission rate resolver for super-agents.
//
// Picks the most-specific applicable SuperAgentCommissionRule for an
// (institution, optional program-level, asOf-date) tuple, walking from most
// specific → least specific:
//
//   1. (super_agent, institution, program_level)  — fully scoped
//   2. (super_agent, institution, NULL)           — institution override
//   3. (super_agent, NULL,        program_level)  — program-level default
//   4. (super_agent, NULL,        NULL)           — flat default rule
//
// Each candidate is filtered by effective_from <= asOf <= (effective_to OR ∞).
// Returns null when no rule applies; the caller then falls back to
// SuperAgent.default_commission_pct, then Institution.commission_pct.

import type { Prisma, PrismaClient } from '@prisma/client';

export type ResolverDb = PrismaClient | Prisma.TransactionClient;

export type ResolveOpts = {
  superAgentId: string;
  institutionId: string;
  programLevel?: string | null;
  asOf: Date;
};

export type ResolveResult = {
  commissionPct: number;
  currency: string;
  ruleId: string | null;
};

/**
 * Resolve the commission rate to apply to a (super-agent, institution,
 * program-level, date) combination. Returns null when no SuperAgentCommissionRule
 * matches — caller should fall back to the super-agent default, then the
 * institution default.
 */
export async function resolveCommissionRate(
  db: ResolverDb,
  tenantId: string,
  opts: ResolveOpts,
): Promise<ResolveResult | null> {
  const { superAgentId, institutionId, programLevel, asOf } = opts;

  // Pull every potentially-applicable rule in one round-trip and pick the most
  // specific in JS. The candidate set is narrow (per super-agent) so this
  // wins over four sequential SELECTs.
  const candidates = await db.superAgentCommissionRule.findMany({
    where: {
      tenant_id: tenantId,
      super_agent_id: superAgentId,
      AND: [
        // Effective window: from <= asOf AND (to IS NULL OR to >= asOf)
        { effective_from: { lte: asOf } },
        {
          OR: [{ effective_to: null }, { effective_to: { gte: asOf } }],
        },
        // Institution scope: matching institution_id OR institution_id IS NULL
        // (= rule applies to every institution).
        {
          OR: [{ institution_id: institutionId }, { institution_id: null }],
        },
      ],
    },
    orderBy: [{ effective_from: 'desc' }],
    select: {
      id: true,
      institution_id: true,
      program_level: true,
      commission_pct: true,
      currency: true,
    },
  });

  if (candidates.length === 0) return null;

  // Specificity score: institution match (+2) + program-level match (+1).
  // Higher = more specific.
  const normalisedLevel = programLevel ?? null;
  let best:
    | (typeof candidates)[number] & { _score: number }
    | null = null;
  for (const c of candidates) {
    const instMatch = c.institution_id === institutionId;
    const levelMatch =
      normalisedLevel != null && c.program_level === normalisedLevel;
    // Drop rules whose program_level is set but doesn't match the request.
    // (A program-level-scoped rule must NOT win when the level is wrong.)
    if (c.program_level != null && c.program_level !== normalisedLevel) continue;

    const score = (instMatch ? 2 : 0) + (levelMatch ? 1 : 0);
    if (!best || score > best._score) {
      best = { ...c, _score: score };
    }
  }

  if (!best) return null;
  return {
    commissionPct: Number(best.commission_pct.toString()),
    currency: best.currency,
    ruleId: best.id,
  };
}
