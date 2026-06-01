// Shared row shapes for the students feature. Mirrors the response from the
// backend `/students` list endpoint. Hoisted here so dialogs and pages don't
// each redefine their own (drifting) copy.

export type StageRef = {
  id: string;
  key: string;
  label: string;
  sequence: number;
  category: string;
  color_hex?: string | null;
};

export type StudentRow = {
  id: string;
  student_code: string;
  given_name: string;
  family_name: string;
  status: string;
  nationality_code: string;
  created_at: string;
  current_stage: StageRef | null;
  current_stage_id: string | null;
};

export type StudentsResponse = {
  data: StudentRow[];
  page: { nextCursor: string | null; hasMore: boolean; total?: number };
};
