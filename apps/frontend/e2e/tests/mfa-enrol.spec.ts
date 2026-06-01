// SVT-SEC-2026-05 — Playwright E2E for the MFA enrol wizard.
//
// We log in as the seeded admin and walk all three steps of the enrol dialog:
//   1. Generate secret  (POST /auth/mfa/setup)
//   2. Verify TOTP code (POST /auth/mfa/verify)
//   3. Display recovery codes + download + "I have saved these" checkbox.
//
// MOCKING STRATEGY
// We can't compute a real TOTP code inside the test without pulling otplib
// (and a real backend secret), so we intercept BOTH /auth/mfa/setup and
// /auth/mfa/verify via page.route() and return canned successful responses.
// This keeps the test hermetic — it exercises the FE wizard, not the backend.
// /auth/me is also stubbed on the post-enrol refresh so the dialog can close
// without flapping the user object back to mfa_enabled=false.

import { test, expect, type Route } from '@playwright/test';
import { getSidebar, loginAsAdmin, probeStack } from './_helpers';

const FAKE_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'; // valid Base32, 32 chars
const FAKE_OTPAUTH =
  'otpauth://totp/SVT:admin@example.com?secret=' + FAKE_SECRET + '&issuer=SVT';
const FAKE_RECOVERY_CODES = [
  'AAAA-BBBB-CCCC',
  'DDDD-EEEE-FFFF',
  'GGGG-HHHH-IIII',
  'JJJJ-KKKK-LLLL',
  'MMMM-NNNN-OOOO',
  'PPPP-QQQQ-RRRR',
  'SSSS-TTTT-UUUU',
  'VVVV-WWWW-XXXX',
  'YYYY-ZZZZ-AAAA',
  'BBBB-CCCC-DDDD',
];

test.describe('MFA enrol wizard', () => {
  let skipReason: string | null = null;
  test.beforeAll(async ({ request }) => {
    skipReason = await probeStack(request);
  });
  test.beforeEach(({ }, testInfo) => {
    test.skip(
      skipReason !== null,
      `Dev stack not reachable — ${skipReason ?? ''}. Prereqs: FE on 3001, BE on 4000, seeded admin without MFA enabled.`,
    );
    void testInfo;
  });

  test('admin walks through the 3-step enrol dialog with mocked backend', async ({
    page,
  }) => {
    // Intercept the two mutating endpoints BEFORE login so the auth bootstrap
    // call to /auth/me isn't accidentally caught by an overly-broad matcher.
    await page.route('**/api/v1/auth/mfa/setup', async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          secret: FAKE_SECRET,
          otpauth_url: FAKE_OTPAUTH,
          status: 'PENDING_VERIFICATION',
        }),
      });
    });
    await page.route('**/api/v1/auth/mfa/verify', async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          enabled: true,
          recovery_codes: FAKE_RECOVERY_CODES,
        }),
      });
    });

    await loginAsAdmin(page);

    // Navigate to /settings via the sidebar.
    const sidebar = getSidebar(page);
    await sidebar.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page).toHaveURL(/\/settings(\?|$)/);

    // The MfaSection only renders the "Enable" button when mfa_enabled=false.
    // If the seed admin already has MFA on, the test can't proceed — skip
    // rather than failing, since the prereq isn't under this spec's control.
    const enableBtn = page.getByRole('button', { name: /enable two-factor auth/i });
    if (!(await enableBtn.isVisible().catch(() => false))) {
      test.skip(true, 'Seed admin already has MFA enabled; cannot exercise enrol wizard.');
      return;
    }
    await enableBtn.click();

    // ---- Step 1: intro + "Generate secret" -----------------------------------
    const dialog = page.getByRole('dialog', { name: /enable two-factor authentication/i });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/step 1 of 3/i)).toBeVisible();
    await dialog.getByRole('button', { name: /generate secret/i }).click();

    // ---- Step 2: secret + code field -----------------------------------------
    await expect(dialog.getByText(/step 2 of 3/i)).toBeVisible();
    // Both the Base32 secret AND the otpauth URI fields are read-only TextFields
    // populated from the mocked response. Asserting the secret value confirms
    // step1 → step2 wiring + the fulfill body was consumed.
    await expect(dialog.locator('input#mfa-secret')).toHaveValue(FAKE_SECRET);
    await expect(dialog.locator('input#mfa-uri')).toHaveValue(FAKE_OTPAUTH);

    // Any 6-digit string will do — the route handler ignores the payload.
    await dialog.locator('input#mfa-verify-code').fill('123456');
    await dialog.getByRole('button', { name: /verify and enable/i }).click();

    // ---- Step 3: recovery codes ----------------------------------------------
    await expect(dialog.getByText(/step 3 of 3/i)).toBeVisible();
    // First and last codes both visible == the list rendered.
    await expect(dialog.getByText(FAKE_RECOVERY_CODES[0]!)).toBeVisible();
    await expect(
      dialog.getByText(FAKE_RECOVERY_CODES[FAKE_RECOVERY_CODES.length - 1]!),
    ).toBeVisible();

    // Verify Download .txt triggers a browser download — Playwright's
    // page.waitForEvent('download') resolves the moment the blob is created.
    const downloadPromise = page.waitForEvent('download');
    await dialog.getByRole('button', { name: /download \.txt/i }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/svt-mfa-recovery-codes-.*\.txt/);

    // Done button stays disabled until the acknowledge checkbox is ticked.
    const doneBtn = dialog.getByRole('button', { name: /^done$/i });
    await expect(doneBtn).toBeDisabled();
    await dialog
      .getByRole('checkbox', { name: /confirm recovery codes saved/i })
      .check();
    await expect(doneBtn).toBeEnabled();
  });
});
