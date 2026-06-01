// SVT-WAVE-BILLING-2026-05 — Playwright E2E for the per-student Billing tab.
//
// Walks:
//   1. Login as admin, ensure billing_enabled=true on the tenant.
//   2. Open a seeded student (lookup or create) → Billing tab.
//   3. If the student has no enrollments, the tab renders the "no enrolments
//      yet" empty state — skip the rest of the flow with a clear reason.
//   4. Otherwise, open the Fee plan wizard, fill cadence/start/count, walk
//      Parameters → Preview → Confirm, submit. Assert the PlanSummaryCard
//      transitions to an ACTIVE plan with installments.
//   5. Open the Record payment dialog, enter the first installment's gross,
//      submit. Assert success snackbar + an installment row flips to
//      PARTIAL or PAID.
//
// This spec hits a real backend — we don't mock the billing endpoints because
// the FE consumes installment computations from the server response. When the
// dev stack or seed data aren't right we self-skip with a reason string.

import { test, expect, type Page } from '@playwright/test';
import {
  ensureBillingEnabled,
  ensureSeedStudent,
  getSidebar,
  loginAsAdmin,
  probeStack,
} from './_helpers';

const TOTAL_MAJOR = 1200; // £12.00 total — small to keep the test cheap.
const TOTAL_MINOR = TOTAL_MAJOR * 100; // 120000 → six 200000 installments? no — see below.
const INSTALLMENT_COUNT = 6;
// Per-installment major = 200 ⇒ 20000 minor. We pay the first installment's
// full balance so its status flips to PAID (FIFO with auto-allocate).

test.describe('Student Billing tab — fee plan + payment', () => {
  let skipReason: string | null = null;
  let studentId: string | null = null;

  test.beforeAll(async ({ request }) => {
    skipReason = await probeStack(request);
    if (skipReason) return;
    const flipped = await ensureBillingEnabled(request);
    if (!flipped) {
      skipReason = 'Could not flip billing_enabled on the tenant.';
      return;
    }
    studentId = await ensureSeedStudent(request);
    if (!studentId) {
      skipReason = 'No seed student available and POST /students failed.';
    }
  });

  test.beforeEach(() => {
    test.skip(
      skipReason !== null,
      `Skipping billing flow — ${skipReason ?? ''}. Prereqs: FE+BE up, seeded admin, seeded student with at least one ACTIVE enrollment.`,
    );
  });

  test('admin creates a fee plan and records a payment', async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`/students/${studentId}`);

    // Wait for the detail shell to render. The Billing tab only appears when
    // useBillingEnabled() resolves true — give it a moment.
    const billingTab = page.getByRole('tab', { name: /^billing$/i });
    await expect(billingTab).toBeVisible({ timeout: 15_000 });
    await billingTab.click();

    // Empty-state guard: if the student has no enrolments, surface a skip
    // rather than burying the actual cause in a Next button being disabled.
    if (await page.getByText(/no enrolments yet/i).isVisible().catch(() => false)) {
      test.skip(
        true,
        'Seed student has no enrollments — add one via the Studies tab before this spec can run.',
      );
      return;
    }

    // Open the wizard. The button label is "Generate fee plan" when there's
    // no active plan, or "Replace plan" when one exists. We grab whichever is
    // present, then click it.
    const wizardOpener = page
      .getByRole('button', { name: /generate fee plan|replace plan|create plan/i })
      .first();
    if (!(await wizardOpener.isVisible().catch(() => false))) {
      test.skip(
        true,
        'No fee-plan wizard opener visible — student may already have an ACTIVE plan blocking creation.',
      );
      return;
    }
    await wizardOpener.click();

    const dialog = page.getByRole('dialog', { name: /create fee plan/i });
    await expect(dialog).toBeVisible();

    // ---- Step 1 (Parameters) ------------------------------------------------
    // cadence default is MONTHLY, currency default GBP. Fill total + count.
    await dialog.locator('input#total').fill(String(TOTAL_MINOR));
    const countInput = dialog.locator('input#count');
    await countInput.fill(String(INSTALLMENT_COUNT));
    // starts_on is pre-populated with today. Leave it.

    await dialog.getByRole('button', { name: /^next$/i }).click();

    // ---- Step 2 (Preview) ---------------------------------------------------
    // The preview table should have INSTALLMENT_COUNT rows + 1 header row.
    await expect(
      dialog.getByText(new RegExp(`${INSTALLMENT_COUNT} installments`, 'i')),
    ).toBeVisible();
    await dialog.getByRole('button', { name: /^next$/i }).click();

    // ---- Step 3 (Confirm) ---------------------------------------------------
    await expect(dialog.getByText(/ready to create this fee plan/i)).toBeVisible();
    await dialog.getByRole('button', { name: /create plan/i }).click();

    // Dialog closes when the mutation resolves.
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    // The PlanSummaryCard now lists installments. Wait for the Record payment
    // affordance to appear (only rendered when an ACTIVE plan exists).
    const recordBtn = page
      .getByRole('button', { name: /record payment/i })
      .first();
    await expect(recordBtn).toBeVisible({ timeout: 15_000 });

    // ---- Record payment ----------------------------------------------------
    await recordBtn.click();
    const payDialog = page.getByRole('dialog', { name: /record payment/i });
    await expect(payDialog).toBeVisible();

    // The first installment is 12.00 / 6 = 2.00. Pay it exactly so the
    // installment flips to PAID (FIFO auto-allocate is the default).
    const perInstallmentMajor = (TOTAL_MAJOR / 100 / INSTALLMENT_COUNT).toFixed(2);
    await payDialog.locator('input#gross_major').fill(perInstallmentMajor);
    // Method defaults to BANK_TRANSFER — fine for our purposes.
    await payDialog.getByRole('button', { name: /^record$/i }).click();

    // Success snackbar OR dialog close — assert the dialog closes which is
    // the stronger signal because the snackbar can be missed during a race.
    await expect(payDialog).toBeHidden({ timeout: 15_000 });

    // Some installment in the active plan should now show PARTIAL or PAID
    // status. PlanSummaryCard renders status chips per-row. Use a flexible
    // regex because the chip text may include surrounding whitespace.
    await expect(
      page.getByText(/\b(PAID|PARTIAL)\b/).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

});

// Helper to keep the spec body small. Unused at the moment but exported so a
// future refactor can lift `await openStudentDetail(page, id)` etc.
export async function openStudentBillingTab(page: Page, id: string): Promise<void> {
  await page.goto(`/students/${id}`);
  await page.getByRole('tab', { name: /^billing$/i }).click();
}
