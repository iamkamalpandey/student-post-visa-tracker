import type { Request } from 'express';

import { PreconditionFailed } from './errors.js';

/**
 * Centralised optimistic-concurrency helpers.
 *
 * Rationale: every sub-module controller used to inline its own `If-Match`
 * parsing and version-comparison logic, producing 17+ near-identical copies
 * that drifted on whitespace handling, weak-ETag tolerance, and error wording.
 * Consolidating here gives one RFC 7232-compliant parser, one mismatch error
 * surface, and one shared `applyVersionedUpdate` so service authors only
 * declare the model name and the framework enforces concurrency atomically.
 */

/**
 * Parse the optional `If-Match` request header into a numeric row version.
 *
 * - Returns `undefined` when the header is absent — callers decide whether
 *   that means "skip the check" (backwards-compat) or "reject as required".
 * - Tolerates weak ETag prefix (`W/`) and surrounding double-quotes.
 * - Throws `PreconditionFailed` (412) when present but non-numeric or < 1,
 *   per RFC 7232 §3.1 (syntactically invalid preconditions fail closed).
 */
export function readIfMatch(req: Request): number | undefined {
  const raw = req.header('If-Match');
  if (!raw) return undefined;
  const stripped = raw.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  const n = Number.parseInt(stripped, 10);
  if (!Number.isFinite(n) || n < 1) {
    throw PreconditionFailed('If-Match must be a numeric version (e.g. "3").');
  }
  return n;
}

/**
 * Compare the row's `current` version against the client's `expected`.
 * No-op when `expected` is `undefined`. Throws `PreconditionFailed` (412)
 * otherwise — never returns a value, so callers can use it as a guard.
 */
export function assertVersion(current: number, expected: number | undefined): void {
  if (expected === undefined) return;
  if (current !== expected) {
    throw PreconditionFailed(
      `If-Match version mismatch: client expected ${expected}, server has ${current}.`,
    );
  }
}

/**
 * Atomically update a tenant-scoped row only if its `version` matches
 * `expected`. Bumps `version` by 1, returns the updated row, or throws
 * `PreconditionFailed` (412) when the WHERE matched zero rows (lost-update
 * race or stale client). Pass `expected: undefined` to skip the check.
 *
 * `modelName` is the Prisma delegate key (e.g. `'travel'`). Typed as
 * `keyof PrismaClient` would create a circular import here; callers in
 * services already constrain the literal so we accept `string`.
 */
export async function applyVersionedUpdate<T>(
  db: Record<string, never>,
  modelName: string,
  id: string,
  tenantId: string,
  expected: number | undefined,
  data: Record<string, unknown>,
): Promise<T> {
  const delegate = (db as unknown as Record<string, { updateMany: Function; findFirst: Function } | undefined>)[
    modelName
  ];
  if (!delegate) {
    throw new Error(`applyVersionedUpdate: unknown Prisma model '${modelName}'`);
  }
  // Prisma columns are snake_case in this codebase; also exclude soft-deleted
  // rows so an update can never resurrect a tombstoned row whose version
  // happens to still match.
  const where: Record<string, unknown> = { id, tenant_id: tenantId, deleted_at: null };
  if (expected !== undefined) where['version'] = expected;
  const result = (await delegate.updateMany({
    where,
    data: { ...data, version: { increment: 1 } },
  })) as { count: number };
  if (result.count !== 1) {
    throw PreconditionFailed(
      `Update rejected: row missing or version != ${expected ?? '(any)'}.`,
    );
  }
  return (await delegate.findFirst({
    where: { id, tenant_id: tenantId, deleted_at: null },
  })) as T;
}
