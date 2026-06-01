import type { StageCategory } from '@spv/zod-schemas';

// Server returns the full Prisma row. Optional StageBase fields surface as `null`
// (not undefined) on the wire because the service writes `?? null` on create/update.
export type Stage = {
  id: string;
  tenant_id: string;
  key: string;
  label: string;
  label_translations?: Record<string, string> | null;
  description: string | null;
  sequence: number;
  category: StageCategory;
  color_hex: string | null;
  icon: string | null;
  is_initial: boolean;
  is_terminal: boolean;
  is_active: boolean;
  sla_hours: number | null;
  destination_country: string | null;
  // v6 ----------------------------------------------------------------
  visa_type_id?: string | null;
  is_outcome_success?: boolean;
  is_outcome_failure?: boolean;
  show_on_dashboard?: boolean;
  prompt_date_label?: string | null;
};

// Slim VisaType shape used by the stages page filter / edit dialog.
export type VisaTypeOption = {
  id: string;
  country_code: string;
  name: string;
  short_name: string | null;
  is_active: boolean;
  is_generic: boolean;
};

export type StageTransition = {
  id: string;
  tenant_id: string;
  from_stage_id: string;
  to_stage_id: string;
  requires_role: string | null;
  from_stage?: { id: string; key: string; label: string; sequence: number };
  to_stage?: { id: string; key: string; label: string; sequence: number };
};
