// SVT-WAVE17-TENANT-2026-05 — tenant settings service.
//
// Self-service surface scoped to the caller's own tenant. ADMIN-only at the
// route layer; service trusts req.user.tid as the resolved tenant.

// SVT-SEC-RLS-ESCAPE-HATCH-2026-05 — the tenants-table RLS policy requires
// app.tenant_id GUC to be set (escape hatch removed). Controllers call this
// service with the raw prisma client (no GUC set), so RLS filters out the
// row and getMe returned 404 for a valid tenant.
//
// Fix: wrap every DB touch in a transaction that first `set_config`s
// app.tenant_id, then re-runs the query on the SAME connection. RLS is now
// enforced as defense-in-depth on top of the JWT `tid` + `where.id=tenantId`
// filter. Chosen over prismaAdmin (bypass-RLS) because tenants CRUD is not
// an auth primitive (see db.ts:40-41 invariant) — RLS should still guard
// writes so a future caller passing an attacker-controlled tenantId (e.g.
// a "switch tenant" superadmin flow, background job arg, test helper) can
// never cross tenants even if the app-layer filter is forgotten.
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { NotFound } from '../../shared/errors.js';
import { _clearBillingEnabledCache } from '../billing/middleware.js';
import type { UpdateTenantSettingsRequest, TenantSettingsResponse } from '@spv/zod-schemas';

async function withTenantTx<T>(tenantId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

function toResponse(t: {
  id: string;
  name: string;
  legal_name: string | null;
  default_locale: string;
  default_timezone: string;
  default_currency: string;
  data_residency_region: string;
  email_from: string | null;
  billing_enabled: boolean;
}): TenantSettingsResponse {
  return {
    id: t.id,
    name: t.name,
    legal_name: t.legal_name,
    default_locale: t.default_locale,
    default_timezone: t.default_timezone,
    default_currency: t.default_currency,
    data_residency_region: t.data_residency_region,
    email_from: t.email_from,
    billing_enabled: t.billing_enabled,
  };
}

export const tenantSettingsService = {
  async getMe(tenantId: string): Promise<TenantSettingsResponse> {
    const t = await withTenantTx(tenantId, (tx) =>
      tx.tenant.findFirst({ where: { id: tenantId } }),
    );
    if (!t) throw NotFound('Tenant not found');
    return toResponse(t);
  },

  async updateMe(
    tenantId: string,
    input: UpdateTenantSettingsRequest,
    // SVT-IF-MATCH-2026-05 — accepted for controller parity; Tenant has no
    // `version` column so optimistic-concurrency is a no-op here. Field kept
    // in the signature so callers don't break when the column lands later.
    _opts?: { expected?: number },
  ): Promise<TenantSettingsResponse> {
    void _opts;
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data['name'] = input.name;
    if (input.legal_name !== undefined) data['legal_name'] = input.legal_name;
    if (input.default_locale !== undefined) data['default_locale'] = input.default_locale;
    if (input.default_timezone !== undefined) data['default_timezone'] = input.default_timezone;
    if (input.default_currency !== undefined) data['default_currency'] = input.default_currency;
    if (input.email_from !== undefined) data['email_from'] = input.email_from;
    if (input.billing_enabled !== undefined) data['billing_enabled'] = input.billing_enabled;

    if (Object.keys(data).length === 0) return this.getMe(tenantId);
    await withTenantTx(tenantId, (tx) => tx.tenant.update({ where: { id: tenantId }, data }));
    // SVT-BILLING-TOGGLE-2026-05 — bust the per-process billingEnabled cache
    // when the flag flips so /billing/* picks up the new state immediately
    // instead of waiting out the 60s TTL.
    if (input.billing_enabled !== undefined) _clearBillingEnabledCache();
    return this.getMe(tenantId);
  },
};
