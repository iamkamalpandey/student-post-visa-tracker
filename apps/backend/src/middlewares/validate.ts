import type { Request, Response, NextFunction } from 'express';
import type { ZodSchema } from 'zod';

type Source = 'body' | 'query' | 'params';

// Strict validation: unknown keys are rejected by the schema (use .strict() in your schemas).
// Parsed data is written back to the request so handlers consume the typed value.
export function validate<T>(schema: ZodSchema<T>, source: Source = 'body') {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const value = schema.parse(req[source]);
      // Only assign the typed value back; never trust un-validated input.
      (req as unknown as Record<string, unknown>)[source] = value;
      next();
    } catch (err) {
      next(err);
    }
  };
}
