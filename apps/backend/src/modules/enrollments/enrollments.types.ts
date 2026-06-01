// Internal-only types for the enrollments module. Public schemas live in @spv/zod-schemas.
import type { Request } from 'express';
import type { PrismaClient } from '@prisma/client';

export type Db = PrismaClient;

export function dbFor(req: Request): Db {
  return (req.db as unknown as Db) ?? defaultPrisma();
}

let _prisma: Db | null = null;
function defaultPrisma(): Db {
  if (_prisma) return _prisma;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../../config/db.js') as { prisma: Db };
  _prisma = mod.prisma;
  return _prisma;
}
