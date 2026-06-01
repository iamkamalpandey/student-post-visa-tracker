// SVT-WAVE17-TENANT-2026-05 — tenant settings service.
//
// Self-service surface scoped to the caller's own tenant. ADMIN-only at the
// route layer; service trusts req.user.tid as the resolved tenant.

import { prisma } from '../../config/db.js';
import { NotFound } from '../../shared/errors.js';
import { _clearBillingEnabledCache } from '../billing/middleware.js';
import type { UpdateTenantSettingsRequest, TenantSettingsResponse } from '@spv/zod-schemas';

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
    const t = await prisma.tenant.findFirst({ where: { id: tenantId } });
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
    await prisma.tenant.update({ where: { id: tenantId }, data });
    // SVT-BILLING-TOGGLE-2026-05 — bust the per-process billingEnabled cache
    // when the flag flips so /billing/* picks up the new state immediately
    // instead of waiting out the 60s TTL.
    if (input.billing_enabled !== undefined) _clearBillingEnabledCache();
    return this.getMe(tenantId);
  },
};
