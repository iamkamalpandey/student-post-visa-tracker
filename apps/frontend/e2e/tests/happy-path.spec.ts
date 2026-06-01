import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

// SVT happy-path smoke. Drives the real running stack:
//   - FE: http://localhost:3001 (override via E2E_BASE_URL)
//   - BE: http://localhost:4000 (override via E2E_API_BASE_URL)
//
// One serial test that:
//   1. logs in as the seeded admin,
//   2. lands on the post-login dashboard,
//   3. opens Students from the side nav,
//   4. creates a student via the quick-create dialog,
//   5. asserts redirect to /students/<uuid> and the name renders,
//   6. clicks Reminders and asserts that page renders,
//   7. signs out via the avatar menu and lands back on /login.
//
// Cleanup: afterAll() deletes the created student via the backend admin token,
// so re-running the suite stays idempotent against a shared dev DB.

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMeNow!2026';
const API_BASE = process.env.E2E_API_BASE_URL ?? 'http://localhost:4000/api/v1';

// Unique-ish suffix so re-runs don't collide on email_primary unique constraints.
const RUN_TAG = Date.now().toString(36);
const STUDENT = {
  given_name: 'E2E',
  family_name: `Test-${RUN_TAG}`,
  name_in_passport: `E2E TEST ${RUN_TAG.toUpperCase()}`,
  date_of_birth: '2000-01-15',
  nationality_code: 'US',
  primary_language: 'en',
  email_primary: `e2e+${RUN_TAG}@test.com`,
};

let createdStudentId: string | null = null;

test.describe.configure({ mode: 'serial' });

test('admin can log in, create a student, navigate around, and sign out', async ({
  page,
}) => {
  // 1. Login
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();

  // MUI's password TextField pairs the label with a show/hide IconButton inside
  // an InputAdornment, so getByLabel('Password') is ambiguous (matches the
  // input AND the toggle). Lock onto the input element by attribute instead.
  const emailInput = page.locator('input[name="email"], input[type="email"]').first();
  const pwInput = page.locator('input[name="password"], input[type="password"]').first();
  await emailInput.click();
  await emailInput.fill(ADMIN_EMAIL);
  await pwInput.click();
  await pwInput.fill(ADMIN_PASSWORD);
  // RHF mode 'onBlur' — tab out of the password field so validation accepts it
  // before we trigger submit.
  await pwInput.press('Tab');
  await page.getByRole('button', { name: /^sign in$/i }).click();

  // 2. Post-login redirect — login client redirects to '/' by default. AppShell
  // renders the dashboard there. Wait for the side nav (which only mounts
  // inside ProtectedLayout) to appear so we know auth bootstrap finished.
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), {
    timeout: 15_000,
  });
  // AppShell renders TWO drawers (mobile temporary + desktop permanent) with
  // `keepMounted` so both are in the DOM. Filter the role=navigation lookup to
  // the visible one. Sidebar items are MUI ListItemButtons (role=button), not
  // anchors.
  const sidebar = page.getByRole('navigation').locator('visible=true').first();
  const studentsNav = sidebar.getByRole('button', { name: 'Students', exact: true });
  await expect(studentsNav).toBeVisible({ timeout: 15_000 });

  // 3. Students nav
  await studentsNav.click();
  await expect(page).toHaveURL(/\/students(\?|$)/);
  await expect(page.getByRole('heading', { name: /students/i }).first()).toBeVisible();

  // The list page shows either a table OR an EmptyState — both count as
  // "loaded". Wait for the Add student button which is present in both states.
  const addStudentBtn = page
    .getByRole('button', { name: /add student|create student|new student|quick create/i })
    .first();
  await expect(addStudentBtn).toBeVisible();

  // 4. Open the create dialog
  await addStudentBtn.click();
  const dialog = page.getByRole('dialog', { name: /add a student/i });
  await expect(dialog).toBeVisible();

  // 5. Fill the form. The quick-create requires more than what the user
  // listed (name_in_passport, DOB, gender, primary_language), so we fill
  // those too — gender already defaults to "Prefer not to say".
  await dialog.getByLabel('Given name').fill(STUDENT.given_name);
  await dialog.getByLabel('Family name').fill(STUDENT.family_name);
  await dialog.getByLabel('Name in passport').fill(STUDENT.name_in_passport);
  await dialog.getByLabel('Date of birth').fill(STUDENT.date_of_birth);

  // Nationality is an Autocomplete — typing the country name and picking from
  // the listbox is the most user-faithful interaction.
  const nationality = dialog.getByLabel('Nationality');
  await nationality.click();
  await nationality.fill('United States');
  await page
    .getByRole('option', { name: /united states.*\(US\)/i })
    .first()
    .click();

  await dialog.getByLabel('Primary language').fill(STUDENT.primary_language);
  await dialog.getByLabel('Primary email').fill(STUDENT.email_primary);

  // The PhoneField (react-international-phone) seeds its input with the
  // selected country's dial code (e.g. "+977"), and zod treats that as an
  // invalid E.164 even though the field is optional. Clear it so submit
  // doesn't trip the phone-format validator.
  const phoneInput = dialog.locator('.react-international-phone-input');
  await phoneInput.click();
  await phoneInput.press('ControlOrMeta+a');
  await phoneInput.press('Delete');

  // 6. Submit
  await dialog.getByRole('button', { name: /create student/i }).click();

  // 7. Dialog closes, URL becomes /students/<uuid>
  await page.waitForURL(/\/students\/[0-9a-f-]{36}(\?|#|$)/i, { timeout: 15_000 });
  await expect(dialog).toBeHidden();

  const match = page.url().match(/\/students\/([0-9a-f-]{36})/i);
  expect(match).not.toBeNull();
  createdStudentId = match![1] ?? null;

  // 8. Detail page renders the entered name somewhere on the page.
  await expect(
    page.getByText(new RegExp(`${STUDENT.given_name}\\s+${STUDENT.family_name}`)).first(),
  ).toBeVisible({ timeout: 15_000 });

  // 9. Inbox nav (Reminders + Expiries + Messages were folded into a
  //    single tabbed page; the standalone Reminders sidebar entry is gone).
  await sidebar.getByRole('button', { name: 'Inbox', exact: true }).click();
  await expect(page).toHaveURL(/\/inbox(\?|$)/);
  await expect(page.getByRole('heading', { name: /inbox/i }).first()).toBeVisible();

  // 10. Logout via avatar menu
  await page.getByRole('button', { name: /account menu/i }).click();
  await page.getByRole('menuitem', { name: /sign out/i }).click();
  await page.waitForURL(/\/login/, { timeout: 10_000 });
  await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();
});

test.afterAll(async ({ playwright }) => {
  if (!createdStudentId) return;

  const request: APIRequestContext = await playwright.request.newContext();
  try {
    // Re-login against the API directly to grab a fresh access token + cookie.
    const loginRes = await request.post(`${API_BASE}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    if (!loginRes.ok()) {
      // Best-effort cleanup — log and bail rather than failing the suite.
      console.warn(
        `[cleanup] admin login failed: ${loginRes.status()} ${await loginRes.text()}`,
      );
      return;
    }
    const body = (await loginRes.json()) as { access_token?: string };
    const token = body.access_token;
    if (!token) {
      console.warn('[cleanup] login response missing access_token; skipping delete');
      return;
    }

    const del = await request.delete(`${API_BASE}/students/${createdStudentId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!del.ok() && del.status() !== 404) {
      console.warn(
        `[cleanup] DELETE /students/${createdStudentId} -> ${del.status()} ${await del.text()}`,
      );
    }
  } finally {
    await request.dispose();
  }
});
