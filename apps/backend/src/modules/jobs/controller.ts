// HTTP controller for /api/v1/jobs.
//
// Read-only by design: the job_runs table is written exclusively by the
// scheduler (see ../../jobs/runner.ts). The route is admin-only because
// scheduler health is operational data, not user data.
import type { NextFunction, Request, Response } from 'express';

import type { JobRunListQuery } from '@spv/zod-schemas';

import * as service from './service.js';

export async function listRecentHandler(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const q = req.query as unknown as JobRunListQuery;
    const data = await service.listRecent(q);
    res.json({ data });
  } catch (err) {
    next(err);
  }
}
