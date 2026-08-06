// Reminder request/response schemas. Mirrors prisma's Reminder model
// (apps/backend/prisma/schema.prisma section 17). Manual reminders are created
// through the HTTP API; auto-generated ones come from the backend scanner job
// — both share this validation surface.
import { z } from 'zod';
import { Iso8601Date, Iso8601DateTime, PaginationQuery, Uuid } from './common.js';

// Keep these enums in lockstep with `enum ReminderType` / `enum ReminderStatus`
// in the Prisma schema. Adding a new value DB-side requires a new entry here.
export const ReminderTypeEnum = z.enum([
  'INTAKE_START',
  'PAYMENT_DUE',
  'VISA_EXPIRY',
  'PASSPORT_EXPIRY',
  'INSURANCE_EXPIRY',
  'DOCUMENT_EXPIRY',
  'ENROLLMENT_DECISION_DUE',
  'COMMISSION_CLAIM_DUE',
  // SVT-QA-2026-08 — the scanner inserts this type (SVT-COMPLIANCE-REMINDERS-
  // 2026-06) but the wire enum omitted it, so any PATCH to a compliance-check
  // reminder returned 422 and downstream typed consumers couldn't case-analyse.
  'COMPLIANCE_CHECK_DUE',
  'CUSTOM',
]);
export type ReminderType = z.infer<typeof ReminderTypeEnum>;

export const ReminderStatusEnum = z.enum([
  'PENDING',
  'SENT',
  'ACKNOWLEDGED',
  'SNOOZED',
  'DISMISSED',
]);
export type ReminderStatus = z.infer<typeof ReminderStatusEnum>;

// Manual reminder creation. `scheduled_for` is optional — when absent the
// service will default to 09:00 UTC on `due_on`. Unknown keys are rejected so
// typos can't silently drop fields. `type` defaults to CUSTOM for manual rows;
// the scanner job sets type explicitly when it inserts auto-generated rows.
export const CreateReminderRequest = z
  .object({
    student_id: Uuid.optional(),
    enrollment_id: Uuid.optional(),
    type: ReminderTypeEnum.default('CUSTOM'),
    title: z.string().min(1).max(200),
    description: z.string().max(4000).optional(),
    due_on: Iso8601Date,
    scheduled_for: Iso8601DateTime.optional(),
    assigned_to_id: Uuid.optional(),
  })
  .strict();
export type CreateReminderRequest = z.infer<typeof CreateReminderRequest>;

// Partial of Create. We intentionally allow `type` to be patched even though
// the scanner won't normally do so — admins might re-classify a reminder.
export const UpdateReminderRequest = CreateReminderRequest.partial().strict();
export type UpdateReminderRequest = z.infer<typeof UpdateReminderRequest>;

export const SnoozeReminderRequest = z
  .object({ snooze_until: Iso8601DateTime })
  .strict();
export type SnoozeReminderRequest = z.infer<typeof SnoozeReminderRequest>;

// List filters. All optional; when none supplied the caller gets every row in
// the tenant. Date filters operate on `due_on` / `scheduled_for` independently.
export const ReminderListQuery = PaginationQuery.extend({
  // SVT-CONTRACT-2026-08 — `q` and `page` were sent by the Reminders tab from
  // the day it shipped (RemindersTab -> lib/queries buildReminderParams) but
  // were never declared here. Because this schema is `.strict()`, every
  // keystroke in the search box produced a 422 that nobody saw: the tab also
  // filters client-side over the rows already loaded, so the box appeared to
  // work while only ever searching the current page.
  q: z.string().trim().min(1).max(200).optional(),
  page: z.coerce.number().int().min(1).optional(),
  status: ReminderStatusEnum.optional(),
  type: ReminderTypeEnum.optional(),
  assigned_to_id: Uuid.optional(),
  student_id: Uuid.optional(),
  due_from: Iso8601Date.optional(),
  due_to: Iso8601Date.optional(),
  scheduled_from: Iso8601DateTime.optional(),
  scheduled_to: Iso8601DateTime.optional(),
}).strict();
export type ReminderListQuery = z.infer<typeof ReminderListQuery>;
