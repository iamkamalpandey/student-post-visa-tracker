import { describe, it, expect } from 'vitest';

import {
  CreateProgramFeeRequest,
  CreateProgramIntakeRequest,
  CreateProgramModuleRequest,
  CreateProgramRequest,
  CreateProgramRequirementRequest,
  ProgramListQuery,
  UpdateProgramRequest,
} from '@spv/zod-schemas';

// ============================================================================
// Pure schema tests for the programs module.
// ============================================================================

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('CreateProgramRequest', () => {
  const minimal = {
    institution_id: VALID_UUID,
    name: 'BSc Computer Science',
    level: 'BACHELORS' as const,
    duration_months: 36,
  };

  it('accepts a minimal payload, applies defaults', () => {
    const r = CreateProgramRequest.safeParse(minimal);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.delivery_mode).toBe('IN_PERSON');
      expect(r.data.language_of_instruction).toBe('en');
    }
  });

  it('rejects unknown keys (strict)', () => {
    expect(
      CreateProgramRequest.safeParse({ ...minimal, evil: 1 }).success,
    ).toBe(false);
  });

  it('requires institution_id, name, level, duration_months', () => {
    expect(CreateProgramRequest.safeParse({}).success).toBe(false);
    expect(
      CreateProgramRequest.safeParse({ ...minimal, name: undefined }).success,
    ).toBe(false);
  });

  it('rejects an unknown academic level', () => {
    expect(
      CreateProgramRequest.safeParse({ ...minimal, level: 'POSTGRAD' }).success,
    ).toBe(false);
  });

  it('rejects malformed isced_code', () => {
    expect(
      CreateProgramRequest.safeParse({ ...minimal, isced_code: '123' }).success,
    ).toBe(false);
    expect(
      CreateProgramRequest.safeParse({ ...minimal, isced_code: 'abcd' }).success,
    ).toBe(false);
    expect(
      CreateProgramRequest.safeParse({ ...minimal, isced_code: '0613' }).success,
    ).toBe(true);
  });

  it('clamps duration_months to [1, 120]', () => {
    expect(
      CreateProgramRequest.safeParse({ ...minimal, duration_months: 0 }).success,
    ).toBe(false);
    expect(
      CreateProgramRequest.safeParse({ ...minimal, duration_months: 121 }).success,
    ).toBe(false);
    expect(
      CreateProgramRequest.safeParse({ ...minimal, duration_months: 1 }).success,
    ).toBe(true);
  });

  it('rejects malformed institution_id UUID', () => {
    expect(
      CreateProgramRequest.safeParse({ ...minimal, institution_id: 'nope' }).success,
    ).toBe(false);
  });

  it('accepts an unknown delivery_mode? no — must be enum', () => {
    expect(
      CreateProgramRequest.safeParse({ ...minimal, delivery_mode: 'TELEPATHY' }).success,
    ).toBe(false);
  });
});

describe('UpdateProgramRequest', () => {
  it('accepts an empty patch', () => {
    expect(UpdateProgramRequest.safeParse({}).success).toBe(true);
  });

  it('accepts a partial patch with is_active', () => {
    expect(UpdateProgramRequest.safeParse({ is_active: false }).success).toBe(true);
  });

  it('rejects unknown keys (strict)', () => {
    expect(
      UpdateProgramRequest.safeParse({ name: 'X', evil: 1 }).success,
    ).toBe(false);
  });
});

describe('ProgramListQuery', () => {
  it('accepts empty', () => {
    expect(ProgramListQuery.safeParse({}).success).toBe(true);
  });

  it('rejects bad isced_code in filter', () => {
    expect(ProgramListQuery.safeParse({ isced_code: 'XX' }).success).toBe(false);
  });

  it('rejects bad country_code in filter', () => {
    expect(ProgramListQuery.safeParse({ country_code: 'usa' }).success).toBe(false);
  });
});

describe('CreateProgramIntakeRequest', () => {
  const minimal = {
    intake_year: 2026,
    intake_month: 9,
    intake_label: 'Sept 2026',
  };

  it('accepts minimal payload, defaults is_open=true', () => {
    const r = CreateProgramIntakeRequest.safeParse(minimal);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.is_open).toBe(true);
  });

  it('rejects intake_month outside [1, 12]', () => {
    expect(
      CreateProgramIntakeRequest.safeParse({ ...minimal, intake_month: 0 }).success,
    ).toBe(false);
    expect(
      CreateProgramIntakeRequest.safeParse({ ...minimal, intake_month: 13 }).success,
    ).toBe(false);
  });

  it('rejects intake_year outside [2024, 2050]', () => {
    expect(
      CreateProgramIntakeRequest.safeParse({ ...minimal, intake_year: 2023 }).success,
    ).toBe(false);
    expect(
      CreateProgramIntakeRequest.safeParse({ ...minimal, intake_year: 2051 }).success,
    ).toBe(false);
  });

  it('rejects bad date formats on application_open', () => {
    expect(
      CreateProgramIntakeRequest.safeParse({ ...minimal, application_open: '2026/01/01' })
        .success,
    ).toBe(false);
  });
});

describe('CreateProgramRequirementRequest', () => {
  it('accepts a minimal payload (defaults is_mandatory=true)', () => {
    const r = CreateProgramRequirementRequest.safeParse({
      category: 'LANGUAGE',
      label: 'IELTS overall',
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.is_mandatory).toBe(true);
  });

  it('rejects unknown category', () => {
    expect(
      CreateProgramRequirementRequest.safeParse({
        category: 'NOPE',
        label: 'X',
      }).success,
    ).toBe(false);
  });

  it('rejects malformed min_value', () => {
    expect(
      CreateProgramRequirementRequest.safeParse({
        category: 'LANGUAGE',
        label: 'IELTS',
        min_value: 'six.5',
      }).success,
    ).toBe(false);
    expect(
      CreateProgramRequirementRequest.safeParse({
        category: 'LANGUAGE',
        label: 'IELTS',
        min_value: '6.5',
      }).success,
    ).toBe(true);
  });
});

describe('CreateProgramModuleRequest', () => {
  it('requires code and title', () => {
    expect(
      CreateProgramModuleRequest.safeParse({ code: 'CS101' }).success,
    ).toBe(false);
    expect(
      CreateProgramModuleRequest.safeParse({ code: 'CS101', title: 'Intro' }).success,
    ).toBe(true);
  });

  it('defaults is_core to true', () => {
    const r = CreateProgramModuleRequest.safeParse({ code: 'CS101', title: 'Intro' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.is_core).toBe(true);
  });
});

describe('CreateProgramFeeRequest', () => {
  const minimal = {
    fee_type: 'TUITION' as const,
    amount_minor: '1500000',
    currency: 'GBP',
  };

  it('accepts and coerces amount_minor to BigInt; defaults audience/per_period', () => {
    const r = CreateProgramFeeRequest.safeParse(minimal);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(typeof r.data.amount_minor).toBe('bigint');
      expect(r.data.amount_minor).toBe(1500000n);
      expect(r.data.audience).toBe('INTERNATIONAL');
      expect(r.data.per_period).toBe('YEAR');
    }
  });

  it('rejects negative amount_minor', () => {
    expect(
      CreateProgramFeeRequest.safeParse({ ...minimal, amount_minor: '-1' }).success,
    ).toBe(false);
  });

  it('rejects unknown fee_type / per_period', () => {
    expect(
      CreateProgramFeeRequest.safeParse({ ...minimal, fee_type: 'NOPE' }).success,
    ).toBe(false);
    expect(
      CreateProgramFeeRequest.safeParse({ ...minimal, per_period: 'CENTURY' }).success,
    ).toBe(false);
  });

  it('rejects lowercase currency code', () => {
    expect(
      CreateProgramFeeRequest.safeParse({ ...minimal, currency: 'gbp' }).success,
    ).toBe(false);
  });
});
