// SVT-FSM-2026-05: Enrollment status FSM definition.
//
// Migrates the inline ENROLLMENT_TRANSITIONS table from fsm.ts. Behaviour
// preserved 1:1 — the existing fsm.ts is now a thin shim that re-exports
// `assertTransitionAllowed` (returning a discriminated union) by delegating
// to the shared framework's `assertTransition`.
import { defineMachine } from '../../shared/fsm.js';
import type { EnrollmentStatus } from '@prisma/client';

export const enrollmentFsm = defineMachine<EnrollmentStatus>({
  name: 'enrollment',
  states: ['OFFERED', 'ACCEPTED', 'ENROLLED', 'ON_LEAVE', 'DEFERRED', 'WITHDRAWN', 'COMPLETED', 'CANCELLED'],
  initial: 'OFFERED',
  // No states are listed terminal: the legacy table allows ADMIN rollbacks
  // out of COMPLETED/WITHDRAWN/CANCELLED, so we model those as explicit
  // rules and rely on "no rule found" -> 422 for the truly illegal moves.
  terminal: [],
  transitions: [
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
    // SVT-WAVE-BILLING-2026-05 — mid-enrolment pause/resume.
    // Pause triggers FeePlan.pause + suspends installments + skips reminders.
    // Resume shifts remaining due dates by pause window length.
    { from: 'ENROLLED', to: 'ON_LEAVE',  requires_role: 'COUNSELLOR', require_reason: true },
    { from: 'ON_LEAVE', to: 'ENROLLED',  requires_role: 'COUNSELLOR' },
    { from: 'ON_LEAVE', to: 'WITHDRAWN', requires_role: 'COUNSELLOR', require_reason: true },
    { from: 'ON_LEAVE', to: 'COMPLETED', requires_role: 'ADMIN',      require_reason: true },
    { from: 'ON_LEAVE', to: 'DEFERRED',  requires_role: 'ADMIN',      require_reason: true },
    // Admin-only rollbacks
    { from: 'COMPLETED', to: 'ENROLLED', requires_role: 'ADMIN', require_reason: true },
    { from: 'WITHDRAWN', to: 'ENROLLED', requires_role: 'ADMIN', require_reason: true },
    { from: 'CANCELLED', to: 'OFFERED',  requires_role: 'ADMIN', require_reason: true },
  ],
});
