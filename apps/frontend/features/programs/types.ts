// Lightweight row shapes for the programs UI.
// AcademicLevel — international study-abroad standard, ISCED-2011 aligned. Mirrors the
// Prisma enum at apps/backend/prisma/schema.prisma.
export type AcademicLevel =
  | 'PRIMARY'
  | 'LOWER_SECONDARY'
  | 'UPPER_SECONDARY'
  | 'POST_SECONDARY_NON_TERTIARY'
  | 'FOUNDATION'
  | 'ASSOCIATE'
  | 'DIPLOMA'
  | 'ADVANCED_DIPLOMA'
  | 'BACHELORS'
  | 'GRADUATE_CERTIFICATE'
  | 'GRADUATE_DIPLOMA'
  | 'POSTGRADUATE_CERTIFICATE'
  | 'POSTGRADUATE_DIPLOMA'
  | 'MASTERS'
  | 'MPHIL'
  | 'DOCTORATE'
  | 'PROFESSIONAL'
  | 'CERTIFICATE'
  | 'OTHER';

export type DeliveryMode = 'IN_PERSON' | 'ONLINE' | 'HYBRID' | 'DISTANCE';

export type RequirementCategory =
  | 'ACADEMIC'
  | 'LANGUAGE'
  | 'TEST'
  | 'WORK_EXPERIENCE'
  | 'PORTFOLIO'
  | 'INTERVIEW'
  | 'DOCUMENT'
  | 'FINANCIAL'
  | 'OTHER';

export type FeeAudience = 'DOMESTIC' | 'INTERNATIONAL' | 'REGIONAL' | 'OTHER';
export type FeeType =
  | 'TUITION'
  | 'REGISTRATION'
  | 'APPLICATION'
  | 'DEPOSIT'
  | 'MATERIALS'
  | 'LIVING_COST_ESTIMATE'
  | 'OTHER';
export type FeePeriod = 'TOTAL' | 'YEAR' | 'SEMESTER' | 'TERM' | 'MONTH' | 'MODULE';

// Cadence pattern — mirrors `DurationPatternEnum` in @spv/zod-schemas.
export type DurationPattern =
  | 'SEMESTER_2_PER_YEAR'
  | 'TRIMESTER_3_PER_YEAR'
  | 'QUARTER_4_PER_YEAR'
  | 'ANNUAL_COHORT'
  | 'BIANNUAL_2_YEARS'
  | 'CONTINUOUS_ENROLLMENT'
  | 'MONTHLY_INTAKE'
  | 'MODULAR';

export type ProgramRow = {
  id: string;
  institution_id: string;
  school_id: string | null;
  department_id: string | null;
  code: string | null;
  name: string;
  short_name: string | null;
  level: AcademicLevel;
  field_of_study: string | null;
  isced_code: string | null;
  delivery_mode: DeliveryMode;
  language_of_instruction: string;
  duration_months: number;
  credit_hours: number | null;
  description: string | null;
  url: string | null;
  is_active: boolean;
  version: number;
  duration_pattern?: DurationPattern | null;
  terms_per_year?: number | null;
  institution?: { id: string; display_name: string; country_code: string };
  // Aggregate counts attached by the program list endpoint.
  _count?: { intakes?: number; requirements?: number; modules?: number };
};

export type ProgramDetail = ProgramRow & {
  intakes: ProgramIntakeRow[];
  requirements: ProgramRequirementRow[];
  modules: ProgramModuleRow[];
  school?: { id: string; name: string } | null;
  department?: { id: string; name: string } | null;
};

export type ProgramIntakeRow = {
  id: string;
  program_id: string;
  campus_id: string | null;
  intake_year: number;
  intake_month: number;
  intake_label: string;
  application_open: string | null;
  application_close: string | null;
  decision_date: string | null;
  classes_start_on: string | null;
  classes_end_on: string | null;
  capacity: number | null;
  is_open: boolean;
  notes: string | null;
  campus?: { id: string; name: string } | null;
  fees?: ProgramFeeRow[];
};

export type ProgramFeeRow = {
  id: string;
  program_intake_id: string;
  audience: FeeAudience;
  fee_type: FeeType;
  amount_minor: string | number;
  currency: string;
  per_period: FeePeriod;
  is_estimated: boolean;
  effective_from: string | null;
  notes: string | null;
};

export type ProgramRequirementRow = {
  id: string;
  program_id: string;
  category: RequirementCategory;
  label: string;
  details: string | null;
  min_value: string | null;
  unit: string | null;
  is_mandatory: boolean;
};

export type ProgramModuleRow = {
  id: string;
  program_id: string;
  code: string;
  title: string;
  credits: string | null;
  semester: number | null;
  is_core: boolean;
  description: string | null;
};

// Ordered roughly by ladder rung. Labels are user-facing.
export const ACADEMIC_LEVELS: { value: AcademicLevel; label: string }[] = [
  { value: 'PRIMARY', label: 'Primary' },
  { value: 'LOWER_SECONDARY', label: 'Lower secondary' },
  { value: 'UPPER_SECONDARY', label: 'Upper secondary (A-level / IB / +2)' },
  { value: 'POST_SECONDARY_NON_TERTIARY', label: 'Post-secondary (non-tertiary)' },
  { value: 'FOUNDATION', label: 'Foundation / pathway' },
  { value: 'ASSOCIATE', label: 'Associate' },
  { value: 'DIPLOMA', label: 'Diploma' },
  { value: 'ADVANCED_DIPLOMA', label: 'Advanced diploma' },
  { value: 'BACHELORS', label: "Bachelor's" },
  { value: 'GRADUATE_CERTIFICATE', label: 'Graduate certificate' },
  { value: 'GRADUATE_DIPLOMA', label: 'Graduate diploma' },
  { value: 'POSTGRADUATE_CERTIFICATE', label: 'Postgraduate certificate' },
  { value: 'POSTGRADUATE_DIPLOMA', label: 'Postgraduate diploma' },
  { value: 'MASTERS', label: "Master's" },
  { value: 'MPHIL', label: 'MPhil' },
  { value: 'DOCTORATE', label: 'Doctorate (PhD)' },
  { value: 'PROFESSIONAL', label: 'Professional (MBBS / JD / etc.)' },
  { value: 'CERTIFICATE', label: 'Certificate' },
  { value: 'OTHER', label: 'Other' },
];

export const DELIVERY_MODES: { value: DeliveryMode; label: string }[] = [
  { value: 'IN_PERSON', label: 'In person' },
  { value: 'ONLINE', label: 'Online' },
  { value: 'HYBRID', label: 'Hybrid' },
  { value: 'DISTANCE', label: 'Distance' },
];

export const REQUIREMENT_CATEGORIES: { value: RequirementCategory; label: string }[] = [
  { value: 'ACADEMIC', label: 'Academic' },
  { value: 'LANGUAGE', label: 'Language' },
  { value: 'TEST', label: 'Test' },
  { value: 'WORK_EXPERIENCE', label: 'Work experience' },
  { value: 'PORTFOLIO', label: 'Portfolio' },
  { value: 'INTERVIEW', label: 'Interview' },
  { value: 'DOCUMENT', label: 'Document' },
  { value: 'FINANCIAL', label: 'Financial' },
  { value: 'OTHER', label: 'Other' },
];

export const FEE_AUDIENCES: { value: FeeAudience; label: string }[] = [
  { value: 'DOMESTIC', label: 'Domestic' },
  { value: 'INTERNATIONAL', label: 'International' },
  { value: 'REGIONAL', label: 'Regional' },
  { value: 'OTHER', label: 'Other' },
];

export const FEE_TYPES: { value: FeeType; label: string }[] = [
  { value: 'TUITION', label: 'Tuition' },
  { value: 'REGISTRATION', label: 'Registration' },
  { value: 'APPLICATION', label: 'Application' },
  { value: 'DEPOSIT', label: 'Deposit' },
  { value: 'MATERIALS', label: 'Materials' },
  { value: 'LIVING_COST_ESTIMATE', label: 'Living cost estimate' },
  { value: 'OTHER', label: 'Other' },
];

export const FEE_PERIODS: { value: FeePeriod; label: string }[] = [
  { value: 'TOTAL', label: 'Total' },
  { value: 'YEAR', label: 'Per year' },
  { value: 'SEMESTER', label: 'Per semester' },
  { value: 'TERM', label: 'Per term' },
  { value: 'MONTH', label: 'Per month' },
  { value: 'MODULE', label: 'Per module' },
];

// Cadence options for the Select control. `null` slots in the lookup mean
// "no fixed cadence" — terms_per_year should be left blank.
export const DURATION_PATTERNS: { value: DurationPattern; label: string }[] = [
  { value: 'SEMESTER_2_PER_YEAR', label: 'Semesters (2/year)' },
  { value: 'TRIMESTER_3_PER_YEAR', label: 'Trimesters (3/year)' },
  { value: 'QUARTER_4_PER_YEAR', label: 'Quarters (4/year)' },
  { value: 'ANNUAL_COHORT', label: 'Annual cohort (1/year)' },
  { value: 'BIANNUAL_2_YEARS', label: 'Biannual (1 every 2 years)' },
  { value: 'CONTINUOUS_ENROLLMENT', label: 'Continuous enrollment' },
  { value: 'MONTHLY_INTAKE', label: 'Monthly intake' },
  { value: 'MODULAR', label: 'Modular' },
];

// Default terms_per_year per cadence; mirrors zod-schemas constant.
export const DURATION_PATTERN_TERMS_PER_YEAR: Record<DurationPattern, number | null> = {
  SEMESTER_2_PER_YEAR: 2,
  TRIMESTER_3_PER_YEAR: 3,
  QUARTER_4_PER_YEAR: 4,
  ANNUAL_COHORT: 1,
  BIANNUAL_2_YEARS: 1,
  CONTINUOUS_ENROLLMENT: null,
  MONTHLY_INTAKE: 12,
  MODULAR: null,
};

export const MONTHS: { value: number; label: string }[] = [
  { value: 1, label: 'January' },
  { value: 2, label: 'February' },
  { value: 3, label: 'March' },
  { value: 4, label: 'April' },
  { value: 5, label: 'May' },
  { value: 6, label: 'June' },
  { value: 7, label: 'July' },
  { value: 8, label: 'August' },
  { value: 9, label: 'September' },
  { value: 10, label: 'October' },
  { value: 11, label: 'November' },
  { value: 12, label: 'December' },
];
