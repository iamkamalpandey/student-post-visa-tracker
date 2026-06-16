// SVT-V2-CRM-MIRROR-2026-06 — row shapes read from the V2 MIS Postgres.
// Field names mirror V2's actual columns (camelCase + snake mix). pg returns
// NUMERIC/Decimal as string, DATE/TIMESTAMP as Date, int as number.

export type V2Country = {
  id: number;
  name: string;
  signature: string;
  currency_code: string | null;
};

export type V2Institution = {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  post_code: string | null;
  currency_code: string | null;
  category: string | null;
  logo: string | null;
  isActive: boolean | null;
  countryId: number;
};

export type V2Course = {
  id: number;
  name: string;
  description: string | null;
  type: string | null;
  category: string | null;
  start_date: string | null;
  end_date: string | null;
  fee: string | null;
  feeAmount: string | null; // NUMERIC → string
  feeCurrency: string | null;
  institutionId: number | null;
};

export type V2Lead = {
  id: number;
  first_name: string;
  last_name: string;
  phone_number: string;
  secondary_number: string | null;
  gender: string | null;
  address: string | null;
  dob: string | null;
  email: string | null;
  city: string | null;
  source: string | null;
  type: string | null;
  interested_course: string | null;
  field_of_study: string | null;
  intake_month: string | null;
  application_status: string | null;
  profile_status: string | null;
  profile_statusV2: string | null;
  counsellor_status: boolean | null;
  isArchived: boolean | null;
  dropout: boolean | null;
  priority: string | null;
  tags: string[] | null;
  slc_institution_name: string | null;
  slc_grade: string | null;
  slc_year: string | null;
  highschool_institution_name: string | null;
  highschool_grade: string | null;
  highschool_year: string | null;
  bachelors_institution_name: string | null;
  bachelors_grade: string | null;
  bachelors_year: string | null;
  masters_institution_name: string | null;
  masters_grade: string | null;
  masters_year: string | null;
  ielts_overall_score: string | null;
  ielts_listening_score: string | null;
  ielts_reading_score: string | null;
  ielts_writing_score: string | null;
  ielts_speaking_score: string | null;
  ielts_date: string | null;
  pte_overall_score: string | null;
  pte_listening_score: string | null;
  pte_reading_score: string | null;
  pte_writing_score: string | null;
  pte_speaking_score: string | null;
  pte_date: string | null;
  sat_overall_score: string | null;
  sat_math_score: string | null;
  sat_reading_score: string | null;
  sat_writing_and_language_score: string | null;
  sat_date: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmTerm: string | null;
  utmContent: string | null;
  landingPage: string | null;
  referrer: string | null;
  firstTouchedAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

export type V2Application = {
  id: number;
  leadId: number;
  courseId: number;
  intakeKey: string;
  state: string | null;
  notes: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  deletedAt: Date | null;
};

export type V2LeadCourse = {
  leadId: number;
  courseId: number;
  state: string | null;
  stateV2: string | null;
  subState: string | null;
  startDate: Date | null;
  endDate: Date | null;
  isDeleted: boolean | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

export type V2History = {
  id: number;
  leadId: number;
  courseId: number;
  fromState: string | null;
  toState: string;
  changedBy: string | null;
  changedAt: Date;
};

export type V2Payment = {
  id: number;
  studentId: number;
  classId: number | null;
  amount: string;
  currency: string | null;
  method: string;
  cashAmount: string | null;
  onlineAmount: string | null;
  bankRef: string | null;
  voucherNo: string | null;
  receiptNo: string | null;
  receivedById: string | null;
  receivedAt: Date;
  notes: string | null;
  lead_v2_id: number; // from JOIN Student.leadId
};

export type V2Remark = {
  id: number;
  leadId: number;
  userId: string | null;
  content: string;
  createdAt: Date | null;
  updatedAt: Date | null;
};

export type V2FollowUp = {
  id: number;
  leadId: number;
  userId: string | null;
  date: Date;
  status: string | null;
  createdAt: Date | null;
};

export type V2Call = {
  id: number;
  leadId: number;
  userId: string | null;
  status: string;
  notes: string | null;
  createdAt: Date | null;
};

export type V2Visit = {
  id: number;
  leadId: number;
  userId: string | null;
  actorId: string | null;
  branchId: number | null;
  campaignId: number | null;
  date: string;
  purpose: string;
  outcome: string | null;
  sourceText: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

// AssignedUser + Follower share this shape; ingest tags `kind`.
export type V2Assignment = {
  id: number;
  leadId: number;
  userId: string;
  isActive: boolean | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  kind: 'ASSIGNEE' | 'FOLLOWER';
};

export type V2Qualification = {
  id: number;
  leadId: number;
  level: string;
  institution_name: string | null;
  board_or_university: string | null;
  stream_or_major: string | null;
  grade: string | null;
  grade_scale: string | null;
  start_year: number | null;
  end_year: number | null;
  is_ongoing: boolean | null;
  division: string | null;
  notes: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

export type V2LanguageTest = {
  id: number;
  leadId: number;
  test_type: string;
  custom_test_name: string | null;
  test_date: Date | null;
  overall_score: string | null;
  listening_score: string | null;
  reading_score: string | null;
  writing_score: string | null;
  speaking_score: string | null;
  extra_scores: unknown;
  test_center: string | null;
  reference_no: string | null;
  is_official: boolean | null;
  notes: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

export type V2Guardian = {
  id: number;
  leadId: number;
  full_name: string;
  relationship_type: string;
  custom_relationship_label: string | null;
  phone: string | null;
  secondary_phone: string | null;
  email: string | null;
  address: string | null;
  occupation: string | null;
  notes: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

// Aggregate dump pulled in one read pass, scoped to visa-accepted leads.
export type V2CrmDump = {
  countries: V2Country[];
  institutions: V2Institution[];
  courses: V2Course[];
  leads: V2Lead[];
  applications: V2Application[];
  leadCourses: V2LeadCourse[];
  history: V2History[];
  payments: V2Payment[];
  remarks: V2Remark[];
  followUps: V2FollowUp[];
  calls: V2Call[];
  visits: V2Visit[];
  assignments: V2Assignment[];
  qualifications: V2Qualification[];
  languageTests: V2LanguageTest[];
  guardians: V2Guardian[];
};
