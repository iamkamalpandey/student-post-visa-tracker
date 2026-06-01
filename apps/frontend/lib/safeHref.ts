// SVT-SEC-P1-FE1-2026-05 — render-time scheme allowlist for external link fields.
//
// Background:
//   User-supplied "website" / "url" / "contract_url" / "action_url" values flow
//   straight into <a href={…}>. A javascript:, data:, or vbscript: URL there
//   becomes a one-click XSS as soon as a counsellor opens the page (clicking
//   the link executes the script in the app's origin). Existing data may
//   contain such values from historical imports.
//
// Strategy:
//   * Allowlist absolute schemes we ever expect a counsellor to follow:
//     http(s), mailto, tel.
//   * Allow site-relative paths (leading "/") so internal nav like
//     "/students/123" still works through this helper.
//   * Returns `undefined` for anything else (including null/empty). The caller
//     then renders <a> WITHOUT an href, which is safer than href="#" (no
//     navigation, no click handler hijack) and degrades the link to plain text
//     visually while keeping the surrounding markup intact.
//
// Defence-in-depth:
//   Storage-side validation in @spv/zod-schemas now enforces http(s) on URL
//   fields too — see institutions.ts / super-agents.ts / programs.ts /
//   sub-processors.ts. This helper exists for legacy rows and any field that
//   slips through.

// Allowed shapes:
//   * https://… or http://…  — explicit web URL.
//   * mailto:…                — email link.
//   * tel:…                   — phone link.
//   * /path or just "/"       — site-relative path.
// We deliberately reject protocol-relative URLs (//evil.com/…) because they
// inherit the page's protocol AND host parsing rules — under a future http
// proxy that could send a click to an attacker-controlled origin.
const SAFE_HREF_RE = /^(?:https?:\/\/|mailto:|tel:|\/(?!\/))/i;

export function safeHref(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (!SAFE_HREF_RE.test(trimmed)) return undefined;
  return trimmed;
}
