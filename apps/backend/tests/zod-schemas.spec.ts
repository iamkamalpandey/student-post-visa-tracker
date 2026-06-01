// Schema regression tests that aren't covered (or aren't covered enough) by the
// existing per-resource validation suites.
//
// Important: LoginFormSchema lives only in apps/frontend/app/(auth)/login/page.tsx
// (it wraps LoginRequest to tolerate the empty-string mfa_code default emitted by
// react-hook-form). We re-declare an *equivalent* schema here so a regression in the
// shared LoginRequest will trip a test in the backend CI lane.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  AdvanceStageRequest,
  CreateStudentRequest,
  CreateUserRequest,
  LoginRequest,
} from '@spv/zod-schemas';

const validStudent = {
  given_name: 'Asha',
  family_name: 'Sharma',
  name_in_passport: 'ASHA SHARMA',
  date_of_birth: '2002-04-12',
  gender: 'FEMALE' as const,
  nationality_code: 'NP',
  primary_language: 'en',
};

describe('CreateStudentRequest — bad nationality_code coverage', () => {
  it('rejects lowercase alpha-2', () => {
    const r = CreateStudentRequest.safeParse({ ...validStudent, nationality_code: 'np' });
    expect(r.success).toBe(false);
  });

  it('rejects three-letter alpha-3', () => {
    const r = CreateStudentRequest.safeParse({ ...validStudent, nationality_code: 'NPL' });
    expect(r.success).toBe(false);
  });

  it('rejects digits in alpha-2', () => {
    const r = CreateStudentRequest.safeParse({ ...validStudent, nationality_code: 'N1' });
    expect(r.success).toBe(false);
  });

  it('rejects empty string', () => {
    const r = CreateStudentRequest.safeParse({ ...validStudent, nationality_code: '' });
    expect(r.success).toBe(false);
  });

  it('accepts valid uppercase alpha-2', () => {
    const r = CreateStudentRequest.safeParse({ ...validStudent, nationality_code: 'NP' });
    expect(r.success).toBe(true);
  });
});

describe('AdvanceStageRequest — effective_at handling', () => {
  const stageId = '550e8400-e29b-41d4-a716-446655440000';

  it('accepts undefined effective_at', () => {
    const r = AdvanceStageRequest.safeParse({ to_stage_id: stageId });
    expect(r.success).toBe(true);
  });

  it('accepts ISO 8601 datetime with Z offset', () => {
    const r = AdvanceStageRequest.safeParse({
      to_stage_id: stageId,
      effective_at: '2026-05-14T12:00:00Z',
    });
    expect(r.success).toBe(true);
  });

  it('accepts ISO 8601 datetime with explicit numeric offset', () => {
    const r = AdvanceStageRequest.safeParse({
      to_stage_id: stageId,
      effective_at: '2026-05-14T12:00:00+05:45',
    });
    expect(r.success).toBe(true);
  });

  it('rejects ISO date without time component', () => {
    const r = AdvanceStageRequest.safeParse({
      to_stage_id: stageId,
      effective_at: '2026-05-14',
    });
    expect(r.success).toBe(false);
  });

  it('rejects free-form date strings', () => {
    const r = AdvanceStageRequest.safeParse({
      to_stage_id: stageId,
      effective_at: 'May 14 2026',
    });
    expect(r.success).toBe(false);
  });
});

describe('CreateUserRequest — defaults', () => {
  it('defaults role=COUNSELLOR; locale/timezone left undefined for service to inherit from tenant', () => {
    const out = CreateUserRequest.parse({
      email: 'newbie@example.com',
      password: 'CorrectHorse-Battery-Staple-1!',
      given_name: 'Bea',
      family_name: 'Counsellor',
    });
    expect(out.role).toBe('COUNSELLOR');
    // SVT-WAVE25-DEFAULTS-2026-05 — schema no longer hard-codes 'en'/'UTC';
    // users.service inherits from Tenant.default_locale / default_timezone.
    expect(out.locale).toBeUndefined();
    expect(out.timezone).toBeUndefined();
  });

  it('honours explicit overrides', () => {
    const out = CreateUserRequest.parse({
      email: 'admin@example.com',
      password: 'CorrectHorse-Battery-Staple-1!',
      given_name: 'Ad',
      family_name: 'Min',
      role: 'ADMIN',
      locale: 'ne',
      timezone: 'Asia/Kathmandu',
    });
    expect(out.role).toBe('ADMIN');
    expect(out.locale).toBe('ne');
    expect(out.timezone).toBe('Asia/Kathmandu');
  });
});

// Mirrors the wrapper in apps/frontend/app/(auth)/login/page.tsx. Keep in sync.
const LoginFormSchema = LoginRequest.extend({
  mfa_code: z
    .union([z.literal(''), z.string().regex(/^\d{6}$/, 'MFA code must be 6 digits')])
    .optional()
    .transform((v) => (v === '' ? undefined : v)),
});

describe('LoginFormSchema (frontend wrapper) — regression', () => {
  it('accepts empty string mfa_code and transforms to undefined', () => {
    const out = LoginFormSchema.parse({
      email: 'a@b.co',
      password: 'whatever',
      mfa_code: '',
    });
    expect(out.mfa_code).toBeUndefined();
  });

  it('accepts 6-digit mfa_code', () => {
    const out = LoginFormSchema.parse({
      email: 'a@b.co',
      password: 'whatever',
      mfa_code: '123456',
    });
    expect(out.mfa_code).toBe('123456');
  });

  it('rejects 5-digit mfa_code', () => {
    const r = LoginFormSchema.safeParse({
      email: 'a@b.co',
      password: 'whatever',
      mfa_code: '12345',
    });
    expect(r.success).toBe(false);
  });

  it('rejects mfa_code with non-digit characters', () => {
    const r = LoginFormSchema.safeParse({
      email: 'a@b.co',
      password: 'whatever',
      mfa_code: 'abc123',
    });
    expect(r.success).toBe(false);
  });

  it('still requires a valid email', () => {
    const r = LoginFormSchema.safeParse({
      email: 'not-an-email',
      password: 'whatever',
    });
    expect(r.success).toBe(false);
  });
});
