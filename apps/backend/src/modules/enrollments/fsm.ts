// Enrollment status finite state machine.
//
// SVT-FSM-2026-05: this module is now a thin shim over the shared FSM
// framework (`apps/backend/src/shared/fsm.ts`). The transition table lives in
// `fsm-def.ts`; this file preserves the legacy public API
// (`ENROLLMENT_TRANSITIONS`, `assertTransitionAllowed`, `roleAtLeast`,
// `getAllowedTransitions`) so existing imports keep working without churn.
//
// Background: PATCH /enrollments/:id used to be fully open — a counsellor
// could flip COMPLETED → CANCELLED → ENROLLED freely, which corrupts the
// commission claim funnel. The shared FSM framework is now the single source
// of truth that closes that hole across all 7 status-bearing modules.

import type { EnrollmentStatus, UserRole } from '@prisma/client';
import {
  assertTransition,
  getAllowedNextStates,
  roleAtLeast as sharedRoleAtLeast,
  type TransitionRule,
} from '../../shared/fsm.js';
import { enrollmentFsm } from './fsm-def.js';

// Legacy alias kept for the rest of the module (tests, audit log helpers).
export const ENROLLMENT_TRANSITIONS: ReadonlyArray<TransitionRule<EnrollmentStatus>> =
  enrollmentFsm.transitions;

export const roleAtLeast = sharedRoleAtLeast;

/**
 * Enumerates the next states a given role can move to from `from`.
 * Used by GET /enrollments/fsm-state-options/:from style helpers and by the
 * FE when populating the status dropdown.
 */
export function getAllowedTransitions(
  from: EnrollmentStatus,
  role: UserRole,
): EnrollmentStatus[] {
  return getAllowedNextStates(enrollmentFsm, from, role);
}

export type TransitionCheck =
  | { ok: true }
  | { ok: false; status: number; detail: string };

/**
 * Validates a status transition under FSM + RBAC rules. Returns a
 * discriminated union the caller maps into HttpError.
 */
export function assertTransitionAllowed(
  from: EnrollmentStatus,
  to: EnrollmentStatus,
  role: UserRole,
  reasonCode?: string,
): TransitionCheck {
  const r = assertTransition(enrollmentFsm, from, to, role, reasonCode);
  if (r.ok) return { ok: true };
  return { ok: false, status: r.status, detail: r.detail };
}
