// Shared E2E helpers for the SVT frontend Playwright specs.
//
// Centralises:
//   - login as the seeded admin (mirrors the flow exercised by happy-path.spec)
//   - tenant bootstrap probe so specs can self-skip when the dev stack isn't up
//   - convenience selector wrappers (visible sidebar, etc.)
//
// All env vars match happy-path.spec.ts so the same .env values drive everything.

import { expect, type APIRequestContext, type Page } from '@playwright/test';

export const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
export const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMeNow!2026';
export const API_BASE = process.env.E2E_API_BASE_URL ?? 'http://localhost:4000/api/v1';
export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3001';

/**
 * Drive the real login form as the seeded admin user, then wait until the
 * post-auth shell has hydrated (the side-nav is the cheapest mount signal).
 *
 * Lifted verbatim from happy-path.spec — keep the two in sync if the auth
 * surface changes (MUI label quirks etc.).
 */
export async function loginAsAdmin(page: Page): Promise<void> {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();

  const emailInput = page.locator('input[name="email"], input[type="email"]').first();
  const pwInput = page.locator('input[name="password"], input[type="password"]').first();
  await emailInput.click();
  await emailInput.fill(ADMIN_EMAIL);
  await pwInput.click();
  await pwInput.fill(ADMIN_PASSWORD);
  await pwInput.press('Tab');
  await page.getByRole('button', { name: /^sign in$/i }).click();

  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 15_000 });
  const sidebar = page.getByRole('navigation').locator('visible=true').first();
  await expect(sidebar).toBeVisible({ timeout: 15_000 });
}

/** Return the visible (non-`keepMounted` mobile) sidebar locator. */
export function getSidebar(page: Page) {
  return page.getByRole('navigation').locator('visible=true').first();
}

/**
 * Best-effort probe that the dev stack (frontend + backend) is actually up
 * and the seeded admin can log in via the API. Returns null on success,
 * otherwise a short reason string suitable for a `test.skip(reason)` message.
 *
 * Specs call this in a `beforeAll` and `test.skip()` when it returns non-null,
 * so the suite is safe to land before the CI matrix is wired without flaking
 * a local `npm run e2e` invocation that has no backend running.
 */
export async function probeStack(request: APIRequestContext): Promise<string | null> {
  let res;
  try {
    res = await request.post(`${API_BASE}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      failOnStatusCode: false,
      timeout: 5_000,
    });
  } catch (err) {
    return `backend at ${API_BASE} unreachable: ${(err as Error).message}`;
  }
  if (!res.ok()) return `admin login probe returned ${res.status()}`;
  return null;
}

/**
 * Fetch a fresh admin access token directly from the backend. Used by specs
 * that need to mutate seed data (e.g. flip billing on for the tenant) before
 * exercising the UI flow.
 */
export async function adminAccessToken(request: APIRequestContext): Promise<string | null> {
  const res = await request.post(`${API_BASE}/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    failOnStatusCode: false,
  });
  if (!res.ok()) return null;
  const body = (await res.json()) as { access_token?: string };
  return body.access_token ?? null;
}

/**
 * Ensure the tenant has billing_enabled=true so the Billing tab + /billing
 * route render. Idempotent — no-op if already on.
 */
export async function ensureBillingEnabled(request: APIRequestContext): Promise<boolean> {
  const token = await adminAccessToken(request);
  if (!token) return false;
  try {
    await request.patch(`${API_BASE}/tenants/me`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { billing_enabled: true },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the id of any seeded student, or create a throwaway one if the dev DB
 * is empty. Returns null if both lookup and create fail.
 */
export async function ensureSeedStudent(
  request: APIRequestContext,
): Promise<string | null> {
  const token = await adminAccessToken(request);
  if (!token) return null;
  const headers = { Authorization: `Bearer ${token}` };

  const list = await request.get(`${API_BASE}/students`, {
    headers,
    params: { limit: '1' },
    failOnStatusCode: false,
  });
  if (list.ok()) {
    const body = (await list.json()) as { data?: Array<{ id: string }> };
    if (body.data && body.data.length > 0) return body.data[0]!.id;
  }

  // Create one as a fallback. Mirrors the quick-create payload exercised in
  // happy-path.spec — anything stricter risks 422s as the schema evolves.
  const tag = Date.now().toString(36);
  const created = await request.post(`${API_BASE}/students`, {
    headers,
    failOnStatusCode: false,
    data: {
      given_name: 'E2E',
      family_name: `Billing-${tag}`,
      name_in_passport: `E2E BILLING ${tag.toUpperCase()}`,
      date_of_birth: '2000-01-15',
      nationality_code: 'US',
      primary_language: 'en',
      email_primary: `e2e+billing+${tag}@test.com`,
    },
  });
  if (!created.ok()) return null;
  const body = (await created.json()) as { id?: string };
  return body.id ?? null;
}
