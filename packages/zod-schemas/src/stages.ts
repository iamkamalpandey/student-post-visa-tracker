import { z } from 'zod';
import { CountryAlpha2, RoleEnum, Uuid } from './common.js';

// Mirrors Postgres `StageCategory`. IN_PROGRESS is the safe default for non-classified stages.
export const StageCategoryEnum = z.enum([
  'PRE_DEPARTURE',
  'IN_TRANSIT',
  'POST_ARRIVAL',
  'ENROLLED',
  'COMPLETED',
  'EXCEPTION',
  'IN_PROGRESS',
]);
export type StageCategory = z.infer<typeof StageCategoryEnum>;

// kebab-case slug, 2..64 chars, unique per tenant. Validated client-side here so the
// service only has to handle uniqueness.
const StageKey = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, 'key must be lowercase slug (a-z0-9, - or _ separators)');

const HexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'color_hex must be #RRGGBB');

// Strict so unknown keys fail validation rather than silently being dropped.
// Defined as a plain ZodObject so we can call .partial() on it for the update
// schema; the XOR refinement is applied to Create / Update separately.
export const StageBase = z
  .object({
    key: StageKey,
    label: z.string().min(1).max(120),
    // Free-form translation map; validated as JSON by the API surface — the service
    // can apply a stricter schema later if/when locales are constrained.
    label_translations: z.record(z.string(), z.string()).optional(),
    description: z.string().max(2000).optional(),
    sequence: z.number().int().min(0).max(10000),
    category: StageCategoryEnum,
    color_hex: HexColor.optional(),
    icon: z.string().max(64).optional(),
    is_initial: z.boolean().default(false),
    is_terminal: z.boolean().default(false),
    sla_hours: z.number().int().min(0).max(24 * 365).optional(),
    destination_country: CountryAlpha2.optional(),
    // v6 ---------------------------------------------------------------
    // Pin a stage to a specific visa workflow. Null/undefined keeps the
    // stage generic (applies regardless of visa type).
    visa_type_id: Uuid.nullable().optional(),
    // Outcome flags. Flipping one of these on entry triggers backend
    // side-effects (commission recalc on success, reminder on failure).
    // Mutually exclusive — refined on Create/Update.
    is_outcome_success: z.boolean().default(false),
    is_outcome_failure: z.boolean().default(false),
    // Dashboard widget filter — opt-OUT (default true).
    show_on_dashboard: z.boolean().default(true),
    // When set, AdvanceStageDialog renders an extra date input with this label.
    // The captured value lands in the lifecycle event's metadata as `prompt_date`.
    prompt_date_label: z.string().min(1).max(120).nullable().optional(),
  })
  .strict();
export type StageBase = z.infer<typeof StageBase>;

// Refines outcome flags to be mutually exclusive. Allows both being unset
// (the default — most stages have no outcome semantics).
function refineOutcome<T extends { is_outcome_success?: boolean; is_outcome_failure?: boolean }>(
  v: T,
): boolean {
  return !(v.is_outcome_success === true && v.is_outcome_failure === true);
}
const outcomeMessage = 'is_outcome_success and is_outcome_failure are mutually exclusive';

export const CreateStageRequest = StageBase.refine(refineOutcome, {
  message: outcomeMessage,
  path: ['is_outcome_failure'],
});
export type CreateStageRequest = z.infer<typeof CreateStageRequest>;

// Update is a partial; admins can flip is_active too. Same XOR check applies
// when both flags happen to be set in the patch payload.
export const UpdateStageRequest = StageBase.partial()
  .extend({ is_active: z.boolean().optional() })
  .strict()
  .refine(refineOutcome, {
    message: outcomeMessage,
    path: ['is_outcome_failure'],
  });
export type UpdateStageRequest = z.infer<typeof UpdateStageRequest>;

// Bulk reorder: small array of (id, sequence) pairs applied in a single transaction.
export const ReorderStagesRequest = z
  .object({
    items: z
      .array(
        z
          .object({
            id: Uuid,
            sequence: z.number().int().min(0).max(10000),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export type ReorderStagesRequest = z.infer<typeof ReorderStagesRequest>;

// requires_role gates the transition to a specific role; null = any authenticated role.
export const CreateTransitionRequest = z
  .object({
    from_stage_id: Uuid,
    to_stage_id: Uuid,
    requires_role: RoleEnum.optional(),
  })
  .strict()
  .refine((v) => v.from_stage_id !== v.to_stage_id, {
    message: 'from_stage_id and to_stage_id must differ',
    path: ['to_stage_id'],
  });
export type CreateTransitionRequest = z.infer<typeof CreateTransitionRequest>;

// Used by POST /stages/preview-impact to estimate fallout from a stage edit/deletion.
export const PreviewImpactRequest = z
  .object({
    stage_id: Uuid,
    action: z.enum(['delete', 'deactivate']),
  })
  .strict();
export type PreviewImpactRequest = z.infer<typeof PreviewImpactRequest>;
