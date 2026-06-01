// SVT-FSM-2026-05: Student status FSM definition.
//
// Migrates the inline `studentStatusTransitions` map from students.service.ts.
//
// Allowed transitions:
//   ACTIVE   <-> ON_HOLD                            (any role)
//   ACTIVE   -> WITHDRAWN | COMPLETED | DEFERRED    (any role, requires reason)
//   ON_HOLD  -> WITHDRAWN | COMPLETED | DEFERRED    (any role, requires reason)
//   {WITHDRAWN, COMPLETED, DEFERRED} -> ACTIVE      (ADMIN only, requires reason)
//
// WITHDRAWN/COMPLETED/DEFERRED are listed in `terminal[]` so an attempted
// terminal -> terminal flip (e.g. COMPLETED -> DEFERRED) returns 409 Conflict.
// Explicit terminal -> ACTIVE rules below are still honoured by the framework
// because terminal short-circuits ONLY when no rule is found.
//
// Critical: the test (students-status.spec.ts) pins:
//   - WITHDRAWN -> ACTIVE by COUNSELLOR -> 403
//   - ACTIVE -> WITHDRAWN without reason -> 422
//   - COMPLETED -> DEFERRED -> 409 (terminal-to-terminal)
import { defineMachine } from '../../shared/fsm.js';

export type StudentStatusValue =
  | 'ACTIVE'
  | 'ON_HOLD'
  // SVT-WAVE-BILLING-2026-05 — mid-enrolment leave. DEFERRED already means
  // pre-start postponement; ON_LEAVE is different. Pauses billing + skips
  // reminders.
  | 'ON_LEAVE'
  | 'WITHDRAWN'
  | 'COMPLETED'
  | 'DEFERRED';

export const studentFsm = defineMachine<StudentStatusValue>({
  name: 'student',
  states: ['ACTIVE', 'ON_HOLD', 'ON_LEAVE', 'WITHDRAWN', 'COMPLETED', 'DEFERRED'],
  initial: 'ACTIVE',
  terminal: ['WITHDRAWN', 'COMPLETED', 'DEFERRED'],
  transitions: [
    // Active <-> ON_HOLD (no reason required either way).
    { from: 'ACTIVE',  to: 'ON_HOLD' },
    { from: 'ON_HOLD', to: 'ACTIVE' },
    // SVT-WAVE-BILLING-2026-05 — ACTIVE <-> ON_LEAVE; resume needs no reason.
    { from: 'ACTIVE',   to: 'ON_LEAVE', require_reason: true },
    { from: 'ON_LEAVE', to: 'ACTIVE' },
    { from: 'ON_LEAVE', to: 'WITHDRAWN', require_reason: true },
    { from: 'ON_LEAVE', to: 'COMPLETED', requires_role: 'ADMIN', require_reason: true },
    // Active -> terminal (any role, requires reason).
    { from: 'ACTIVE', to: 'WITHDRAWN', require_reason: true },
    { from: 'ACTIVE', to: 'COMPLETED', require_reason: true },
    { from: 'ACTIVE', to: 'DEFERRED',  require_reason: true },
    // ON_HOLD -> terminal (any role, requires reason).
    { from: 'ON_HOLD', to: 'WITHDRAWN', require_reason: true },
    { from: 'ON_HOLD', to: 'COMPLETED', require_reason: true },
    { from: 'ON_HOLD', to: 'DEFERRED',  require_reason: true },
    // Reactivation out of a terminal state: ADMIN only, requires reason.
    { from: 'WITHDRAWN', to: 'ACTIVE', requires_role: 'ADMIN', require_reason: true },
    { from: 'COMPLETED', to: 'ACTIVE', requires_role: 'ADMIN', require_reason: true },
    { from: 'DEFERRED',  to: 'ACTIVE', requires_role: 'ADMIN', require_reason: true },
  ],
});
