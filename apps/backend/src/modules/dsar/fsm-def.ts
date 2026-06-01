// SVT-FSM-2026-05: DSAR status FSM definition.
//
// Migrates the inline TRANSITIONS table previously in service.ts.
//
// Notes vs the legacy table:
//   - Reason in the DSAR module flows through `notes`, not a separate
//     reason_code field. Length min is 10 chars (REASON_MIN_CHARS) — stricter
//     than the framework's default 3-char floor — so the service still does
//     its own length check for reason transitions and skips the framework's
//     reason check by passing an empty placeholder. The framework's role +
//     transition-table guards do the rest.
//   - EXPIRED is intentionally NOT in `terminal[]`. The legacy code returns
//     422 (no rule found) when callers try to revive an EXPIRED row; the
//     test (dsar.spec.ts) pins that status. Adding EXPIRED to terminal[]
//     would flip it to 409 and break the test.
import { defineMachine } from '../../shared/fsm.js';

export type DSARStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'REJECTED' | 'EXPIRED';

export const dsarFsm = defineMachine<DSARStatus>({
  name: 'dsar',
  states: ['PENDING', 'IN_PROGRESS', 'COMPLETED', 'REJECTED', 'EXPIRED'],
  initial: 'PENDING',
  // No states are listed terminal so revival attempts return 422 (matches
  // legacy behaviour).
  terminal: [],
  transitions: [
    { from: 'PENDING',     to: 'IN_PROGRESS' },                                // any COUNSELLOR+
    { from: 'IN_PROGRESS', to: 'COMPLETED' },                                  // any COUNSELLOR+
    { from: 'IN_PROGRESS', to: 'REJECTED',    requires_role: 'ADMIN' },        // service enforces 10-char notes
    { from: 'IN_PROGRESS', to: 'EXPIRED',     requires_role: 'ADMIN' },
    { from: 'COMPLETED',   to: 'IN_PROGRESS', requires_role: 'ADMIN' },        // service enforces 10-char notes
    { from: 'REJECTED',    to: 'IN_PROGRESS', requires_role: 'ADMIN' },        // service enforces 10-char notes
  ],
});
