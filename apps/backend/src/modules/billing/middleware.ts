// SVT-WAVE-BILLING-2026-05 — billingEnabled middleware.
//
// Gates the entire /api/v1/billing/* surface (and /students/:id/billing/*) on
// Tenant.billing_enabled. Consultancy tenants (default) see a 404 — same
// status code as a non-existent route so we don't leak the existence of the
// billing module to non-licensed tenants.
//
// Cached per process for the lifetime of a tenant flag. If the flag is
// toggled in /settings, the change picks up on the next refetch (TanStack
// invalidation already wires /tenants/me; the BE cache TTL is 60s).

import type { NextFunction, Request, Response } from 'express';
import { withTenantTx } from '../../shared/tenantTx.js';
import { NotFound, Unauthorized } from '../../shared/errors.js';
import { logger } from '../../config/logger.js';

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { enabled: boolean; cachedAt: number }>();

export function _clearBillingEnabledCache(): void {
  cache.clear();
}

async function isBillingEnabled(tenantId: string): Promise<boolean> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.cachedAt < CACHE_TTL_MS) return hit.enabled;
  try {
    // SVT-SEC-2026-08 (T0-7) — `tenants` is RLS-scoped (`id = app_current_tenant()`).
    // On the singleton this returned null under the production role, so
    // `billing_enabled` read as false and the whole billing surface 403'd — and
    // the result was then CACHED for the TTL, so it stuck.
    const row = await withTenantTx(tenantId, (tx) => tx.tenant.findFirst({
      where: { id: tenantId },
      select: { billing_enabled: true },
    }));
    const enabled = row?.billing_enabled === true;
    cache.set(tenantId, { enabled, cachedAt: Date.now() });
    return enabled;
  } catch (err) {
    // Fail-closed: when the lookup itself errors, refuse access rather than
    // accidentally exposing the billing surface to a tenant that hasn't opted in.
    logger.error({ err, tenantId }, 'billingEnabled lookup failed; treating as disabled');
    return false;
  }
}

export async function billingEnabled(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) throw Unauthorized();
    const tenantId = req.user.tid;
    const enabled = await isBillingEnabled(tenantId);
    if (!enabled) {
      // 404, not 403 — don't leak that billing exists to non-licensed tenants.
      return next(NotFound('Not found'));
    }
    next();
  } catch (err) {
    next(err);
  }
}
