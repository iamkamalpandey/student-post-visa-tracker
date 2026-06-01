import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';

// `req.requestId` is augmented globally in `src/types/express.d.ts`.

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-request-id');
  const id = incoming && /^[a-zA-Z0-9_-]{8,128}$/.test(incoming) ? incoming : randomUUID();
  req.requestId = id;
  res.setHeader('x-request-id', id);
  next();
}
