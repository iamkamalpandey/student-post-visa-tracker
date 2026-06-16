export type InterviewQuestionRow = {
  id: string;
  tenant_id: string;
  country_code: string;
  academic_level: string | null;
  institution_id: string | null;
  institution: { id: string; display_name: string } | null;
  category: string;
  question_text: string;
  model_answer: string | null;
  tips: string | null;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type InterviewAttemptRow = {
  id: string;
  tenant_id: string;
  candidate_name: string;
  candidate_email: string;
  country_code: string;
  institution_name: string;
  course_name: string;
  academic_level: string;
  intake_label: string;
  has_i20: boolean;
  question_count: number;
  answered_count: number;
  status: 'IN_PROGRESS' | 'COMPLETED' | 'ABANDONED';
  started_at: string;
  completed_at: string | null;
};

export type InterviewAnswerRow = {
  id: string;
  attempt_id: string;
  question_id: string;
  answer_text: string;
  answered_at: string;
  time_spent_seconds: number | null;
  question: {
    question_text: string;
    model_answer: string | null;
    tips: string | null;
    category: string;
  };
};

export type CountryLite = { code_alpha2: string; name: string };
export type InstitutionLite = { id: string; display_name: string };
