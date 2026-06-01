// SVT-FSM-2026-05: Visa status FSM definition.
//
// Status enum field is a v6 migration target; FSM definition allows the FE to
// render correct option lists once the field lands. Today the StudentVisa
// schema only carries an `is_active` boolean — no `status` column — so this
// machine is REGISTRATION-ONLY. It is wired into the public
// `/api/v1/fsm/visa/options` endpoint so the FE can preview transitions and
// hydrate the upcoming dropdown without round-tripping a hand-mirrored map.
//
// Allowed transitions:
//   ISSUED  -> ACTIVE             (COUNSELLOR activates a freshly-issued visa)
//   ACTIVE  -> EXPIRED            (COUNSELLOR / system marks expired after expires_on date)
//   ACTIVE  -> REVOKED            (ADMIN override + reason — government revoked)
//   ISSUED  -> REVOKED            (ADMIN override + reason — never activated, government revoked)
//   EXPIRED -> ACTIVE             (ADMIN override + reason — extension granted)
//
// EXPIRED and REVOKED are listed in `terminal[]`. Explicit EXPIRED -> ACTIVE
// remains honoured (terminal short-circuit fires only when no rule exists).
import { defineMachine } from '../../shared/fsm.js';

export type VisaStatusValue = 'ISSUED' | 'ACTIVE' | 'EXPIRED' | 'REVOKED';

export const visaFsm = defineMachine<VisaStatusValue>({
  name: 'visa',
  states: ['ISSUED', 'ACTIVE', 'EXPIRED', 'REVOKED'],
  terminal: ['EXPIRED', 'REVOKED'],
  transitions: [
    // ISSUED -> ACTIVE: counsellor activates a freshly-issued visa.
    { from: 'ISSUED', to: 'ACTIVE', requires_role: 'COUNSELLOR' },
    // ACTIVE -> EXPIRED: system or admin marks expired (e.g. cron after expires_on date).
    { from: 'ACTIVE', to: 'EXPIRED', requires_role: 'COUNSELLOR' },
    // ACTIVE -> REVOKED: government revoked the visa (admin override + reason).
    { from: 'ACTIVE', to: 'REVOKED', requires_role: 'ADMIN', require_reason: true },
    // ISSUED -> REVOKED: never activated, government revoked.
    { from: 'ISSUED', to: 'REVOKED', requires_role: 'ADMIN', require_reason: true },
    // EXPIRED -> ACTIVE: admin override (extension granted).
    { from: 'EXPIRED', to: 'ACTIVE', requires_role: 'ADMIN', require_reason: true },
  ],
});
