// SVT-V2-CRM-MIRROR-2026-06 — finance-grade money input (client mirror of the
// backend shared/money.ts). Converts a major-unit decimal string to minor
// units precisely (no float) using the currency's real ISO-4217 exponent, so
// manual fee entry is correct for 0-/2-/3-decimal currencies alike.

const digitsCache = new Map<string, number>();

export function currencyMinorDigits(currency: string): number {
  const cur = (currency || 'USD').toUpperCase();
  const cached = digitsCache.get(cur);
  if (cached !== undefined) return cached;
  let d = 2;
  try {
    d = new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    d = 2;
  }
  digitsCache.set(cur, d);
  return d;
}

/**
 * Major-unit decimal string → minor-unit string (for the wire), currency-aware,
 * no float, round half-up. Returns null on malformed input.
 */
export function majorToMinor(major: string, currency: string): string | null {
  const s = String(major).trim();
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const neg = m[1] === '-';
  const intPart = m[2]!;
  const fracRaw = m[3] ?? '';
  const exp = currencyMinorDigits(currency);
  const fracKeep = fracRaw.slice(0, exp).padEnd(exp, '0');
  let base = BigInt(intPart) * 10n ** BigInt(exp) + BigInt(fracKeep === '' ? '0' : fracKeep);
  if (fracRaw.length > exp && fracRaw.charCodeAt(exp) - 48 >= 5) base += 1n;
  return (neg ? -base : base).toString();
}
