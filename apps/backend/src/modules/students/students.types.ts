// Internal-only types for the students module. Public schemas live in @spv/zod-schemas.
import type { Request } from 'express';
import type { PrismaClient } from '@prisma/client';
import { prisma } from '../../config/db.js';

// Either the RLS-scoped tx (req.db, set by tenantContext) or the singleton fallback.
export type Db = PrismaClient;

// Prefer the RLS-scoped tx attached by tenantContext middleware. Fall back to the
// singleton for code paths that don't go through HTTP (jobs, scripts, tests).
export function dbFor(req: Request): Db {
  return ((req.db as unknown as Db) ?? prisma);
}

export type CursorParts = { created_at: string; id: string };

// Encode/decode opaque cursor as base64url JSON. The cursor format is internal —
// clients must treat it as opaque and never inspect its contents.
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

export type SortColumn =
  | 'family_name'
  | 'given_name'
  | 'created_at'
  | 'updated_at'
  | 'stage_entered_at';

export type SortDirective = { column: SortColumn; dir: 'asc' | 'desc' };

export function parseSort(sort?: string): SortDirective[] {
  if (!sort) return [];
  return sort.split(',').map((tok) => {
    const dir: 'asc' | 'desc' = tok.startsWith('-') ? 'desc' : 'asc';
    const column = (tok.startsWith('-') ? tok.slice(1) : tok) as SortColumn;
    return { column, dir };
  });
}

// Result of a completeness recompute. `missing` lists machine-readable keys for the FE
// to render localised strings.
export type CompletenessResult = { score: number; missing: string[] };
