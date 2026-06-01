import { describe, it, expect } from 'vitest';
import {
  LoginRequest,
  Password,
  CountryAlpha2,
  UuidV7,
  InstitutionBase,
  CreateSubProcessorRequest,
  CreateProgramRequest,
} from './index.js';

describe('LoginRequest', () => {
  it('accepts a well-formed payload', () => {
    const r = LoginRequest.safeParse({
      email: 'user@example.com',
      password: 'pw',
    });
    expect(r.success).toBe(true);
  });

  it('rejects a non-email value in the email field', () => {
    const r = LoginRequest.safeParse({ email: 'not-an-email', password: 'pw' });
    expect(r.success).toBe(false);
  });

  it('rejects a 5-digit MFA code (must be exactly 6)', () => {
    const r = LoginRequest.safeParse({
      email: 'user@example.com',
      password: 'pw',
      mfa_code: '12345',
    });
    expect(r.success).toBe(false);
  });
});

describe('Password (NIST 800-63B floor)', () => {
  it('rejects passwords shorter than 12 characters', () => {
    expect(Password.safeParse('short').success).toBe(false);
    expect(Password.safeParse('eleven-char').success).toBe(false); // 11 chars
  });

  it('accepts passwords >= 12 characters', () => {
    expect(Password.safeParse('twelve-chars').success).toBe(true); // 12
    expect(Password.safeParse('correct-horse-battery-staple-2026').success).toBe(true);
  });
});

describe('CountryAlpha2', () => {
  it('accepts uppercase 2-letter codes', () => {
    expect(CountryAlpha2.safeParse('US').success).toBe(true);
    expect(CountryAlpha2.safeParse('NP').success).toBe(true);
    expect(CountryAlpha2.safeParse('GB').success).toBe(true);
  });

  it('rejects lowercase', () => {
    expect(CountryAlpha2.safeParse('us').success).toBe(false);
  });

  it('rejects wrong length', () => {
    expect(CountryAlpha2.safeParse('USA').success).toBe(false);
    expect(CountryAlpha2.safeParse('U').success).toBe(false);
    expect(CountryAlpha2.safeParse('').success).toBe(false);
  });

  it('rejects non-letters', () => {
    expect(CountryAlpha2.safeParse('U1').success).toBe(false);
  });
});

// SVT-SEC-P0-FE1-2026-05 — every user-supplied URL field must reject the
// classic XSS-via-href schemes (javascript:, data:, vbscript:, file:) at the
// storage gate. This is the wire-level complement to apps/frontend/lib/
// safeUrl.ts and lib/safeHref.ts which guard the render path.
describe('URL fields reject XSS schemes', () => {
  const xssSchemes = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)', // case-insensitivity check
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ];

  const baseInstitution = {
    legal_name: 'Acme U',
    display_name: 'Acme',
    type: 'UNIVERSITY' as const,
    country_code: 'US' as const,
  };

  for (const bad of xssSchemes) {
    it(`InstitutionBase.website rejects ${bad}`, () => {
      const r = InstitutionBase.safeParse({ ...baseInstitution, website: bad });
      expect(r.success).toBe(false);
    });

    it(`CreateSubProcessorRequest.contract_url rejects ${bad}`, () => {
      const r = CreateSubProcessorRequest.safeParse({
        name: 'AWS',
        purpose: 'hosting',
        region: 'us-east-1',
        contract_url: bad,
      });
      expect(r.success).toBe(false);
    });

    it(`CreateProgramRequest.url rejects ${bad}`, () => {
      const r = CreateProgramRequest.safeParse({
        institution_id: '018f4a3a-1e5e-7c2b-9b3a-1234567890ab',
        name: 'BSc CS',
        level: 'BACHELORS',
        duration_months: 36,
        url: bad,
      });
      expect(r.success).toBe(false);
    });
  }

  it('InstitutionBase.website accepts https://example.edu', () => {
    const r = InstitutionBase.safeParse({
      ...baseInstitution,
      website: 'https://example.edu',
    });
    expect(r.success).toBe(true);
  });

  it('InstitutionBase.website accepts http://example.edu', () => {
    const r = InstitutionBase.safeParse({
      ...baseInstitution,
      website: 'http://example.edu',
    });
    expect(r.success).toBe(true);
  });
});

describe('UuidV7', () => {
  it('accepts a real v7 UUID', () => {
    const v7 = '018f4a3a-1e5e-7c2b-9b3a-1234567890ab';
    expect(UuidV7.safeParse(v7).success).toBe(true);
  });

  it('rejects a v4 UUID', () => {
    const v4 = '550e8400-e29b-41d4-a716-446655440000';
    expect(UuidV7.safeParse(v4).success).toBe(false);
  });

  it('rejects a non-UUID string', () => {
    expect(UuidV7.safeParse('not-a-uuid').success).toBe(false);
  });
});
