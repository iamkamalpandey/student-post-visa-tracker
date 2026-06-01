// Lightweight row shapes for the institutions UI. We intentionally don't depend
// on Prisma types here; the API returns plain JSON so we model only what the UI
// actually consumes.
export type InstitutionType =
  | 'UNIVERSITY'
  | 'COLLEGE'
  | 'COMMUNITY_COLLEGE'
  | 'POLYTECHNIC'
  | 'LANGUAGE_SCHOOL'
  | 'PATHWAY_PROVIDER'
  | 'VOCATIONAL'
  | 'HIGH_SCHOOL'
  | 'OTHER';

export type InstitutionRow = {
  id: string;
  legal_name: string;
  display_name: string;
  short_name: string | null;
  type: InstitutionType;
  country_code: string;
  website: string | null;
  email: string | null;
  phone_e164: string | null;
  established_year: number | null;
  ranking_global: number | null;
  ranking_national: number | null;
  description: string | null;
  is_partner: boolean;
  partner_since: string | null;
  commission_pct: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  // Aggregate counts attached by the list/detail endpoints. The list response
  // exposes programs/campuses/schools; the detail exposes programs+enrollments.
  _count?: {
    programs?: number;
    campuses?: number;
    schools?: number;
    enrollments?: number;
    // SVT-SUPERAGENTS-2026-05: count of InstitutionSuperAgent links — drives
    // the "via N super-agents" chip on InstitutionCard.
    super_agent_links?: number;
  };
};

export type InstitutionDetail = InstitutionRow & {
  identifiers: IdentifierRow[];
  accreditations: AccreditationRow[];
  contacts: ContactRow[];
  campuses: CampusRow[];
  schools: SchoolRow[];
};

// (InstitutionRow._count.super_agent_links is the canonical count consumed by
// the card chip and the detail-page tab label.)

export type IdentifierRow = {
  id: string;
  scheme: 'CRICOS' | 'UKPRN' | 'OPEID' | 'DLI' | 'IPEDS' | 'PIC' | 'OTHER';
  value: string;
  issued_by: string | null;
  valid_from: string | null;
  valid_to: string | null;
};

export type AccreditationRow = {
  id: string;
  body: string;
  accreditation_no: string | null;
  awarded_on: string | null;
  expires_on: string | null;
  scope: string | null;
};

export type ContactRow = {
  id: string;
  full_name: string;
  designation: string | null;
  department: string | null;
  email: string | null;
  phone_e164: string | null;
  is_primary: boolean;
  notes: string | null;
};

export type CampusRow = {
  id: string;
  institution_id: string;
  name: string;
  is_main: boolean;
  is_active: boolean;
  timezone: string;
  phone_e164: string | null;
  email: string | null;
  address_id: string | null;
};

export type SchoolRow = {
  id: string;
  institution_id: string;
  name: string;
  short_name: string | null;
  is_active: boolean;
  departments?: DepartmentRow[];
  _count?: { programs: number; departments?: number };
};

export type DepartmentRow = {
  id: string;
  school_id: string;
  name: string;
  short_name: string | null;
  is_active: boolean;
};

// Matches the GET /api/v1/lookups/countries payload exactly. Earlier this type used
// a renamed `alpha2` field — dialogs read `c.alpha2` which was always undefined
// because the API returns `code_alpha2` (ISO 3166-1 long-form key).
export type CountryRow = {
  code_alpha2: string;
  code_alpha3?: string;
  numeric_code?: string;
  name: string;
  dial_code?: string;
  is_active?: boolean;
};

export const INSTITUTION_TYPES: { value: InstitutionType; label: string }[] = [
  { value: 'UNIVERSITY', label: 'University' },
  { value: 'COLLEGE', label: 'College' },
  { value: 'COMMUNITY_COLLEGE', label: 'Community college' },
  { value: 'POLYTECHNIC', label: 'Polytechnic' },
  { value: 'LANGUAGE_SCHOOL', label: 'Language school' },
  { value: 'PATHWAY_PROVIDER', label: 'Pathway provider' },
  { value: 'VOCATIONAL', label: 'Vocational' },
  { value: 'HIGH_SCHOOL', label: 'High school' },
  { value: 'OTHER', label: 'Other' },
];

export const IDENTIFIER_SCHEMES: { value: IdentifierRow['scheme']; label: string }[] = [
  { value: 'CRICOS', label: 'CRICOS (AU)' },
  { value: 'UKPRN', label: 'UKPRN (UK)' },
  { value: 'OPEID', label: 'OPEID (US)' },
  { value: 'DLI', label: 'DLI (CA)' },
  { value: 'IPEDS', label: 'IPEDS (US)' },
  { value: 'PIC', label: 'PIC (EU)' },
  { value: 'OTHER', label: 'Other' },
];
