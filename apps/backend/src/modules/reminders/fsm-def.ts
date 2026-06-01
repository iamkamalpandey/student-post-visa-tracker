// SVT-FSM-2026-05: Reminder lifecycle FSM definition.
//
// Migrates the inline `reminderTransitions` action-table previously in
// service.ts. The wire actions (acknowledge / snooze / dismiss) map onto the
// target status; the service uses an action -> status map so it can keep its
// custom error message ("Cannot acknowledge a DISMISSED reminder") that the
// test pins via regex.
//
// Status flow:
//   PENDING|SENT|SNOOZED -> ACKNOWLEDGED | SNOOZED | DISMISSED
//   ACKNOWLEDGED         -> DISMISSED  (admin tidy-up)
//   DISMISSED            -> terminal
import { defineMachine } from '../../shared/fsm.js';

export type ReminderFsmStatus =
  | 'PENDING'
  | 'SENT'
  | 'ACKNOWLEDGED'
  | 'SNOOZED'
  | 'DISMISSED';

// Action label -> target status map. The service uses this to drive the
// state-machine + to render its custom Conflict message keyed by action.
export type ReminderAction = 'acknowledge' | 'snooze' | 'dismiss';
export const reminderActionToStatus: Record<ReminderAction, ReminderFsmStatus> = {
  acknowledge: 'ACKNOWLEDGED',
  snooze: 'SNOOZED',
  dismiss: 'DISMISSED',
};

export const reminderFsm = defineMachine<ReminderFsmStatus>({
  name: 'reminder',
  states: ['PENDING', 'SENT', 'ACKNOWLEDGED', 'SNOOZED', 'DISMISSED'],
  initial: 'PENDING',
  terminal: ['DISMISSED'],
  transitions: [
    // acknowledge
    { from: 'PENDING',  to: 'ACKNOWLEDGED' },
    { from: 'SENT',     to: 'ACKNOWLEDGED' },
    { from: 'SNOOZED',  to: 'ACKNOWLEDGED' },
    // snooze (re-snooze from SNOOZED is the framework's same-state no-op path)
    { from: 'PENDING',  to: 'SNOOZED' },
    { from: 'SENT',     to: 'SNOOZED' },
    // dismiss
    { from: 'PENDING',      to: 'DISMISSED' },
    { from: 'SENT',         to: 'DISMISSED' },
    { from: 'SNOOZED',      to: 'DISMISSED' },
    { from: 'ACKNOWLEDGED', to: 'DISMISSED' },
  ],
});
