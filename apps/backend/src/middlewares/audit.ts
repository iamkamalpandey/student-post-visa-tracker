// Lightweight audit-context middleware. Attaches the few values that nearly every
// audit-emitting handler needs (ip, ua, request id, actor id) onto req.audit so
// downstream code doesn't have to re-derive them.
//
// This middleware does NOT itself write to the audit log — it just packages
// context. The actual writeAudit() helper from shared/audit.ts is what persists
// rows; this just makes call sites terse.

import type { Request, Response, NextFunction } from 'express';

export interface AuditContext {
  ip?: string;
  ua?: string;
  requestId?: string;
  actorId?: string;
  tenantId?: string;
}

// `req.audit` is augmented globally in `src/types/express.d.ts`.

export function auditContext(req: Request, _res: Response, next: NextFunction): void {
  req.audit = {
    ip: req.ip,
    ua: req.header('user-agent') ?? undefined,
    requestId: req.requestId,
    // req.user is populated by the authenticate middleware. When this runs before
    // authenticate (e.g. on public routes) actorId will simply be undefined.
    actorId: req.user?.sub,
    tenantId: req.user?.tid,
  };
  next();
}
