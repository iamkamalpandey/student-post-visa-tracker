// Mirror of apps/backend/src/modules/enrollments/fsm.ts.
//
// Kept hand-synced (small + rarely changes) so the FE can pre-filter the
// status dropdown without an extra round-trip. The backend remains the
// authoritative gate — this is purely a UX nicety.
//
// If the backend table changes, update this file in the same commit.

export type EnrollmentStatus =
  | 'OFFERED'
  | 'ACCEPTED'
  | 'ENROLLED'
  | 'DEFERRED'
  | 'WITHDRAWN'
  | 'COMPLETED'
  | 'CANCELLED';

export type Role = 'ADMIN' | 'COUNSELLOR' | 'VIEWER';

export type EnrollmentTransition = {
  from: EnrollmentStatus;
  to: EnrollmentStatus;
  requires_role: Role;
  require_reason?: boolean;
};

export const ENROLLMENT_TRANSITIONS: EnrollmentTransition[] = [
  // Forward path
  { from: 'OFFERED',  to: 'ACCEPTED',  requires_role: 'COUNSELLOR' },
  { from: 'OFFERED',  to: 'CANCELLED', requires_role: 'COUNSELLOR' },
  { from: 'ACCEPTED', to: 'ENROLLED',  requires_role: 'COUNSELLOR' },
  { from: 'ACCEPTED', to: 'DEFERRED',  requires_role: 'COUNSELLOR', require_reason: true },
  { from: 'ACCEPTED', to: 'WITHDRAWN', requires_role: 'COUNSELLOR', require_reason: true },
  { from: 'ACCEPTED', to: 'CANCELLED', requires_role: 'ADMIN',      require_reason: true },
  { from: 'ENROLLED', to: 'COMPLETED', requires_role: 'COUNSELLOR' },
  { from: 'ENROLLED', to: 'WITHDRAWN', requires_role: 'COUNSELLOR', require_reason: true },
  { from: 'ENROLLED', to: 'DEFERRED',  requires_role: 'ADMIN',      require_reason: true },
  { from: 'DEFERRED', to: 'ENROLLED',  requires_role: 'COUNSELLOR' },
  { from: 'DEFERRED', to: 'WITHDRAWN', requires_role: 'ADMIN',      require_reason: true },
  // Admin-only rollbacks
  { from: 'COMPLETED', to: 'ENROLLED', requires_role: 'ADMIN', require_reason: true },
  { from: 'WITHDRAWN', to: 'ENROLLED', requires_role: 'ADMIN', require_reason: true },
  { from: 'CANCELLED', to: 'OFFERED',  requires_role: 'ADMIN', require_reason: true },
];

const roleOrder: Record<Role, number> = { VIEWER: 0, COUNSELLOR: 1, ADMIN: 2 };

export function roleAtLeast(actor: Role | undefined | null, required: Role): boolean {
  if (!actor) return false;
  return roleOrder[actor] >= roleOrder[required];
}

/**
 * The list of states a user with `role` may move to from `currentStatus`.
 * Empty array means the user can't move anywhere from here (terminal for them).
 */
export function getAllowedNextStates(
  currentStatus: EnrollmentStatus,
  role: Role | undefined | null,
): EnrollmentStatus[] {
  if (!role) return [];
  return ENROLLMENT_TRANSITIONS
    .filter((t) => t.from === currentStatus && roleAtLeast(role, t.requires_role))
    .map((t) => t.to);
}

/** Does the (from, to) edge require a reason_code? */
export function transitionRequiresReason(
  from: EnrollmentStatus,
  to: EnrollmentStatus,
): boolean {
  if (from === to) return false;
  const t = ENROLLMENT_TRANSITIONS.find((x) => x.from === from && x.to === to);
  return Boolean(t?.require_reason);
}
