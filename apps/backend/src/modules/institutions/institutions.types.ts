// Internal-only types for the institutions module. Public schemas live in @spv/zod-schemas.
import type { Request } from 'express';
import type { PrismaClient } from '@prisma/client';

// Either the RLS-scoped tx (req.db, set by tenantContext) or the singleton fallback.
export type Db = PrismaClient;

export function dbFor(req: Request): Db {
  // Cast: the singleton and the tx client share the same Prisma surface for our needs.
  return (req.db as unknown as Db) ?? defaultPrisma();
}

// Lazy import so this module remains tree-shakable in tooling and tests can stub it.
let _prisma: Db | null = null;
function defaultPrisma(): Db {
  if (_prisma) return _prisma;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('../../config/db.js') as { prisma: Db };
  _prisma = mod.prisma;
  return _prisma;
}

export type CursorParts = { created_at: string; id: string };

export function encodeCursor(parts: CursorParts): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

export function decodeCursor(s: string): CursorParts | null {
  try {
    const obj = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as CursorParts;
    if (typeof obj?.created_at !== 'string' || typeof obj?.id !== 'string') return null;
    return obj;
  } catch {
    return null;
  }
}
