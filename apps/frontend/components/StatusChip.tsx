'use client';

import { Chip, type ChipProps } from '@mui/material';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import ScheduleOutlinedIcon from '@mui/icons-material/ScheduleOutlined';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import ErrorOutlineOutlinedIcon from '@mui/icons-material/ErrorOutlineOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import type { ReactElement } from 'react';

export type StatusChipProps = {
  status: string | null | undefined;
  size?: ChipProps['size'];
  /** Optional override; falls back to the built-in status→colour map. */
  color?: ChipProps['color'];
};

// Centralised map covering student / enrollment / finance / generic statuses.
const STATUS_COLOR: Record<string, ChipProps['color']> = {
  // Lifecycle
  ACTIVE: 'success',
  INACTIVE: 'default',
  ARCHIVED: 'default',
  DRAFT: 'default',
  PENDING: 'warning',
  IN_PROGRESS: 'info',
  IN_REVIEW: 'info',
  ON_HOLD: 'warning',
  URGENT: 'error',
  BLOCKED: 'error',
  COMPLETED: 'success',
  CANCELLED: 'default',
  REJECTED: 'error',
  APPROVED: 'success',
  // Enrollment
  ENROLLED: 'success',
  DEFERRED: 'warning',
  WITHDRAWN: 'default',
  GRADUATED: 'success',
  // Finance
  PAID: 'success',
  UNPAID: 'warning',
  PARTIAL: 'info',
  OVERDUE: 'error',
  REFUNDED: 'default',
  // Documents
  VERIFIED: 'success',
  EXPIRED: 'error',
  MISSING: 'error',
};

// WCAG 1.4.1 — never rely on colour alone. Each status family also gets a
// shape/icon prefix so the meaning is conveyed redundantly.
const SUCCESS_KEYS = new Set([
  'PAID',
  'COMPLETED',
  'ACKNOWLEDGED',
  'ENROLLED',
  'ACTIVE',
  'APPROVED',
  'VERIFIED',
  'GRADUATED',
]);
const PENDING_KEYS = new Set([
  'PENDING',
  'IN_PROGRESS',
  'IN_REVIEW',
  'QUEUED',
  'OFFERED',
  'PARTIAL',
]);
const WARNING_KEYS = new Set([
  'ON_HOLD',
  'DEFERRED',
  'SNOOZED',
  'DISPUTED',
  'UNPAID',
]);
const ERROR_KEYS = new Set([
  'FAILED',
  'REJECTED',
  'CANCELLED',
  'WITHDRAWN',
  'DISMISSED',
  'BLOCKED',
  'OVERDUE',
  'EXPIRED',
  'MISSING',
  'URGENT',
]);

export function statusIcon(key: string): ReactElement {
  if (SUCCESS_KEYS.has(key)) return <CheckCircleOutlinedIcon fontSize="small" />;
  if (PENDING_KEYS.has(key)) return <ScheduleOutlinedIcon fontSize="small" />;
  if (WARNING_KEYS.has(key)) return <WarningAmberOutlinedIcon fontSize="small" />;
  if (ERROR_KEYS.has(key)) return <ErrorOutlineOutlinedIcon fontSize="small" />;
  return <InfoOutlinedIcon fontSize="small" />;
}

function prettify(s: string): string {
  return s
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Coloured chip for arbitrary status enums (student, enrollment, finance, …). */
export default function StatusChip({ status, size = 'small', color }: StatusChipProps) {
  if (!status) {
    return <Chip size={size} label="—" variant="outlined" />;
  }
  const key = status.toString().toUpperCase().replace(/\s+/g, '_');
  const resolved = color ?? STATUS_COLOR[key] ?? 'default';
  return (
    <Chip
      size={size}
      icon={statusIcon(key)}
      label={prettify(status)}
      color={resolved}
      variant={resolved === 'default' ? 'outlined' : 'filled'}
      sx={{ fontWeight: 600, borderRadius: '999px' }}
    />
  );
}
