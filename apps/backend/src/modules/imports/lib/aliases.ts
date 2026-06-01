// Header aliasing tables for the bulk-import mapping suggester.
//
// Right-hand side is the canonical column name; left-hand side is a list of
// accepted spreadsheet headers (case-insensitive, normalised). Pulled out of
// imports.service.ts so the orchestrator stays small.

import type { ImportResource } from '@spv/zod-schemas';

export type AliasTable = Record<string, string[]>;

const STUDENT_ALIASES: AliasTable = {
  given_name: ['given name', 'first name', 'firstname', 'first_name', 'givenname'],
  family_name: ['family name', 'last name', 'lastname', 'surname', 'family_name', 'familyname'],
  middle_name: ['middle name', 'middlename', 'middle_name'],
  preferred_name: ['preferred name', 'nickname', 'preferred_name'],
  name_in_passport: ['name in passport', 'passport name', 'passportname', 'name_in_passport'],
  date_of_birth: ['date of birth', 'dob', 'birth date', 'birthdate', 'date_of_birth'],
  gender: ['gender', 'sex'],
  nationality_code: ['nationality', 'nationality code', 'country', 'nationality_code'],
  primary_language: ['language', 'primary language', 'primary_language', 'lang'],
  email_primary: ['email', 'primary email', 'email_primary'],
  email_secondary: ['secondary email', 'email_secondary', 'email2'],
  phone_primary_e164: ['phone', 'mobile', 'primary phone', 'phone_primary_e164'],
  phone_secondary_e164: ['secondary phone', 'phone_secondary_e164', 'phone2'],
  external_id: ['external id', 'external_id', 'ref', 'reference'],
};

const INSTITUTION_ALIASES: AliasTable = {
  legal_name: ['legal name', 'legal_name', 'official name'],
  display_name: ['display name', 'display_name', 'name'],
  short_name: ['short name', 'short_name', 'abbreviation'],
  type: ['type', 'institution type', 'institution_type'],
  country_code: ['country', 'country code', 'country_code'],
  website: ['website', 'url', 'web'],
  email: ['email', 'contact email'],
  phone_e164: ['phone', 'phone_e164', 'phone e164'],
  established_year: ['established', 'established year', 'established_year', 'founded'],
  ranking_global: ['ranking', 'ranking global', 'ranking_global', 'global ranking'],
  is_partner: ['is partner', 'is_partner', 'partner'],
  cricos: ['cricos', 'cricos code'],
  ukprn: ['ukprn'],
  opeid: ['opeid', 'ope id'],
  dli: ['dli', 'dli number'],
  pic: ['pic', 'pic code'],
};

const PROGRAM_ALIASES: AliasTable = {
  institution_legal_name: ['institution', 'institution legal name', 'institution_legal_name'],
  country_code: ['country', 'country code', 'country_code'],
  code: ['code', 'program code'],
  name: ['name', 'program name'],
  short_name: ['short name', 'short_name'],
  level: ['level', 'academic level', 'academic_level'],
  field_of_study: ['field of study', 'field_of_study', 'field'],
  isced_code: ['isced', 'isced code', 'isced_code'],
  delivery_mode: ['delivery', 'delivery mode', 'delivery_mode', 'mode'],
  language_of_instruction: ['language', 'language of instruction', 'language_of_instruction'],
  duration_months: ['duration', 'duration months', 'duration_months'],
  credit_hours: ['credit hours', 'credit_hours', 'credits'],
  description: ['description', 'desc'],
  url: ['url', 'website'],
  intake_year: ['intake year', 'intake_year', 'year'],
  intake_month: ['intake month', 'intake_month', 'month'],
  intake_label: ['intake label', 'intake_label', 'intake'],
};

const ENROLLMENT_ALIASES: AliasTable = {
  student_code: ['student code', 'student_code', 'student id', 'student'],
  institution_legal_name: ['institution', 'institution legal name', 'institution_legal_name'],
  country_code: ['country', 'country code', 'country_code'],
  program_name: ['program', 'program name', 'program_name'],
  program_level: ['program level', 'program_level', 'level'],
  intake_year: ['intake year', 'intake_year'],
  intake_month: ['intake month', 'intake_month'],
  campus_name: ['campus', 'campus name', 'campus_name'],
  enrollment_no: ['enrollment no', 'enrollment_no', 'enrollment number'],
  status: ['status', 'enrollment status'],
  tuition_total_minor: ['tuition total minor', 'tuition_total_minor'],
  tuition_total_major: ['tuition', 'tuition total', 'tuition_total_major'],
  tuition_currency: ['currency', 'tuition currency', 'tuition_currency'],
  scholarship_minor: ['scholarship minor', 'scholarship_minor'],
  scholarship_major: ['scholarship', 'scholarship_major'],
  agent_commission_minor: ['agent commission minor', 'agent_commission_minor'],
  agent_commission_major: ['agent commission', 'agent_commission_major', 'commission'],
  start_date: ['start date', 'start_date', 'starts on'],
  expected_end_date: ['expected end date', 'expected_end_date', 'end date'],
};

const PROGRAM_FEE_ALIASES: AliasTable = {
  institution_legal_name: ['institution', 'institution legal name', 'institution_legal_name'],
  country_code: ['country', 'country code', 'country_code'],
  program_name: ['program', 'program name', 'program_name'],
  program_level: ['program level', 'program_level', 'level'],
  intake_year: ['intake year', 'intake_year', 'year'],
  intake_month: ['intake month', 'intake_month', 'month'],
  campus_name: ['campus', 'campus name', 'campus_name'],
  audience: ['audience', 'fee audience', 'fee_audience'],
  fee_type: ['fee type', 'fee_type', 'type'],
  amount_minor: ['amount minor', 'amount_minor'],
  amount_major: ['amount', 'amount_major'],
  currency: ['currency', 'ccy'],
  per_period: ['per period', 'per_period', 'period'],
  is_estimated: ['is estimated', 'is_estimated', 'estimated'],
  effective_from: ['effective from', 'effective_from', 'effective'],
};

export const RESOURCE_ALIASES: Record<ImportResource, AliasTable> = {
  students: STUDENT_ALIASES,
  institutions: INSTITUTION_ALIASES,
  programs: PROGRAM_ALIASES,
  enrollments: ENROLLMENT_ALIASES,
  program_fees: PROGRAM_FEE_ALIASES,
};
