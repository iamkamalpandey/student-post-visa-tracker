// SuperAgent status FSM.
//
//   ACTIVE <-> PAUSED  (admins may pause/resume freely)
//   * --> TERMINATED   (admin only; terminal — once terminated the super-agent
//                       cannot be re-activated; create a new record instead)
//
// Counsellors cannot transition status. Termination requires a reason_code so
// the audit log captures *why* the relationship ended.

import { defineMachine } from '../../shared/fsm.js';

export type SuperAgentStatus = 'ACTIVE' | 'PAUSED' | 'TERMINATED';

export const superAgentFsm = defineMachine<SuperAgentStatus>({
  name: 'super_agent',
  states: ['ACTIVE', 'PAUSED', 'TERMINATED'],
  initial: 'ACTIVE',
  terminal: ['TERMINATED'],
  transitions: [
    { from: 'ACTIVE', to: 'PAUSED', requires_role: 'ADMIN' },
    { from: 'PAUSED', to: 'ACTIVE', requires_role: 'ADMIN' },
    { from: 'ACTIVE', to: 'TERMINATED', requires_role: 'ADMIN', require_reason: true },
    { from: 'PAUSED', to: 'TERMINATED', requires_role: 'ADMIN', require_reason: true },
  ],
});
