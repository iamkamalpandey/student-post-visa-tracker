// UUID path-parameter validator. Mounted on every router segment that uses a
// `:id` (or sibling) param so that a non-UUID literal (e.g. `/dsar/requests`)
// returns a clean 400 Problem-Details response instead of bubbling into Prisma
// and returning a 500 with a leaked error message + Windows path.
//
// Pattern: `router.use('/:id', uuidParam('id'));` (or per-route as needed).
// Routes that register literal segments BEFORE `:id` (e.g. `/audit-logs/verify`)
// are unaffected because Express matches in declaration order.

import { z } from 'zod';
import type { RequestHandler } from 'express';

const Uuid = z.string().uuid();

export function uuidParam(name: string): RequestHandler {
  return (req, res, next) => {
    const value = req.params[name];
    const r = Uuid.safeParse(value);
    if (!r.success) {
      res.status(400).type('application/problem+json').json({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: `Path parameter "${name}" must be a valid UUID`,
        instance: req.originalUrl,
        request_id: (req as unknown as { requestId?: string }).requestId,
      });
      return;
    }
    next();
  };
}
