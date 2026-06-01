import { describe, expect, it } from 'vitest';
import { CreateUserRequest, UpdateUserRequest, ResetPasswordRequest } from '@spv/zod-schemas';

describe('users schemas', () => {
  it('CreateUserRequest accepts a minimal valid payload', () => {
    const out = CreateUserRequest.parse({
      email: 'jane@example.com',
      password: 'CorrectHorse-Battery-Staple-1!',
      given_name: 'Jane',
      family_name: 'Doe',
    });
    expect(out.role).toBe('COUNSELLOR');
    // SVT-WAVE25-DEFAULTS-2026-05 — locale/timezone are optional at the
    // schema layer; the users service inherits from tenant defaults when omitted.
    expect(out.locale).toBeUndefined();
    expect(out.timezone).toBeUndefined();
  });

  it('CreateUserRequest rejects short passwords', () => {
    const r = CreateUserRequest.safeParse({
      email: 'a@b.co',
      password: 'short',
      given_name: 'A',
      family_name: 'B',
    });
    expect(r.success).toBe(false);
  });

  it('CreateUserRequest rejects bad email', () => {
    const r = CreateUserRequest.safeParse({
      email: 'not-an-email',
      password: 'CorrectHorse-Battery-Staple-1!',
      given_name: 'A',
      family_name: 'B',
    });
    expect(r.success).toBe(false);
  });

  it('UpdateUserRequest accepts partial updates', () => {
    const out = UpdateUserRequest.parse({ display_name: 'Jane D.', role: 'ADMIN' });
    expect(out.role).toBe('ADMIN');
  });

  it('UpdateUserRequest rejects unknown keys', () => {
    const r = UpdateUserRequest.safeParse({ password: 'new' });
    expect(r.success).toBe(false);
  });

  it('ResetPasswordRequest enforces password policy', () => {
    expect(ResetPasswordRequest.parse({ new_password: 'CorrectHorse-Battery-Staple-1!' }).force_change_on_next_login).toBe(true);
    expect(ResetPasswordRequest.safeParse({ new_password: 'short' }).success).toBe(false);
  });
});
