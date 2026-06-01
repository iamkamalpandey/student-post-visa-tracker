// SVT-FSM-2026-05: Commission claim FSM definition.
//
// Migrates the inline state-machine that was scattered across per-action
// guards in service.ts (claim/invoice/markPaid/dispute/resolveDispute/waive)
// into a single declarative table consumed by the shared `defineMachine`
// helper. Behaviour is preserved 1:1 — the action handlers still gate on the
// (before.status, target) pair via assertOrThrow().
//
// Original prose (kept for reviewers):
//   PENDING --claim--> CLAIMED --invoice--> INVOICED --mark-paid--> PAID
//   any-non-PAID --dispute--> DISPUTED
//   DISPUTED --resolveDispute--> INVOICED  (clears dispute_reason)
//   any --waive--> WAIVED  (admin override, terminal)
//   PAID + WAIVED are terminal.
import { defineMachine } from '../../shared/fsm.js';

export type CommissionStatus =
  | 'PENDING'
  | 'CLAIMED'
  | 'INVOICED'
  | 'PAID'
  | 'DISPUTED'
  | 'WAIVED';

export const commissionFsm = defineMachine<CommissionStatus>({
  name: 'commission',
  states: ['PENDING', 'CLAIMED', 'INVOICED', 'PAID', 'DISPUTED', 'WAIVED'],
  initial: 'PENDING',
  // PAID + WAIVED have no outbound transitions — they're terminal. DISPUTED
  // is NOT terminal because resolveDispute moves it back to INVOICED.
  terminal: ['PAID', 'WAIVED'],
  transitions: [
    // Forward path
    { from: 'PENDING',  to: 'CLAIMED' },
    { from: 'CLAIMED',  to: 'INVOICED' },
    { from: 'INVOICED', to: 'PAID' },
    // Dispute (any-non-PAID -> DISPUTED) and resolution.
    { from: 'PENDING',  to: 'DISPUTED' },
    { from: 'CLAIMED',  to: 'DISPUTED' },
    { from: 'INVOICED', to: 'DISPUTED' },
    { from: 'DISPUTED', to: 'INVOICED' },
    // Waive (any -> WAIVED). Service layer enforces "not already WAIVED" in
    // its guard so we don't list WAIVED -> WAIVED here (terminal anyway).
    { from: 'PENDING',  to: 'WAIVED' },
    { from: 'CLAIMED',  to: 'WAIVED' },
    { from: 'INVOICED', to: 'WAIVED' },
    { from: 'DISPUTED', to: 'WAIVED' },
  ],
});
