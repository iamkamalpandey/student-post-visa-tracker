// Hand-rolled Zod → OpenAPI 3.1 schema converter.
//
// Why hand-roll instead of pulling in `zod-to-openapi`? The advertised package
// would add ~150KB of transitive deps for a feature that is dev-only. We
// deliberately cover the 80% of constructs we actually use (object/string/number/
// enum/array/optional/nullable/literal/union) and bail to `{}` for the rest so
// the spec is best-effort rather than blocking.
//
// Shape: walk the Zod internal `_def` tree. Recursion is depth-bounded (10) to
// guarantee termination on accidental self-referential schemas.
//
// NOTE: This module imports `zod` only for the `ZodTypeAny` type — the `z.any()`
// constructor is never invoked at runtime. We rely on the runtime `_def.typeName`
// discriminator that Zod 3 ships with.

import type { ZodTypeAny } from 'zod';

// Minimal OpenAPI 3.1 schema object. Intentionally loose: OpenAPI 3.1 schemas
// are JSON Schema 2020-12 supersets so we can attach extra keywords freely.
export interface OpenApiSchema {
  type?: string | string[];
  format?: string;
  description?: string;
  enum?: Array<string | number | boolean | null>;
  const?: string | number | boolean | null;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  items?: OpenApiSchema | { $ref: string };
  properties?: Record<string, OpenApiSchema | { $ref: string }>;
  required?: string[];
  additionalProperties?: boolean | OpenApiSchema;
  oneOf?: OpenApiSchema[];
  anyOf?: OpenApiSchema[];
  allOf?: OpenApiSchema[];
  nullable?: boolean;
  default?: unknown;
  example?: unknown;
  /** JSON-Schema reference to a named component (e.g. `#/components/schemas/Foo`). */
  $ref?: string;
}

const MAX_DEPTH = 10;

interface ZodDef {
  typeName?: string;
  // ZodObject
  shape?: () => Record<string, ZodTypeAny>;
  unknownKeys?: 'strict' | 'strip' | 'passthrough';
  catchall?: ZodTypeAny;
  // ZodString
  checks?: Array<{
    kind: string;
    value?: number | string;
    regex?: RegExp;
    version?: string;
  }>;
  // ZodNumber
  // (also uses checks)
  // ZodEnum
  values?: string[];
  // ZodArray
  type?: ZodTypeAny;
  minLength?: { value: number } | null;
  maxLength?: { value: number } | null;
  // ZodOptional / ZodNullable / ZodDefault / ZodEffects
  innerType?: ZodTypeAny;
  defaultValue?: () => unknown;
  // ZodLiteral
  value?: unknown;
  // ZodUnion / ZodDiscriminatedUnion
  options?: ZodTypeAny[] | Map<string, ZodTypeAny>;
  // ZodRecord
  keyType?: ZodTypeAny;
  valueType?: ZodTypeAny;
}

function getDef(z: ZodTypeAny): ZodDef {
  return (z as unknown as { _def: ZodDef })._def ?? {};
}

function stringSchemaFromChecks(def: ZodDef): OpenApiSchema {
  const out: OpenApiSchema = { type: 'string' };
  for (const check of def.checks ?? []) {
    switch (check.kind) {
      case 'min':
        if (typeof check.value === 'number') out.minLength = check.value;
        break;
      case 'max':
        if (typeof check.value === 'number') out.maxLength = check.value;
        break;
      case 'length':
        if (typeof check.value === 'number') {
          out.minLength = check.value;
          out.maxLength = check.value;
        }
        break;
      case 'email':
        out.format = 'email';
        break;
      case 'url':
        out.format = 'uri';
        break;
      case 'uuid':
        out.format = 'uuid';
        break;
      case 'datetime':
        out.format = 'date-time';
        break;
      case 'date':
        out.format = 'date';
        break;
      case 'regex':
        if (check.regex instanceof RegExp) {
          out.pattern = check.regex.source;
        }
        break;
      default:
        // Skip unknown checks; we still emit a usable string schema.
        break;
    }
  }
  return out;
}

function numberSchemaFromChecks(def: ZodDef): OpenApiSchema {
  const out: OpenApiSchema = { type: 'number' };
  let isInt = false;
  for (const check of def.checks ?? []) {
    switch (check.kind) {
      case 'int':
        isInt = true;
        break;
      case 'min':
        if (typeof check.value === 'number') out.minimum = check.value;
        break;
      case 'max':
        if (typeof check.value === 'number') out.maximum = check.value;
        break;
      case 'multipleOf':
        if (typeof check.value === 'number') out.multipleOf = check.value;
        break;
      default:
        break;
    }
  }
  if (isInt) out.type = 'integer';
  return out;
}

// Detect the common pattern `z.string().email().or(z.literal(''))` used to
// model "optional but emit empty string" fields. Collapse to a single string
// schema with `format: email` and an empty-string example.
function tryCollapseEmptyStringUnion(opts: ZodTypeAny[], depth: number): OpenApiSchema | null {
  if (opts.length !== 2) return null;
  const literals = opts.filter((o) => getDef(o).typeName === 'ZodLiteral' && getDef(o).value === '');
  if (literals.length !== 1) return null;
  const other = opts.find((o) => getDef(o).typeName !== 'ZodLiteral');
  if (!other) return null;
  return zodToSchema(other, depth + 1);
}

export function zodToSchema(z: ZodTypeAny, depth = 0): OpenApiSchema {
  if (depth > MAX_DEPTH) return {};
  if (!z || typeof z !== 'object') return {};
  const def = getDef(z);
  switch (def.typeName) {
    case 'ZodString':
      return stringSchemaFromChecks(def);
    case 'ZodNumber':
      return numberSchemaFromChecks(def);
    case 'ZodBigInt':
      // BigInt has no native JSON repr; we encode it as string per our wire format.
      return { type: 'string', pattern: '^-?\\d+$', description: 'BigInt encoded as decimal string' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodDate':
      return { type: 'string', format: 'date-time' };
    case 'ZodNull':
      return { type: 'null' };
    case 'ZodAny':
    case 'ZodUnknown':
      return {};
    case 'ZodLiteral':
      if (typeof def.value === 'string' || typeof def.value === 'number' || typeof def.value === 'boolean') {
        return { const: def.value };
      }
      if (def.value === null) return { type: 'null' };
      return {};
    case 'ZodEnum':
    case 'ZodNativeEnum': {
      const values = def.values ?? [];
      return { type: 'string', enum: values };
    }
    case 'ZodArray': {
      const out: OpenApiSchema = {
        type: 'array',
        items: def.type ? zodToSchema(def.type, depth + 1) : {},
      };
      if (def.minLength?.value !== undefined) (out as OpenApiSchema & { minItems?: number }).minItems = def.minLength.value;
      if (def.maxLength?.value !== undefined) (out as OpenApiSchema & { maxItems?: number }).maxItems = def.maxLength.value;
      return out;
    }
    case 'ZodObject': {
      const shape = def.shape ? def.shape() : {};
      const props: Record<string, OpenApiSchema> = {};
      const required: string[] = [];
      for (const [key, val] of Object.entries(shape)) {
        const valDef = getDef(val);
        const isOptional =
          valDef.typeName === 'ZodOptional' ||
          valDef.typeName === 'ZodDefault' ||
          (valDef.typeName === 'ZodNullable' && getDef(valDef.innerType as ZodTypeAny).typeName === 'ZodOptional');
        props[key] = zodToSchema(val, depth + 1);
        if (!isOptional) required.push(key);
      }
      const out: OpenApiSchema = { type: 'object', properties: props };
      if (required.length > 0) out.required = required;
      if (def.unknownKeys === 'strict') out.additionalProperties = false;
      return out;
    }
    case 'ZodOptional':
      return def.innerType ? zodToSchema(def.innerType, depth + 1) : {};
    case 'ZodNullable': {
      const inner = def.innerType ? zodToSchema(def.innerType, depth + 1) : {};
      // OpenAPI 3.1 prefers `type: [..., 'null']`; keep `nullable` for tooling that lags.
      if (typeof inner.type === 'string') {
        return { ...inner, type: [inner.type, 'null'] };
      }
      return { ...inner, nullable: true };
    }
    case 'ZodDefault': {
      const inner = def.innerType ? zodToSchema(def.innerType, depth + 1) : {};
      try {
        if (typeof def.defaultValue === 'function') {
          const dv = def.defaultValue();
          // BigInt is not JSON-serialisable; string-encode it (matches our wire format).
          inner.default = typeof dv === 'bigint' ? dv.toString() : (dv as unknown as OpenApiSchema['default']);
        }
      } catch {
        // Defaults that throw at construction time are skipped.
      }
      return inner;
    }
    case 'ZodEffects':
      // Refinements / transforms — pass through to the inner schema.
      return def.innerType ? zodToSchema(def.innerType, depth + 1) : {};
    case 'ZodUnion': {
      const opts = (def.options as ZodTypeAny[]) ?? [];
      const collapsed = tryCollapseEmptyStringUnion(opts, depth);
      if (collapsed) return collapsed;
      return { oneOf: opts.map((o) => zodToSchema(o, depth + 1)) };
    }
    case 'ZodDiscriminatedUnion': {
      const map = def.options;
      const opts = map instanceof Map ? Array.from(map.values()) : (map as ZodTypeAny[]) ?? [];
      return { oneOf: opts.map((o) => zodToSchema(o, depth + 1)) };
    }
    case 'ZodIntersection':
      return {};
    case 'ZodRecord':
      return {
        type: 'object',
        additionalProperties: def.valueType ? zodToSchema(def.valueType, depth + 1) : true,
      };
    case 'ZodTuple':
      return { type: 'array' };
    case 'ZodPipeline':
      // For coerced numbers etc. fall back to the inner output schema.
      return def.innerType ? zodToSchema(def.innerType, depth + 1) : {};
    default:
      return {};
  }
}
