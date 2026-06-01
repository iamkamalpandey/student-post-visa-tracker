// SVT-WAVE6-SAVE-BLOCKED-2026-05 — shared hook for "why is Save disabled?".
//
// Pattern: every form dialog with a Save button needs to tell the user WHY the
// button is disabled. Most dialogs already compute `saveDisabled` but only ~3
// of ~15 actually render an explanation. This hook centralises the logic so
// the message text stays consistent across the app.
//
// Returns:
//   - disabled: boolean — pass directly to the primary action's `disabled`.
//   - reason: string | null — render under the action (or as helperText) when
//     non-null. Null means the button is enabled (or actively submitting,
//     where the disabled-spinner already explains itself).
//
// Inputs map to react-hook-form's `formState` + the mutation status:
//   - isDirty: form has unsaved edits (RHF: formState.isDirty)
//   - isValid: form passes schema (RHF: formState.isValid). Optional; pass
//     undefined to skip validity gating.
//   - isSubmitting: form is mid-submit (RHF or mutation flight).
//   - submitting: external flag (mutation.isPending). OR-ed with isSubmitting.
//
// Edge cases:
//   - Pure-create dialogs that don't track isDirty (e.g. mark-paid) should
//     pass isDirty=true so the helper just gates on submitting + validity.

export type SaveBlockedInput = {
  isDirty: boolean;
  /** Optional — when present, false renders the "Fix errors above" hint. */
  isValid?: boolean;
  isSubmitting: boolean;
  /** External mutation-pending flag; OR-ed with isSubmitting. */
  submitting?: boolean;
};

export type SaveBlockedResult = {
  disabled: boolean;
  reason: string | null;
};

export function useSaveBlockedReason(input: SaveBlockedInput): SaveBlockedResult {
  const busy = input.isSubmitting || Boolean(input.submitting);
  const invalid = input.isValid === false;
  const disabled = !input.isDirty || invalid || busy;
  if (busy) return { disabled, reason: null };
  if (!input.isDirty) return { disabled, reason: 'Make a change to enable saving.' };
  if (invalid) return { disabled, reason: 'Fix errors above to enable saving.' };
  return { disabled: false, reason: null };
}
