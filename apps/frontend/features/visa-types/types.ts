// Types for the v6 visa-type catalogue. Mirrors the Prisma VisaType model
// with timestamps as ISO strings on the wire.

export type VisaTypeRow = {
  id: string;
  tenant_id: string;
  country_code: string;
  name: string;
  short_name: string | null;
  description: string | null;
  is_active: boolean;
  is_generic: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

// Slim country shape pulled from /lookups/countries — only the fields the
// visa-types page actually needs.
export type CountryLite = {
  code_alpha2: string;
  name: string;
};
