// Shared zod-enum coercion helper used by per-entity importers + mappers.
//
// Why: Prisma generates string-literal enums (e.g. `$Enums.AcademicLevel`) that are
// structurally identical to the union produced by `z.enum([...]).infer`. Routing
// every spreadsheet value through the matching zod enum gives us a single typed
// gate: invalid values produce a useful error string, valid values flow into
// Prisma calls without the previous `as any` escape hatches.
//
// The helper deliberately throws an Error rather than returning a Result. Importer
// code already wraps each row in a try/catch (see `applyNonStudentRow`), so an
// invalid enum value surfaces as a per-row failure with a helpful message and
// does not abort the chunk.

import { z } from 'zod';

export class ImportEnumError extends Error {
  constructor(
    public readonly field: string,
    public readonly value: unknown,
    public readonly options: readonly string[],
  ) {
    super(`Invalid ${field}: ${String(value)}; expected one of ${options.join(', ')}`);
    this.name = 'ImportEnumError';
  }
}

// `z.ZodEnum<[string, ...string[]]>` is the runtime constraint zod uses; we keep
// the generic loose so callers can pass any enum schema imported from `@spv/zod-schemas`.
export function coerceEnum<T extends z.ZodEnum<[string, ...string[]]>>(
  field: string,
  value: unknown,
  schema: T,
): z.infer<T> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new ImportEnumError(field, value, schema.options as readonly string[]);
  }
  return r.data;
}
