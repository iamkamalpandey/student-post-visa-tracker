// Per-stage checklist tasks (LifecycleStageChecklistItem) and per-student
// progress (StudentStageChecklistProgress). Used by the JourneyTab "current
// stage checklist" UI and the admin StageEditDialog "Checklist tasks" section.
import { z } from 'zod';
import { Iso8601DateTime, Uuid } from './common.js';

// ---------------------------------------------------------------------------
// Item: definition lives on the stage. Counsellors+admins write; viewers read.
// ---------------------------------------------------------------------------

export const CreateChecklistItemRequest = z
  .object({
    label: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    sequence: z.number().int().min(0).max(10000).optional(),
    is_required: z.boolean().optional(),
    sla_hours: z.number().int().min(0).max(100000).nullish(),
    is_active: z.boolean().optional(),
  })
  .strict();
export type CreateChecklistItemRequest = z.infer<typeof CreateChecklistItemRequest>;

export const UpdateChecklistItemRequest = z
  .object({
    label: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullish(),
    sequence: z.number().int().min(0).max(10000).optional(),
    is_required: z.boolean().optional(),
    sla_hours: z.number().int().min(0).max(100000).nullish(),
    is_active: z.boolean().optional(),
  })
  .strict();
export type UpdateChecklistItemRequest = z.infer<typeof UpdateChecklistItemRequest>;

export const ChecklistItemRow = z.object({
  id: Uuid,
  tenant_id: Uuid,
  stage_id: Uuid,
  label: z.string(),
  description: z.string().nullable(),
  sequence: z.number().int(),
  is_required: z.boolean(),
  sla_hours: z.number().int().nullable(),
  is_active: z.boolean(),
  created_at: Iso8601DateTime,
  updated_at: Iso8601DateTime,
  deleted_at: Iso8601DateTime.nullable(),
});
export type ChecklistItemRow = z.infer<typeof ChecklistItemRow>;

// ---------------------------------------------------------------------------
// Progress: per-student per-item. Upsert toggles completed_at on/off.
// ---------------------------------------------------------------------------

export const UpsertChecklistProgressRequest = z
  .object({
    checklist_item_id: Uuid,
    completed: z.boolean(),
    notes: z.string().max(2000).nullish(),
  })
  .strict();
export type UpsertChecklistProgressRequest = z.infer<typeof UpsertChecklistProgressRequest>;

export const ChecklistProgressRow = z.object({
  id: Uuid,
  tenant_id: Uuid,
  student_id: Uuid,
  stage_id: Uuid,
  checklist_item_id: Uuid,
  completed_at: Iso8601DateTime.nullable(),
  completed_by_id: Uuid.nullable(),
  notes: z.string().nullable(),
  created_at: Iso8601DateTime,
  updated_at: Iso8601DateTime,
});
export type ChecklistProgressRow = z.infer<typeof ChecklistProgressRow>;

// Query for listing a student's progress, scoped to a single stage.
export const ChecklistProgressListQuery = z
  .object({
    stage_id: Uuid,
  })
  .strict();
export type ChecklistProgressListQuery = z.infer<typeof ChecklistProgressListQuery>;
