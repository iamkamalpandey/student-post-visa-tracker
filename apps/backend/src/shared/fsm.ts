// SVT-FSM-2026-05: Shared finite state machine framework.
//
// Wave 9 added FSM-style guards inline in 7 service files; each defined its
// own transition table + ad-hoc guard. Drift risk: a new transition added in
// one file may not propagate to the FE state-options helpers. This module is
// the single source of truth: every domain status state-machine is built via
// `defineMachine()` and validated via `assertOrThrow()` so role / reason /
// terminal-state semantics stay consistent.
//
// Behaviour contract preserved by callers:
//   - same → same: no-op (returns ok)
//   - matching rule + role + reason satisfied: ok
//   - role too weak: 403 Forbidden
//   - rule requires reason but none supplied: 422 Unprocessable Entity
//   - no matching rule:
//       * if `from` is in `terminal[]`: 409 Conflict (state is locked)
//       * else: 422 Unprocessable Entity (well-formed but illegal)
//
// Note: terminal short-circuits ONLY when no rule exists. Explicit transitions
// from a terminal state (e.g. ADMIN reactivation of a WITHDRAWN student) are
// honoured if listed in the def.
import { Forbidden, UnprocessableEntity, Conflict } from './errors.js';
import type { UserRole } from '@prisma/client';

export type TransitionRule<S extends string> = {
  from: S;
  to: S;
  requires_role?: UserRole;
  require_reason?: boolean;
};

export type FsmDef<S extends string> = {
  name: string;          // e.g. "commission", "dsar", "enrollment"
  states: readonly S[];
  initial?: S;
  terminal?: readonly S[];
  transitions: readonly TransitionRule<S>[];
};

const ROLE_ORDER: Record<UserRole, number> = { VIEWER: 0, COUNSELLOR: 1, ADMIN: 2 };

export function roleAtLeast(actor: UserRole, required: UserRole): boolean {
  return ROLE_ORDER[actor] >= ROLE_ORDER[required];
}

export function defineMachine<S extends string>(def: FsmDef<S>): FsmDef<S> {
  // Validation: every transition state must be in `states`. Caught at module load.
  for (const t of def.transitions) {
    if (!def.states.includes(t.from)) {
      throw new Error(`fsm[${def.name}]: from "${t.from}" not in states`);
    }
    if (!def.states.includes(t.to)) {
      throw new Error(`fsm[${def.name}]: to "${t.to}" not in states`);
    }
  }
  return def;
}

export function isTerminal<S extends string>(def: FsmDef<S>, s: S): boolean {
  return def.terminal?.includes(s) ?? false;
}

/**
 * Enumerate the states a given role can move to from `from`. Used by the FE
 * status-dropdown helper + by buildStateOptionsResponse below.
 */
export function getAllowedNextStates<S extends string>(
  def: FsmDef<S>,
  from: S,
  role?: UserRole,
): S[] {
  return def.transitions
    .filter(
      (t) =>
        t.from === from && (!role || !t.requires_role || roleAtLeast(role, t.requires_role)),
    )
    .map((t) => t.to);
}

export type AssertResult<S extends string> =
  | { ok: true; rule?: TransitionRule<S> }
  | { ok: false; status: 403 | 409 | 422; detail: string };

/**
 * Validates a transition under FSM + RBAC + reason rules. Returns a
 * discriminated union; callers map it into HttpError.
 */
export function assertTransition<S extends string>(
  def: FsmDef<S>,
  from: S,
  to: S,
  actorRole: UserRole,
  reasonCode?: string,
): AssertResult<S> {
  if (from === to) return { ok: true }; // no-op

  // 1. Look up an explicit rule first. Terminal short-circuit only fires when
  //    no rule exists — admin escapes from terminal states are honoured if
  //    they're listed in the def.
  const t = def.transitions.find((x) => x.from === from && x.to === to);
  if (!t) {
    if (isTerminal(def, from)) {
      return {
        ok: false,
        status: 409,
        detail: `Cannot transition from terminal state "${from}" to "${to}"`,
      };
    }
    return { ok: false, status: 422, detail: `Invalid transition: ${from} -> ${to}` };
  }

  // 2. Role guard.
  if (t.requires_role && !roleAtLeast(actorRole, t.requires_role)) {
    return {
      ok: false,
      status: 403,
      detail: `Transition ${from} -> ${to} requires role ${t.requires_role}`,
    };
  }

  // 3. Reason guard.
  if (t.require_reason && (!reasonCode || reasonCode.trim().length < 3)) {
    return {
      ok: false,
      status: 422,
      detail: `Transition ${from} -> ${to} requires a reason_code (min 3 chars)`,
    };
  }
  return { ok: true, rule: t };
}

/**
 * Convenience wrapper that throws the matching HttpError instead of returning
 * a discriminated union. Use in service code where the caller doesn't need
 * the detail beyond the standard 403/409/422 mapping.
 */
export function assertOrThrow<S extends string>(
  def: FsmDef<S>,
  from: S,
  to: S,
  actorRole: UserRole,
  reasonCode?: string,
): void {
  const r = assertTransition(def, from, to, actorRole, reasonCode);
  if (r.ok) return;
  if (r.status === 403) throw Forbidden(r.detail);
  if (r.status === 409) throw Conflict(r.detail);
  throw UnprocessableEntity(r.detail);
}

/**
 * FE-facing helper: list allowed targets for a given current state + role.
 * The result drops rules the role cannot perform and flags admin-only paths
 * so the FE can render them with an "admin override" badge.
 */
export function buildStateOptionsResponse<S extends string>(
  def: FsmDef<S>,
  from: S,
  role: UserRole,
): {
  from: S;
  allowed: Array<{ to: S; requires_reason: boolean; admin_override: boolean }>;
} {
  const allowed = def.transitions
    .filter((t) => t.from === from)
    .map((t) => ({
      to: t.to,
      requires_reason: !!t.require_reason,
      // admin_override = true if the rule requires ADMIN role specifically.
      admin_override: t.requires_role === 'ADMIN',
      hidden_for_role: t.requires_role && !roleAtLeast(role, t.requires_role),
    }))
    .filter((x) => !x.hidden_for_role)
    .map(({ to, requires_reason, admin_override }) => ({ to, requires_reason, admin_override }));
  return { from, allowed };
}

// ---------------------------------------------------------------------------
// Data-driven helper for the lifecycle-stage matrix.
//
// Lifecycle stage transitions live in the DB (`lifecycle_stage_transitions`),
// keyed by tenant. We can't use defineMachine() because the state set is the
// per-tenant lifecycle stage list — variable per row. This helper validates a
// (currentStageId, targetStageId) pair against an in-memory snapshot of the
// matrix the caller already loaded via Prisma.
//
// Role semantics mirror defineMachine: requires_role of the matched row is
// checked via roleAtLeast(). Rows with requires_role = null grant unrestricted
// access. The caller should also enforce the "matrix is closed when any rows
// exist for from_stage" rule (sequence-fallback semantics) BEFORE calling
// this helper — it only validates a row that the caller has already located.
// ---------------------------------------------------------------------------
export type DynamicTransitionRow = {
  from_stage_id: string | null;
  to_stage_id: string;
  requires_role: UserRole | null;
};

export type DynamicAssertResult =
  | { ok: true; row: DynamicTransitionRow }
  | { ok: false; status: 403 | 422; detail: string };

export function dynamicAssertTransition(
  rows: readonly DynamicTransitionRow[],
  currentStageId: string | null,
  targetStageId: string,
  actorRole: UserRole,
): DynamicAssertResult {
  const row = rows.find(
    (r) => r.from_stage_id === currentStageId && r.to_stage_id === targetStageId,
  );
  if (!row) {
    return { ok: false, status: 422, detail: 'No matching transition row' };
  }
  if (row.requires_role && !roleAtLeast(actorRole, row.requires_role)) {
    return {
      ok: false,
      status: 403,
      detail: `This transition requires role ${row.requires_role}.`,
    };
  }
  return { ok: true, row };
}
