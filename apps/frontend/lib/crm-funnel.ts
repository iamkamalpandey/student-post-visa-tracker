// SVT-V2-CRM-MIRROR-2026-06 — display mapping for the V2 LeadCourseState funnel.
// Mirrors V2's funnel-stages vocabulary so SPVT chips read the same as the CRM.

import type { ChipProps } from '@mui/material';

const LABELS: Record<string, string> = {
  documents_collection: 'Documents Collection',
  application_form: 'Application Form',
  offer_received_unconditional: 'Offer — Unconditional',
  offer_received_conditional: 'Offer — Conditional',
  offer_accepted: 'Offer Accepted',
  offer_rejected: 'Offer Rejected',
  visa_lodgement: 'Visa Applied',
  visa_accepted: 'Visa Accepted',
  visa_refused: 'Visa Refused',
};

const COLORS: Record<string, ChipProps['color']> = {
  offer_accepted: 'success',
  visa_accepted: 'success',
  offer_rejected: 'error',
  visa_refused: 'error',
  visa_lodgement: 'info',
};

export function funnelLabel(state: string | null | undefined): string {
  if (!state) return '—';
  return LABELS[state] ?? state.replace(/_/g, ' ');
}

export function funnelColor(state: string | null | undefined): ChipProps['color'] {
  if (!state) return 'default';
  return COLORS[state] ?? 'default';
}
