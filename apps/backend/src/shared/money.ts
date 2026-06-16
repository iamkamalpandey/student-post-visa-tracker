// SVT-V2-CRM-MIRROR-2026-06 — finance-grade money conversion.
//
// V2 stores money as Decimal strings; SPVT stores BigInt minor units +
// ISO-4217 currency. Parsing via JS float (Number * 100) loses precision and
// assumes 2 decimal places — wrong for 0-decimal (JPY) or 3-decimal (KWD)
// currencies. These helpers parse the decimal STRING exactly (no float) and
// scale by the currency's real minor-unit exponent.

const digitsCache = new Map<string, number>();

/** ISO 4217 minor-unit exponent for a currency (JPY=0, USD/NPR=2, KWD=3). */
export function currencyMinorDigits(currency: string): number {
  const cur = (currency || 'USD').toUpperCase();
  const cached = digitsCache.get(cur);
  if (cached !== undefined) return cached;
  let d = 2;
  try {
    // Intl knows ISO-4217 fraction digits — no dependency, no hardcoded table.
    d = new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    d = 2;
  }
  digitsCache.set(cur, d);
  return d;
}

/**
 * Precise decimal-string → minor units (BigInt), currency-aware, NO float.
 * Rounds half-up at the currency's minor-unit boundary. Returns null for
 * null/blank/malformed input.
 */
export function decimalToMinor(amount: string | null | undefined, currency: string): bigint | null {
  if (amount == null) return null;
  const s = String(amount).trim();
  if (s === '') return null;
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const neg = m[1] === '-';
  const intPart = m[2]!;
  const fracRaw = m[3] ?? '';
  const exp = currencyMinorDigits(currency);
  const fracKeep = fracRaw.slice(0, exp).padEnd(exp, '0');
  let base = BigInt(intPart) * 10n ** BigInt(exp) + BigInt(fracKeep === '' ? '0' : fracKeep);
  // Round half-up using the first dropped digit.
  if (fracRaw.length > exp && fracRaw.charCodeAt(exp) - 48 >= 5) base += 1n;
  return neg ? -base : base;
}
