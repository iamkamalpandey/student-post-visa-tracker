// Header → canonical-column suggestion via normalised exact match + a small
// Levenshtein fallback. Pulled out of imports.service.ts to keep the
// orchestrator focused on lifecycle.

import type { ImportResource } from '@spv/zod-schemas';
import { RESOURCE_ALIASES } from './aliases.js';

function normalise(s: string): string {
  return s.trim().toLowerCase().replace(/[\s_\-./]+/g, ' ');
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  // Single-row DP.
  const prev = new Array<number>(n + 1);
  const cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j]!;
  }
  return prev[n]!;
}

/**
 * Build a header → canonical-column mapping. Headers that match an alias exactly
 * (case-insensitive, normalised) win outright; otherwise we fall back to the closest
 * canonical name within a small Levenshtein budget so typos like "frist_name" still land.
 */
export function suggestMapping(headers: string[], resource: ImportResource): Record<string, string> {
  const aliases = RESOURCE_ALIASES[resource];
  const out: Record<string, string> = {};
  if (!aliases) return out;
  // Build a flat alias → canonical lookup.
  const flat = new Map<string, string>();
  for (const [canonical, alts] of Object.entries(aliases)) {
    flat.set(normalise(canonical), canonical);
    for (const alt of alts) flat.set(normalise(alt), canonical);
  }
  const canonicalKeys = Object.keys(aliases);

  for (const h of headers) {
    const n = normalise(h);
    const direct = flat.get(n);
    if (direct) {
      out[h] = direct;
      continue;
    }
    // Fuzzy match: pick the canonical key with the smallest distance, capped at 2.
    let best: string | null = null;
    let bestDist = Infinity;
    for (const c of canonicalKeys) {
      const d = levenshtein(n, normalise(c));
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    if (best && bestDist <= 2) out[h] = best;
  }
  return out;
}

/**
 * Apply a header → canonical-name mapping to a single row, dropping any
 * unmapped sources but keeping unmapped keys verbatim so mappers can
 * opportunistically read them.
 */
export function applyMapping(
  row: Record<string, unknown>,
  mapping: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [src, target] of Object.entries(mapping)) {
    if (src in row) out[target] = row[src];
  }
  for (const k of Object.keys(row)) {
    if (!(k in mapping) && !(k in out)) out[k] = row[k];
  }
  return out;
}
