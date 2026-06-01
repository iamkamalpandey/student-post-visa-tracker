// Pure schema tests for the students/stages public API contracts. No DB, no Express.
// We only exercise the @spv/zod-schemas surface here so this suite stays fast and stable.

import { describe, it, expect } from 'vitest';
import {
  AdvanceStageRequest,
  CreateStageRequest,
  CreateStudentRequest,
  StudentListQuery,
  UpdateStudentRequest,
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

describe('CreateStudentRequest', () => {
  it('accepts a minimal valid payload', () => {
    const r = CreateStudentRequest.safeParse(validStudent);
    expect(r.success).toBe(true);
  });

  it('rejects missing name_in_passport (legally significant field)', () => {
    const { name_in_passport: _omit, ...rest } = validStudent;
    const r = CreateStudentRequest.safeParse(rest);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.path.join('.') === 'name_in_passport')).toBe(true);
    }
  });

  it('rejects missing date_of_birth', () => {
    const { date_of_birth: _omit, ...rest } = validStudent;
    const r = CreateStudentRequest.safeParse(rest);
    expect(r.success).toBe(false);
  });

  it('rejects badly formatted date_of_birth (not ISO 8601 date)', () => {
    const r = CreateStudentRequest.safeParse({ ...validStudent, date_of_birth: '12/04/2002' });
    expect(r.success).toBe(false);
  });

  it('rejects ISO datetime where ISO date is expected', () => {
    // Iso8601Date is YYYY-MM-DD only — full datetime should not pass.
    const r = CreateStudentRequest.safeParse({
      ...validStudent,
      date_of_birth: '2002-04-12T00:00:00Z',
    });
    expect(r.success).toBe(false);
  });

  it('rejects bad nationality_code (lowercase)', () => {
    const r = CreateStudentRequest.safeParse({ ...validStudent, nationality_code: 'np' });
    expect(r.success).toBe(false);
  });

  it('rejects bad nationality_code (3 letters)', () => {
    const r = CreateStudentRequest.safeParse({ ...validStudent, nationality_code: 'NPL' });
    expect(r.success).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    const r = CreateStudentRequest.safeParse({ ...validStudent, hacker_field: true });
    expect(r.success).toBe(false);
  });

  it('rejects bad email_primary', () => {
    const r = CreateStudentRequest.safeParse({ ...validStudent, email_primary: 'not-email' });
    expect(r.success).toBe(false);
  });

  it('rejects non-E.164 phone', () => {
    const r = CreateStudentRequest.safeParse({ ...validStudent, phone_primary_e164: '0123456789' });
    expect(r.success).toBe(false);
  });
});

describe('UpdateStudentRequest', () => {
  it('accepts an empty patch', () => {
    expect(UpdateStudentRequest.safeParse({}).success).toBe(true);
  });

  it('rejects unknown keys (strict partial)', () => {
    const r = UpdateStudentRequest.safeParse({ unknown_key: 'x' });
    expect(r.success).toBe(false);
  });

  it('accepts a single-field patch', () => {
    expect(UpdateStudentRequest.safeParse({ status: 'ON_HOLD' }).success).toBe(true);
  });
});

describe('StudentListQuery', () => {
  it('accepts a valid sort directive', () => {
    const r = StudentListQuery.safeParse({ sort: '-created_at,family_name' });
    expect(r.success).toBe(true);
  });

  it('rejects sort against a non-allow-listed column', () => {
    const r = StudentListQuery.safeParse({ sort: 'ssn' });
    expect(r.success).toBe(false);
  });

  it('coerces numeric limit and clamps via schema', () => {
    expect(StudentListQuery.safeParse({ limit: '25' }).success).toBe(true);
    expect(StudentListQuery.safeParse({ limit: 0 }).success).toBe(false);
    expect(StudentListQuery.safeParse({ limit: 101 }).success).toBe(false);
  });
});

describe('AdvanceStageRequest', () => {
  const validUuid = '550e8400-e29b-41d4-a716-446655440000';

  it('accepts a valid payload', () => {
    const r = AdvanceStageRequest.safeParse({ to_stage_id: validUuid });
    expect(r.success).toBe(true);
  });

  it('rejects a bad to_stage_id (not a UUID)', () => {
    const r = AdvanceStageRequest.safeParse({ to_stage_id: 'not-a-uuid' });
    expect(r.success).toBe(false);
  });

  it('rejects unknown keys', () => {
    const r = AdvanceStageRequest.safeParse({ to_stage_id: validUuid, evil: true });
    expect(r.success).toBe(false);
  });

  it('rejects oversize notes', () => {
    const r = AdvanceStageRequest.safeParse({
      to_stage_id: validUuid,
      notes: 'x'.repeat(2001),
    });
    expect(r.success).toBe(false);
  });
});

describe('CreateStageRequest', () => {
  const validStage = {
    key: 'pre-departure',
    label: 'Pre Departure',
    sequence: 10,
    category: 'PRE_DEPARTURE' as const,
  };

  it('accepts a minimal valid payload (defaults applied)', () => {
    const r = CreateStageRequest.safeParse(validStage);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.is_initial).toBe(false);
      expect(r.data.is_terminal).toBe(false);
    }
  });

  it('rejects bad color_hex (no #)', () => {
    const r = CreateStageRequest.safeParse({ ...validStage, color_hex: '00FF00' });
    expect(r.success).toBe(false);
  });

  it('rejects bad color_hex (3 chars)', () => {
    const r = CreateStageRequest.safeParse({ ...validStage, color_hex: '#0F0' });
    expect(r.success).toBe(false);
  });

  it('rejects bad color_hex (invalid character)', () => {
    const r = CreateStageRequest.safeParse({ ...validStage, color_hex: '#GGGGGG' });
    expect(r.success).toBe(false);
  });

  it('rejects an UPPERCASE key (slug must be lowercase)', () => {
    const r = CreateStageRequest.safeParse({ ...validStage, key: 'Pre-Departure' });
    expect(r.success).toBe(false);
  });

  it('rejects negative sequence', () => {
    const r = CreateStageRequest.safeParse({ ...validStage, sequence: -1 });
    expect(r.success).toBe(false);
  });

  it('rejects unknown category', () => {
    const r = CreateStageRequest.safeParse({ ...validStage, category: 'MADE_UP' });
    expect(r.success).toBe(false);
  });
});
