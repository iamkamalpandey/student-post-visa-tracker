// SVT-WAVE-BILLING-ADMIN-2026-05 — Playwright E2E for the /billing console.
//
// Covers the cross-tenant admin dashboard:
//   1. Login as admin, ensure billing_enabled=true on the tenant.
//   2. Navigate to /billing.
//   3. Assert the 4 KPI tiles render (Outstanding, Overdue installments,
//      Collections 30d, Refund rate 30d).
//   4. Click through each of the three tabs (Aged debt / Today's receipts /
//      Refund queue) and assert the tab panel renders without an ErrorState.
//
// We don't assert on specific row counts because the dev DB may be empty
// (every tab supports a clean EmptyState that's a valid render). We only
// assert that:
//   - the tab heading/structure exists,
//   - the ErrorState ("Could not load…") does NOT render.

import { test, expect } from '@playwright/test';
import {
  ensureBillingEnabled,
  loginAsAdmin,
  probeStack,
} from './_helpers';

test.describe('Billing admin dashboard (/billing)', () => {
  let skipReason: string | null = null;

  test.beforeAll(async ({ request }) => {
    skipReason = await probeStack(request);
    if (skipReason) return;
    const flipped = await ensureBillingEnabled(request);
    if (!flipped) {
      skipReason = 'Could not flip billing_enabled on the tenant.';
    }
  });

  test.beforeEach(() => {
    test.skip(
      skipReason !== null,
      `Skipping billing-admin flow — ${skipReason ?? ''}. Prereqs: FE+BE up, seeded admin.`,
    );
  });

  test('KPI tiles render and all three tabs are reachable', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto('/billing');

    // Wait for the page header to mount — ListPageShell renders an h4.
    await expect(
      page.getByRole('heading', { name: /^billing$/i }).first(),
    ).toBeVisible({ timeout: 15_000 });

    // Surface a clear failure if the gate kicked us into the EmptyState.
    if (await page.getByText(/billing module is disabled/i).isVisible().catch(() => false)) {
      throw new Error(
        'Billing module is disabled even after PATCH /tenants/me — investigate the API or the helper.',
      );
    }
    if (await page.getByText(/access restricted/i).isVisible().catch(() => false)) {
      throw new Error('Logged-in user is not an admin — check seed data.');
    }

    // ---- KPI tiles (4 of them) ---------------------------------------------
    await expect(page.getByText(/^Outstanding$/i).first()).toBeVisible();
    await expect(page.getByText(/^Overdue installments$/i).first()).toBeVisible();
    await expect(page.getByText(/^Collections \(30d\)$/i).first()).toBeVisible();
    await expect(page.getByText(/^Refund rate \(30d\)$/i).first()).toBeVisible();

    // ---- Aged debt tab (default) -------------------------------------------
    const agedTab = page.getByRole('tab', { name: /aged debt/i });
    await expect(agedTab).toHaveAttribute('aria-selected', 'true');
    // No ErrorState banner. (Empty data is fine — it renders DataTable's
    // EmptyState which uses its own copy.)
    await expect(page.getByText(/could not load aged debt/i)).toHaveCount(0);

    // ---- Today's receipts tab ----------------------------------------------
    await page.getByRole('tab', { name: /today's receipts/i }).click();
    await expect(page.getByRole('tab', { name: /today's receipts/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByText(/could not load payments/i)).toHaveCount(0);

    // ---- Refund queue tab --------------------------------------------------
    await page.getByRole('tab', { name: /refund queue/i }).click();
    await expect(page.getByRole('tab', { name: /refund queue/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByText(/could not load payments/i)).toHaveCount(0);

    // ---- Refresh button (sanity) -------------------------------------------
    const refreshBtn = page.getByRole('button', { name: /refresh billing/i });
    await expect(refreshBtn).toBeVisible();
  });
});
