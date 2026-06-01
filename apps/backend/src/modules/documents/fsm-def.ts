// SVT-FSM-2026-05: Document verification FSM definition.
//
// Migrates the inline `docVerificationTransitions` map from documents.service.ts.
// PENDING is the only mutable state; VERIFIED / REJECTED / EXPIRED are
// terminal. The service still owns the ADMIN-only `force_override` escape
// hatch (with reason >= 10 chars) — the framework just rejects regular
// transitions out of a terminal state with 409.
import { defineMachine } from '../../shared/fsm.js';

export type DocVerification = 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';

export const documentFsm = defineMachine<DocVerification>({
  name: 'document',
  states: ['PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED'],
  initial: 'PENDING',
  // Once stamped, the row is locked. A new upload version is required to
  // re-evaluate (or the ADMIN force_override path in the service).
  terminal: ['VERIFIED', 'REJECTED', 'EXPIRED'],
  transitions: [
    { from: 'PENDING', to: 'VERIFIED' },
    { from: 'PENDING', to: 'REJECTED' },
    { from: 'PENDING', to: 'EXPIRED' },
  ],
});
