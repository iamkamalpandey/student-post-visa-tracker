import type { ReminderType, ReminderStatus } from '@spv/zod-schemas';

// Re-export the wire enums so feature modules don't have to thread the
// @spv/zod-schemas import through every file.
export type { ReminderType, ReminderStatus };

export type ReminderStudentRef = {
  id: string;
  student_code: string;
  given_name: string;
  family_name: string;
};

export type ReminderAssigneeRef = {
  id: string;
  given_name: string;
  family_name: string;
  display_name?: string | null;
};

// Mirror of the backend Reminder row + the optional joins we ask the list
// endpoint to embed for display. Optional fields are written as nullable to
// match the JSON the API is documented to emit.
export type Reminder = {
  id: string;
  tenant_id: string;
  student_id?: string | null;
  enrollment_id?: string | null;
  type: ReminderType;
  source_entity_type?: string | null;
  source_entity_id?: string | null;
  title: string;
  description?: string | null;
  due_on: string;
  scheduled_for: string;
  assigned_to_id?: string | null;
  status: ReminderStatus;
  fire_count: number;
  sent_at?: string | null;
  acknowledged_at?: string | null;
  snooze_until?: string | null;
  created_at: string;
  // SVT-V2-CRM-MIRROR-2026-06 — deep-link target set by the reminder scanner.
  metadata?: { href?: string | null } | null;

  // Embedded display joins — optional because the underlying API may omit them.
  student?: ReminderStudentRef | null;
  assigned_to?: ReminderAssigneeRef | null;
};

// Display ordering used by selects + chips. Keep CUSTOM first because that's
// the most-common manual-create case; the rest mirrors the wire enum order.
export const REMINDER_TYPES: ReminderType[] = [
  'CUSTOM',
  'INTAKE_START',
  'PAYMENT_DUE',
  'VISA_EXPIRY',
  'PASSPORT_EXPIRY',
  'INSURANCE_EXPIRY',
  'DOCUMENT_EXPIRY',
  'ENROLLMENT_DECISION_DUE',
  'COMMISSION_CLAIM_DUE',
  'COMPLIANCE_CHECK_DUE',
];

export const REMINDER_STATUSES: ReminderStatus[] = [
  'PENDING',
  'SENT',
  'ACKNOWLEDGED',
  'SNOOZED',
  'DISMISSED',
];

// Muted color palette — one swatch per type. Picked to be distinguishable on
// both light and dark themes without competing with the stage chips. Keys
// must match the ReminderTypeEnum exactly.
export const REMINDER_TYPE_COLORS: Record<ReminderType, { bg: string; fg: string }> = {
  CUSTOM:                  { bg: '#E3F2FD', fg: '#1565C0' }, // blue
  INTAKE_START:            { bg: '#F1F8E9', fg: '#33691E' }, // light green
  PAYMENT_DUE:             { bg: '#FFF8E1', fg: '#8D6E00' }, // amber
  VISA_EXPIRY:             { bg: '#FFEBEE', fg: '#B71C1C' }, // red
  PASSPORT_EXPIRY:         { bg: '#EDE7F6', fg: '#4527A0' }, // deep purple
  INSURANCE_EXPIRY:        { bg: '#E0F2F1', fg: '#00695C' }, // teal
  DOCUMENT_EXPIRY:         { bg: '#F3E5F5', fg: '#6A1B9A' }, // purple
  ENROLLMENT_DECISION_DUE: { bg: '#FFF3E0', fg: '#E65100' }, // orange
  COMMISSION_CLAIM_DUE:    { bg: '#ECEFF1', fg: '#37474F' }, // blue-grey
  COMPLIANCE_CHECK_DUE:    { bg: '#FCE4EC', fg: '#AD1457' }, // pink — regulator-clock
};

export function prettifyType(type: string): string {
  return type
    .replace(/_/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function assigneeLabel(a?: ReminderAssigneeRef | null): string {
  if (!a) return 'Unassigned';
  if (a.display_name && a.display_name.trim()) return a.display_name;
  const name = `${a.given_name ?? ''} ${a.family_name ?? ''}`.trim();
  return name || 'Unassigned';
}

export function studentLabel(s?: ReminderStudentRef | null): string {
  if (!s) return '';
  return `${s.given_name} ${s.family_name}`.trim();
}
