import { describe, it, expect } from 'vitest';

import {
  CreateCampusRequest,
  CreateDepartmentRequest,
  CreateInstitutionAccreditationRequest,
  CreateInstitutionContactRequest,
  CreateInstitutionIdentifierRequest,
  CreateInstitutionRequest,
  CreateSchoolRequest,
  InstitutionListQuery,
  UpdateInstitutionRequest,
} from '@spv/zod-schemas';

// ============================================================================
// Pure schema tests for the institutions module.
// These do NOT touch the backend stack — they exercise the @spv/zod-schemas
// surface so the API validation layer is independently regression-tested.
// ============================================================================

describe('CreateInstitutionRequest', () => {
  const minimal = {
    legal_name: 'University of Westeros',
    display_name: 'UoW',
    type: 'UNIVERSITY' as const,
    country_code: 'GB',
  };

  it('accepts a minimal valid payload (defaults is_partner=false)', () => {
    const r = CreateInstitutionRequest.safeParse(minimal);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.is_partner).toBe(false);
    }
  });

  it('rejects unknown keys (strict)', () => {
    const r = CreateInstitutionRequest.safeParse({ ...minimal, evil_field: 'x' });
    expect(r.success).toBe(false);
  });

  it('requires legal_name, display_name, type, country_code', () => {
    expect(CreateInstitutionRequest.safeParse({}).success).toBe(false);
    expect(
      CreateInstitutionRequest.safeParse({
        legal_name: 'X',
        display_name: 'Y',
        type: 'UNIVERSITY',
      }).success,
    ).toBe(false);
  });

  it('rejects an unknown institution type', () => {
    const r = CreateInstitutionRequest.safeParse({ ...minimal, type: 'NOT_A_TYPE' });
    expect(r.success).toBe(false);
  });

  it('rejects a lowercase country code', () => {
    const r = CreateInstitutionRequest.safeParse({ ...minimal, country_code: 'gb' });
    expect(r.success).toBe(false);
  });

  it('rejects a non-URL website', () => {
    const r = CreateInstitutionRequest.safeParse({ ...minimal, website: 'not a url' });
    expect(r.success).toBe(false);
  });

  it('rejects a non-E.164 phone', () => {
    const r = CreateInstitutionRequest.safeParse({ ...minimal, phone_e164: '07911 123456' });
    expect(r.success).toBe(false);
  });

  it('rejects established_year outside [1000, 3000]', () => {
    expect(
      CreateInstitutionRequest.safeParse({ ...minimal, established_year: 999 }).success,
    ).toBe(false);
    expect(
      CreateInstitutionRequest.safeParse({ ...minimal, established_year: 3001 }).success,
    ).toBe(false);
    expect(
      CreateInstitutionRequest.safeParse({ ...minimal, established_year: 1825 }).success,
    ).toBe(true);
  });

  it('accepts a well-formed commission_pct decimal string', () => {
    expect(
      CreateInstitutionRequest.safeParse({ ...minimal, commission_pct: '12.50' }).success,
    ).toBe(true);
    expect(
      CreateInstitutionRequest.safeParse({ ...minimal, commission_pct: '0' }).success,
    ).toBe(true);
    expect(
      CreateInstitutionRequest.safeParse({ ...minimal, commission_pct: '100' }).success,
    ).toBe(true);
  });

  it('rejects a malformed commission_pct (too many decimals / numeric input)', () => {
    expect(
      CreateInstitutionRequest.safeParse({ ...minimal, commission_pct: '12.345' }).success,
    ).toBe(false);
    expect(
      CreateInstitutionRequest.safeParse({ ...minimal, commission_pct: 12.5 }).success,
    ).toBe(false);
  });

  it('rejects a partner_since that is not ISO date', () => {
    expect(
      CreateInstitutionRequest.safeParse({ ...minimal, partner_since: '2024/01/15' }).success,
    ).toBe(false);
    expect(
      CreateInstitutionRequest.safeParse({ ...minimal, partner_since: '2024-01-15' }).success,
    ).toBe(true);
  });
});

describe('UpdateInstitutionRequest', () => {
  it('accepts an empty patch', () => {
    expect(UpdateInstitutionRequest.safeParse({}).success).toBe(true);
  });

  it('accepts a partial patch', () => {
    expect(
      UpdateInstitutionRequest.safeParse({ display_name: 'Renamed' }).success,
    ).toBe(true);
  });

  it('rejects unknown keys (strict)', () => {
    expect(
      UpdateInstitutionRequest.safeParse({ display_name: 'X', extra: 1 }).success,
    ).toBe(false);
  });
});

describe('InstitutionListQuery', () => {
  it('coerces is_partner from string', () => {
    const r = InstitutionListQuery.safeParse({ is_partner: 'true' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.is_partner).toBe(true);
  });

  it('rejects q longer than 120 chars', () => {
    const r = InstitutionListQuery.safeParse({ q: 'x'.repeat(121) });
    expect(r.success).toBe(false);
  });
});

describe('CreateCampusRequest', () => {
  it('accepts minimal payload', () => {
    expect(CreateCampusRequest.safeParse({ name: 'Main' }).success).toBe(true);
  });

  it('rejects empty name', () => {
    expect(CreateCampusRequest.safeParse({ name: '' }).success).toBe(false);
  });

  it('rejects bad address_id', () => {
    expect(
      CreateCampusRequest.safeParse({ name: 'Main', address_id: 'not-uuid' }).success,
    ).toBe(false);
  });
});

describe('CreateSchoolRequest / CreateDepartmentRequest', () => {
  it('school requires name', () => {
    expect(CreateSchoolRequest.safeParse({}).success).toBe(false);
    expect(CreateSchoolRequest.safeParse({ name: 'Eng' }).success).toBe(true);
  });

  it('department requires school_id and name', () => {
    expect(CreateDepartmentRequest.safeParse({ name: 'CS' }).success).toBe(false);
    expect(
      CreateDepartmentRequest.safeParse({
        school_id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'CS',
      }).success,
    ).toBe(true);
  });

  it('department rejects malformed UUID', () => {
    expect(
      CreateDepartmentRequest.safeParse({ school_id: 'nope', name: 'CS' }).success,
    ).toBe(false);
  });
});

describe('CreateInstitutionIdentifierRequest', () => {
  it('accepts a known scheme', () => {
    expect(
      CreateInstitutionIdentifierRequest.safeParse({ scheme: 'CRICOS', value: '12345' }).success,
    ).toBe(true);
  });

  it('rejects an unknown scheme', () => {
    expect(
      CreateInstitutionIdentifierRequest.safeParse({ scheme: 'NOPE', value: 'x' }).success,
    ).toBe(false);
  });

  it('rejects empty value', () => {
    expect(
      CreateInstitutionIdentifierRequest.safeParse({ scheme: 'CRICOS', value: '' }).success,
    ).toBe(false);
  });
});

describe('CreateInstitutionAccreditationRequest', () => {
  it('requires body', () => {
    expect(CreateInstitutionAccreditationRequest.safeParse({}).success).toBe(false);
    expect(
      CreateInstitutionAccreditationRequest.safeParse({ body: 'QAA' }).success,
    ).toBe(true);
  });

  it('rejects bad date format', () => {
    expect(
      CreateInstitutionAccreditationRequest.safeParse({ body: 'QAA', awarded_on: '20240101' })
        .success,
    ).toBe(false);
  });
});

describe('CreateInstitutionContactRequest', () => {
  it('requires full_name', () => {
    expect(CreateInstitutionContactRequest.safeParse({}).success).toBe(false);
    expect(
      CreateInstitutionContactRequest.safeParse({ full_name: 'Jane' }).success,
    ).toBe(true);
  });

  it('rejects bad email', () => {
    expect(
      CreateInstitutionContactRequest.safeParse({ full_name: 'Jane', email: 'nope' }).success,
    ).toBe(false);
  });
});
