// Pure display-formatting helpers. Mostly Intl-based; React hooks live at the
// bottom and are tree-shakeable away from server-component callers.
//
// dayjs (with utc + timezone plugins) is also extended here so callers across
// the app can `import dayjs from 'dayjs'` and use `.tz(value, userTz)` without
// repeating the boilerplate. Extending happens module-load-time and is a no-op
// on subsequent imports.

import { useMemo } from 'react';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { useAuth } from './auth';

dayjs.extend(utc);
dayjs.extend(timezone);

const RTF_UNITS: { unit: Intl.RelativeTimeFormatUnit; ms: number }[] = [
  { unit: 'year', ms: 365.25 * 24 * 60 * 60 * 1000 },
  { unit: 'month', ms: 30.4375 * 24 * 60 * 60 * 1000 },
  { unit: 'week', ms: 7 * 24 * 60 * 60 * 1000 },
  { unit: 'day', ms: 24 * 60 * 60 * 1000 },
  { unit: 'hour', ms: 60 * 60 * 1000 },
  { unit: 'minute', ms: 60 * 1000 },
  { unit: 'second', ms: 1000 },
];

export type FormatOptions = {
  /** IANA time zone, e.g. "Europe/London". When omitted, runtime default. */
  timeZone?: string;
};

/**
 * Returns a relative phrase like "5 minutes ago" / "in 3 days" using
 * Intl.RelativeTimeFormat. Falls back to "—" for invalid input.
 *
 * The `timeZone` option is accepted for API symmetry with the other helpers
 * but is unused — relative differences are intrinsically TZ-independent.
 */
export function formatRelative(iso: string, locale = 'en', _opts: FormatOptions = {}): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diff = then - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const { unit, ms } of RTF_UNITS) {
    if (abs >= ms || unit === 'second') {
      const value = Math.round(diff / ms);
      return rtf.format(value, unit);
    }
  }
  return rtf.format(0, 'second');
}

/** "14 May 2026" — short, locale-aware date with no time component. */
export function formatDate(iso: string, locale = 'en', opts: FormatOptions = {}): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
  }).format(d);
}

/** "14 May 2026, 09:42" — date + 24h time. */
export function formatDateTime(iso: string, locale = 'en', opts: FormatOptions = {}): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
  }).format(d);
}

/**
 * Light formatting for E.164 phone numbers. Inserts a space after the country
 * code and groups the remainder into readable chunks. Returns the original
 * string when the input doesn't look like E.164.
 */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return '';
  const trimmed = e164.trim();
  if (!trimmed.startsWith('+')) return trimmed;
  const digits = trimmed.slice(1).replace(/\D/g, '');
  if (digits.length < 4) return trimmed;
  // Country code is 1–3 digits; pick the longest plausible prefix.
  const ccLen = digits.length > 11 ? 3 : digits.length > 10 ? 2 : 1;
  const cc = digits.slice(0, ccLen);
  const rest = digits.slice(ccLen);
  // Group remainder: last 4 always, then a 3-or-4 digit lead, middle as a chunk.
  let grouped: string;
  if (rest.length <= 4) {
    grouped = rest;
  } else if (rest.length <= 7) {
    grouped = `${rest.slice(0, rest.length - 4)} ${rest.slice(-4)}`;
  } else {
    const leadLen = rest.length > 10 ? 4 : 3;
    const lead = rest.slice(0, leadLen);
    const tail = rest.slice(-4);
    const middle = rest.slice(leadLen, rest.length - 4);
    grouped = [lead, middle, tail].filter(Boolean).join(' ');
  }
  return `+${cc} ${grouped}`.trim();
}

/**
 * Formats a money amount expressed in *minor* units (e.g. cents/pence) using
 * Intl.NumberFormat for the supplied currency. Accepts bigint, number, or a
 * numeric string; returns "—" for null/undefined/invalid input.
 *
 * `locale` defaults to `undefined` so Intl picks the runtime default — pass an
 * explicit BCP-47 tag (typically from the active user) when the call needs to
 * respect a per-user preference.
 */
export function formatMoney(
  minor: bigint | number | string | null | undefined,
  currency: string,
  locale: string | undefined = undefined,
): string {
  if (minor === null || minor === undefined || minor === '') return '—';
  const cur = (currency || 'USD').toUpperCase();
  // Determine minor-unit scale via Intl when possible; default to 2.
  const fractionDigits = (() => {
    try {
      const fmt = new Intl.NumberFormat(locale, { style: 'currency', currency: cur });
      const opts = fmt.resolvedOptions();
      return opts.maximumFractionDigits ?? 2;
    } catch {
      return 2;
    }
  })();
  const scale = 10 ** fractionDigits;

  let major: number;
  if (typeof minor === 'bigint') {
    // Use string division to avoid precision loss for very large bigints.
    const negative = minor < 0n;
    const abs = negative ? -minor : minor;
    const whole = abs / BigInt(scale);
    const frac = abs % BigInt(scale);
    const fracStr = frac.toString().padStart(fractionDigits, '0');
    const num = Number(`${whole}.${fracStr}`);
    major = negative ? -num : num;
  } else {
    const n = typeof minor === 'string' ? Number(minor) : minor;
    if (!Number.isFinite(n)) return '—';
    major = n / scale;
  }

  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: cur,
    }).format(major);
  } catch {
    return `${cur} ${major.toFixed(fractionDigits)}`;
  }
}

/** Human-readable byte size: 1.4 KB, 23.7 MB, 1.1 GB. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[i]}`;
}

/** "AB" from given/family names, falling back to "?" when both are blank. */
export function initials(given?: string, family?: string): string {
  const g = (given ?? '').trim();
  const f = (family ?? '').trim();
  const gi = g ? g[0]!.toUpperCase() : '';
  const fi = f ? f[0]!.toUpperCase() : '';
  const out = `${gi}${fi}`;
  if (out) return out;
  const any = (g || f).replace(/[^A-Za-z]/g, '');
  return any ? any.slice(0, 2).toUpperCase() : '?';
}

// ---------------------------------------------------------------------------
// React hooks — bind the helpers to the active user's locale + timezone.
// ---------------------------------------------------------------------------

export type UserContext = {
  locale: string;
  timezone: string;
};

/**
 * Returns the active user's locale + timezone, falling back to sensible
 * defaults when no user is signed in (e.g. on /login). `locale` defaults to
 * `'en'` to match the historic Intl behavior; `timezone` defaults to `'UTC'`.
 */
export function useUserContext(): UserContext {
  const { user } = useAuth();
  return useMemo(
    () => ({
      locale: user?.locale?.trim() || 'en',
      timezone: user?.timezone?.trim() || 'UTC',
    }),
    [user?.locale, user?.timezone],
  );
}

export type BoundFormatters = {
  date: (iso: string) => string;
  dateTime: (iso: string) => string;
  relative: (iso: string) => string;
  money: (
    amount: bigint | number | string | null | undefined,
    currency: string,
  ) => string;
  /** Render a 0-100 percentage value as a localized string ("83%"). */
  percent: (value: number, fractionDigits?: number) => string;
  /** Underlying user context for callers that need raw Intl access. */
  locale: string;
  timezone: string;
};

/**
 * Returns a stable bag of formatters bound to the active user's locale +
 * timezone. Use this from client components to keep date/money rendering
 * consistent with the user's settings.
 */
export function useFormat(): BoundFormatters {
  const { locale, timezone } = useUserContext();
  return useMemo<BoundFormatters>(
    () => ({
      date: (iso: string) => formatDate(iso, locale, { timeZone: timezone }),
      dateTime: (iso: string) => formatDateTime(iso, locale, { timeZone: timezone }),
      relative: (iso: string) => formatRelative(iso, locale, { timeZone: timezone }),
      money: (amount, currency) => formatMoney(amount, currency, locale),
      percent: (value: number, fractionDigits = 0) => {
        if (!Number.isFinite(value)) return '—';
        return new Intl.NumberFormat(locale, {
          style: 'percent',
          maximumFractionDigits: fractionDigits,
          minimumFractionDigits: fractionDigits,
        }).format(value / 100);
      },
      locale,
      timezone,
    }),
    [locale, timezone],
  );
}
