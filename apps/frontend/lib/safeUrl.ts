// SVT-SEC-P0-FE1-2026-05 — strict external-URL scheme guard for <a href={...}>.
//
// This helper is the render-time complement to the storage-side Zod refines on
// every URL field (`website`, `url`, `contract_url`, `logo_url`, ...). The Zod
// refines reject `javascript:`, `data:`, `vbscript:`, `file:` etc. on the wire,
// but legacy rows imported before that gate landed may still hold such values
// — and a future code path that forgets the gate would re-introduce the XSS.
//
// `safeExternalUrl` is intentionally narrower than `safeHref`:
//   * It allows ONLY http:// and https://.
//   * No mailto:, tel:, or site-relative paths — those would be a category
//     error for an "external URL" field and almost certainly indicate a bug
//     upstream.
//
// Returns `null` (not undefined) on rejection so callers can short-circuit
// with `?? null` and the type system reminds them to handle the no-link case.
// Recommended usage:
//
//   const href = safeExternalUrl(institution.website);
//   return href ? <a href={href} rel="noopener noreferrer">…</a> : <span>…</span>;

export function safeExternalUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  // Anchor the regex so trailing junk after the scheme can't sneak past
  // (e.g. " https://evil  javascript:alert(1) " — trim handles leading space,
  // the regex requires the scheme at start, but we further parse via URL so
  // protocol-relative ("//evil.com") and host-only inputs are also rejected.
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}
