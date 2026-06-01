// SVT-WAVE15-TEMPLATE-2026-05 — message template interpolation engine.
//
// Format: handlebars-flavoured `{{ var.path }}` placeholders. Supports
// dot-paths into the context object (e.g. `{{ student.given_name }}`,
// `{{ enrollment.institution.display_name }}`).
//
// Why not ICU MessageFormat? Plurals + gender are nice but the consultancy
// use case overwhelmingly substitutes scalars. ICU adds 200KB of runtime +
// a learning curve; handlebars-lite covers 95% of templates and stays
// debuggable. Plurals can layer on later via a `{plural, count}` extension.
//
// Security:
//   - Output is plain text — NO HTML rendering happens here. Email providers
//     consuming the result are responsible for escape if they switch to HTML.
//   - Unknown / undefined path → empty string (NOT '{{var}}' literal). Stops
//     accidental {{ }} leaks in production emails.
//   - Max iteration depth = 1 (no recursive substitution); avoids
//     {{ a.b }}={{ c.d }} → loop.
//
// Limits:
//   - 200KB body cap (subject 5KB) — prevents pathological templates from
//     ballooning into multi-MB messages.

const VAR_RE = /\{\{\s*([a-zA-Z_][\w.]*)\s*\}\}/g;
const MAX_BODY_BYTES = 200 * 1024;
const MAX_SUBJECT_BYTES = 5 * 1024;

export type TemplateContext = Record<string, unknown>;

/**
 * Resolve a dot-path against a context object. Returns the leaf value if a
 * scalar (string | number | boolean), null otherwise.
 */
function resolvePath(ctx: TemplateContext, path: string): string | null {
  const parts = path.split('.');
  let cur: unknown = ctx;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[p];
  }
  if (cur === null || cur === undefined) return null;
  if (typeof cur === 'string') return cur;
  if (typeof cur === 'number' || typeof cur === 'boolean') return String(cur);
  // Objects / arrays render as empty — caller should pre-flatten.
  return null;
}

/**
 * Render a template against a context. Returns the rendered string.
 * Throws RangeError if the body exceeds MAX_BODY_BYTES.
 */
export function renderTemplate(
  template: string,
  ctx: TemplateContext,
  opts: { maxBytes?: number } = {},
): string {
  const out = template.replace(VAR_RE, (_match, path: string) => {
    const v = resolvePath(ctx, path);
    return v ?? '';
  });
  const max = opts.maxBytes ?? MAX_BODY_BYTES;
  if (Buffer.byteLength(out, 'utf8') > max) {
    throw new RangeError(`Rendered template exceeds ${max} bytes`);
  }
  return out;
}

/**
 * Convenience for rendering subject + body together. Returns a structured
 * result so callers can pass directly to provider.send.
 */
export function renderMessage(
  subject: string | null | undefined,
  body: string,
  ctx: TemplateContext,
): { subject: string | null; body: string } {
  return {
    subject: subject == null ? null : renderTemplate(subject, ctx, { maxBytes: MAX_SUBJECT_BYTES }),
    body: renderTemplate(body, ctx),
  };
}

/**
 * Extract the placeholder set from a template — used by the UI to warn when
 * the supplied context is missing a required variable.
 */
export function extractPlaceholders(template: string): string[] {
  const seen = new Set<string>();
  for (const m of template.matchAll(VAR_RE)) {
    seen.add(m[1]!);
  }
  return Array.from(seen).sort();
}
