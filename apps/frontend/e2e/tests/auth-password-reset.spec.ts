// SVT-SEC-2026-05 — Playwright E2E for the self-service password reset flow.
//
// Two paths covered:
//   1. /forgot-password → submit known seed admin email → assert the generic
//      anti-enumeration confirmation renders (NEVER reveals if the address
//      exists).
//   2. /reset-password?token=<bogus> → submit any valid-shape password →
//      assert the "invalid or expired" Alert appears.
//
// Notes:
//   - Both pages are public, so no login is needed.
//   - The first path is robust against the backend being down because the FE
//     swallows non-422 errors and always shows the generic success — we still
//     skip the suite when the dev stack is unreachable so we don't false-pass
//     on a totally broken environment.

import { test, expect } from '@playwright/test';
import { ADMIN_EMAIL, probeStack } from './_helpers';

test.describe('Password reset', () => {
  let skipReason: string | null = null;
  test.beforeAll(async ({ request }) => {
    skipReason = await probeStack(request);
  });
  test.beforeEach(() => {
    test.skip(
      skipReason !== null,
      `Dev stack not reachable — ${skipReason ?? ''}. Prereqs: FE on 3001, BE on 4000, seeded admin.`,
    );
  });

  test('forgot-password shows the generic confirmation for a known email', async ({
    page,
  }) => {
    await page.goto('/forgot-password');
    await expect(
      page.getByRole('heading', { name: /reset your password/i }),
    ).toBeVisible();

    await page
      .locator('input[type="email"], input[id="forgot-email"]')
      .first()
      .fill(ADMIN_EMAIL);

    await page.getByRole('button', { name: /send reset link/i }).click();

    // The generic message is rendered both inline as an Alert AND as a
    // notistack snackbar. Asserting the inline Alert is the most stable signal
    // because the snackbar auto-dismisses.
    await expect(
      page.getByText(/if that email exists we sent a reset link/i).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('reset-password rejects a bogus token with an "invalid or expired" alert', async ({
    page,
  }) => {
    // A syntactically plausible but completely fake token. The backend will
    // 401 because it doesn't match any persisted hash.
    const badToken = 'this-token-does-not-exist-' + Date.now().toString(36);
    await page.goto(`/reset-password?token=${badToken}`);
    await expect(
      page.getByRole('heading', { name: /choose a new password/i }),
    ).toBeVisible();

    // Fill in a strong-enough password to clear client-side zod validation
    // (>= 12 chars + matching confirm) so the form actually POSTs and the
    // backend gets a chance to reject the token.
    const pw = 'CorrectHorseBattery!2026';
    await page.locator('input[id="reset-new-password"]').fill(pw);
    await page.locator('input[id="reset-confirm-password"]').fill(pw);
    await page.getByRole('button', { name: /update password/i }).click();

    await expect(
      page.getByText(/reset link invalid or expired/i).first(),
    ).toBeVisible({ timeout: 10_000 });
    // The "Request a new reset link" affordance only appears once tokenError
    // is set — a secondary signal that we hit the error branch and not just
    // the missing-token branch.
    await expect(
      page.getByRole('link', { name: /request a new reset link/i }),
    ).toBeVisible();
  });

  test('reset-password without a token immediately surfaces the missing-token alert', async ({
    page,
  }) => {
    await page.goto('/reset-password');
    await expect(
      page.getByText(/this reset link is missing its token/i).first(),
    ).toBeVisible();
  });
});
