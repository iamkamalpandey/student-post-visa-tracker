// SVT-FSM-2026-05: Public FSM-options endpoint.
//
// Mounted at GET /api/v1/fsm/:machineName/options?from=<state>. Returns the
// allowed targets for a given current state + the caller's role, sourced from
// the canonical per-domain FSM defs in `modules/<domain>/fsm-def.ts`.
//
// This lets the FE drop hand-mirrored transition tables (such as
// `apps/frontend/features/students/studies/enrollment-fsm.ts`) and just fetch
// the live machine. The response shape is pinned in
// `packages/zod-schemas/src/fsm.ts` (FsmOptionsResponse).
import { Router, type Request, type Response, type NextFunction } from 'express';
import type { UserRole } from '@prisma/client';

import { authenticate } from '../../middlewares/auth.js';
import { tenantContext } from '../../middlewares/tenantContext.js';
import { BadRequest } from '../../shared/errors.js';
import { buildStateOptionsResponse, type FsmDef } from '../../shared/fsm.js';

import { commissionFsm } from '../commissions/fsm-def.js';
import { dsarFsm } from '../dsar/fsm-def.js';
import { reminderFsm } from '../reminders/fsm-def.js';
import { documentFsm } from '../documents/fsm-def.js';
import { studentFsm } from '../students/fsm-def.js';
import { enrollmentFsm } from '../enrollments/fsm-def.js';
import { visaFsm } from '../visas/fsm-def.js';
import { superAgentFsm } from '../super-agents/fsm-def.js';

// Whitelist: machine name -> def. The machineName param is validated against
// these keys before the def lookup runs so we don't expose an arbitrary
// reflection surface.
const MACHINES: Record<string, FsmDef<string>> = {
  commission: commissionFsm as FsmDef<string>,
  enrollment: enrollmentFsm as FsmDef<string>,
  dsar: dsarFsm as FsmDef<string>,
  reminder: reminderFsm as FsmDef<string>,
  document: documentFsm as FsmDef<string>,
  student: studentFsm as FsmDef<string>,
  // Registration-only: StudentVisa schema has no status enum yet (v6 migration
  // target). The def lets the FE fetch /fsm/visa/options to render dropdowns.
  visa: visaFsm as FsmDef<string>,
  super_agent: superAgentFsm as FsmDef<string>,
};

export const fsmRouter: Router = Router();
fsmRouter.use(authenticate, tenantContext);

fsmRouter.get(
  '/:machineName/options',
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const machineName = req.params['machineName'] ?? '';
      const def = MACHINES[machineName];
      if (!def) {
        return next(BadRequest(`Unknown FSM machine "${machineName}"`));
      }
      const fromRaw = (req.query['from'] as string | undefined) ?? '';
      if (!fromRaw) {
        return next(BadRequest('Query parameter `from` is required'));
      }
      if (!def.states.includes(fromRaw)) {
        return next(
          BadRequest(`State "${fromRaw}" is not part of FSM "${machineName}"`),
        );
      }
      const role = (req.user?.role ?? 'VIEWER') as UserRole;
      const body = buildStateOptionsResponse(def, fromRaw, role);
      res.json(body);
    } catch (err) {
      next(err);
    }
  },
);
