import { describe, it, expect } from 'vitest';

import {
  CreateReminderRequest,
  ReminderListQuery,
  ReminderStatusEnum,
  ReminderTypeEnum,
  SnoozeReminderRequest,
  UpdateReminderRequest,
} from '@spv/zod-schemas';

// ============================================================================
// Pure schema tests for the reminders module. No I/O, no DB.
// ============================================================================

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('ReminderTypeEnum / ReminderStatusEnum', () => {
  it('exposes the canonical Prisma values', () => {
    // If a value gets added to the Prisma enum we want this test to fail.
    expect(ReminderTypeEnum.options).toContain('CUSTOM');
    expect(ReminderTypeEnum.options).toContain('INTAKE_START');
    expect(ReminderTypeEnum.options).toContain('PAYMENT_DUE');
    expect(ReminderTypeEnum.options).toContain('VISA_EXPIRY');
    expect(ReminderTypeEnum.options).toContain('PASSPORT_EXPIRY');
    expect(ReminderTypeEnum.options).toContain('INSURANCE_EXPIRY');
    expect(ReminderTypeEnum.options).toContain('DOCUMENT_EXPIRY');
    expect(ReminderTypeEnum.options).toContain('ENROLLMENT_DECISION_DUE');
    expect(ReminderTypeEnum.options).toContain('COMMISSION_CLAIM_DUE');

    expect(ReminderStatusEnum.options).toEqual([
      'PENDING',
      'SENT',
      'ACKNOWLEDGED',
      'SNOOZED',
      'DISMISSED',
    ]);
  });
});

describe('CreateReminderRequest', () => {
  const minimal = {
    title: 'Follow up with student',
    due_on: '2026-06-15',
  };

  it('accepts a minimal payload and defaults type=CUSTOM', () => {
    const r = CreateReminderRequest.safeParse(minimal);
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.type).toBe('CUSTOM');
      // scheduled_for is left undefined; the service applies the 09:00 UTC default.
      expect(r.data.scheduled_for).toBeUndefined();
    }
  });

  it('rejects payload missing title', () => {
    expect(
      CreateReminderRequest.safeParse({ due_on: '2026-06-15' }).success,
    ).toBe(false);
  });

  it('rejects payload missing due_on', () => {
    expect(
      CreateReminderRequest.safeParse({ title: 'X' }).success,
    ).toBe(false);
  });

  it('rejects empty title', () => {
    expect(
      CreateReminderRequest.safeParse({ ...minimal, title: '' }).success,
    ).toBe(false);
  });

  it('rejects title over 200 chars', () => {
    expect(
      CreateReminderRequest.safeParse({ ...minimal, title: 'x'.repeat(201) }).success,
    ).toBe(false);
  });

  it('accepts an explicit CUSTOM type', () => {
    const r = CreateReminderRequest.safeParse({ ...minimal, type: 'CUSTOM' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.type).toBe('CUSTOM');
  });

  it('accepts an INTAKE_START type', () => {
    const r = CreateReminderRequest.safeParse({ ...minimal, type: 'INTAKE_START' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.type).toBe('INTAKE_START');
  });

  it('rejects an unknown type', () => {
    expect(
      CreateReminderRequest.safeParse({ ...minimal, type: 'NOPE' }).success,
    ).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(
      CreateReminderRequest.safeParse({ ...minimal, evil: 1 }).success,
    ).toBe(false);
  });

  it('rejects malformed due_on', () => {
    expect(
      CreateReminderRequest.safeParse({ ...minimal, due_on: '2026/06/15' }).success,
    ).toBe(false);
    expect(
      CreateReminderRequest.safeParse({ ...minimal, due_on: 'tomorrow' }).success,
    ).toBe(false);
  });

  it('accepts a valid scheduled_for ISO8601 datetime', () => {
    expect(
      CreateReminderRequest.safeParse({
        ...minimal,
        scheduled_for: '2026-06-15T09:00:00.000Z',
      }).success,
    ).toBe(true);
  });

  it('rejects a scheduled_for missing timezone offset', () => {
    expect(
      CreateReminderRequest.safeParse({
        ...minimal,
        scheduled_for: '2026-06-15T09:00:00',
      }).success,
    ).toBe(false);
  });

  it('rejects a malformed assigned_to_id', () => {
    expect(
      CreateReminderRequest.safeParse({ ...minimal, assigned_to_id: 'not-a-uuid' }).success,
    ).toBe(false);
  });

  it('accepts valid student_id + enrollment_id UUIDs', () => {
    expect(
      CreateReminderRequest.safeParse({
        ...minimal,
        student_id: VALID_UUID,
        enrollment_id: VALID_UUID,
      }).success,
    ).toBe(true);
  });
});

describe('UpdateReminderRequest', () => {
  it('accepts an empty patch', () => {
    expect(UpdateReminderRequest.safeParse({}).success).toBe(true);
  });

  it('accepts a partial patch with title only', () => {
    expect(UpdateReminderRequest.safeParse({ title: 'X' }).success).toBe(true);
  });

  it('rejects unknown keys (strict)', () => {
    expect(
      UpdateReminderRequest.safeParse({ title: 'X', evil: 1 }).success,
    ).toBe(false);
  });
});

describe('SnoozeReminderRequest', () => {
  it('accepts a valid Iso8601DateTime', () => {
    const r = SnoozeReminderRequest.safeParse({
      snooze_until: '2026-06-20T09:00:00.000Z',
    });
    expect(r.success).toBe(true);
  });

  it('rejects a date-only string', () => {
    expect(
      SnoozeReminderRequest.safeParse({ snooze_until: '2026-06-20' }).success,
    ).toBe(false);
  });

  it('rejects missing snooze_until', () => {
    expect(SnoozeReminderRequest.safeParse({}).success).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(
      SnoozeReminderRequest.safeParse({
        snooze_until: '2026-06-20T09:00:00.000Z',
        evil: 1,
      }).success,
    ).toBe(false);
  });
});

describe('ReminderListQuery', () => {
  it('accepts empty', () => {
    expect(ReminderListQuery.safeParse({}).success).toBe(true);
  });

  it('accepts the documented filters', () => {
    expect(
      ReminderListQuery.safeParse({
        status: 'PENDING',
        type: 'INTAKE_START',
        assigned_to_id: VALID_UUID,
        student_id: VALID_UUID,
        due_from: '2026-06-01',
        due_to: '2026-06-30',
        scheduled_from: '2026-06-01T00:00:00.000Z',
        scheduled_to: '2026-06-30T23:59:59.000Z',
      }).success,
    ).toBe(true);
  });

  it('rejects bad enum values', () => {
    expect(ReminderListQuery.safeParse({ status: 'NOPE' }).success).toBe(false);
    expect(ReminderListQuery.safeParse({ type: 'NOPE' }).success).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(ReminderListQuery.safeParse({ evil: 1 }).success).toBe(false);
  });
});
