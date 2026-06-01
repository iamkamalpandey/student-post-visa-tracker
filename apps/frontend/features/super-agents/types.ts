// Wire-row shapes for the v6 super-agents catalogue. Mirrors the Prisma
// SuperAgent model (timestamps as ISO strings, Decimal as string-or-number).
// Covers the expanded shape (status FSM + type + commission rules) the
// backend returns so the FE can opt into individual fields without forcing a
// fetch round-trip.

export type SuperAgentStatus = 'ACTIVE' | 'PAUSED' | 'TERMINATED';

export type SuperAgentTypeLite = {
  id: string;
  key: string;
  label: string;
};

export type SuperAgentRow = {
  id: string;
  tenant_id: string;
  type_id?: string | null;
  type?: SuperAgentTypeLite | null;
  name: string;
  short_name?: string | null;
  legal_name?: string | null;
  country_code?: string | null;
  website?: string | null;
  logo_url?: string | null;
  contact_email?: string | null;
  contact_phone_e164?: string | null;
  default_commission_pct?: string | number | null;
  default_currency?: string | null;
  payment_terms_days?: number | null;
  status: SuperAgentStatus;
  is_active: boolean;
  notes?: string | null;
  sub_processor_id?: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
};

// Pivot row exposed by GET /institutions/:id/super-agents — embeds a slim
// super-agent summary so the FE can render chips without a second fetch.
export type InstitutionSuperAgentLink = {
  id: string;
  tenant_id: string;
  institution_id: string;
  super_agent_id: string;
  is_preferred: boolean;
  notes?: string | null;
  created_at: string;
  super_agent?: {
    id: string;
    name: string;
    short_name?: string | null;
    is_active: boolean;
    status?: SuperAgentStatus;
  };
};
