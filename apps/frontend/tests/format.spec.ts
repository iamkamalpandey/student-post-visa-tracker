// SVT-QA-2026-08 — date/money formatting.
//
// Two of these pin bugs found in the brutal audit and fixed this cycle:
//   * `todayLocalIso` exists because `new Date().toISOString().slice(0,10)`
//     returns the UTC day, so a user in EDT marking a fee paid at 21:00 local
//     recorded it a day EARLY. That is a real accounting error, not cosmetics.
//   * `formatRelative` clamps near-now to "now" because a row created
//     server-side a few seconds ahead of the client clock rendered as
//     future-tense ("in 1 second") in the DSAR SLA column.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { formatRelative, formatDate, todayLocalIso } from '@/lib/format';

afterEach(() => {
  vi.useRealTimers();
});

describe('todayLocalIso — LOCAL calendar day, not UTC', () => {
  it('returns the local day even when UTC has already rolled over', () => {
    // 2026-08-04T01:30:00Z. In a UTC-5 zone that is still 2026-08-03 locally.
    // Using toISOString() here would wrongly yield 2026-08-04.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T01:30:00Z'));

    const local = new Date();
    const expected = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(
      local.getDate(),
    ).padStart(2, '0')}`;

    expect(todayLocalIso()).toBe(expected);
  });

  it('always produces a zero-padded YYYY-MM-DD', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-05T12:00:00Z'));
    expect(todayLocalIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('formatRelative — clamps near-now, both directions', () => {
  it('renders a just-created row as "now", not future-tense', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T12:00:00Z'));
    // Server stamped it 1s in the future relative to this client's clock.
    const oneSecondAhead = new Date('2026-08-04T12:00:01Z').toISOString();
    const out = formatRelative(oneSecondAhead);
    expect(out).not.toMatch(/in \d/);
    expect(out).toBe('now');
  });

  it('also clamps a few seconds in the past', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T12:00:00Z'));
    expect(formatRelative(new Date('2026-08-04T11:59:55Z').toISOString())).toBe('now');
  });

  it('still reports genuinely-past times normally', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T12:00:00Z'));
    expect(formatRelative(new Date('2026-08-04T10:00:00Z').toISOString())).toMatch(/hour/);
  });

  it('still reports genuinely-future times as future', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-04T12:00:00Z'));
    // 5 days out is well beyond the 30s clamp — must stay future-tense.
    expect(formatRelative(new Date('2026-08-09T12:00:00Z').toISOString())).toMatch(/in \d/);
  });

  it('returns an em-dash placeholder for empty/invalid input', () => {
    expect(formatRelative('')).toBe('—');
    expect(formatRelative('not-a-date')).toBe('—');
  });
});

describe('formatDate', () => {
  it('formats an ISO date without a time component', () => {
    expect(formatDate('2026-05-14T00:00:00Z', 'en', { timeZone: 'UTC' })).toContain('2026');
  });

  it('returns the placeholder for empty/invalid input rather than "Invalid Date"', () => {
    expect(formatDate('')).toBe('—');
    expect(formatDate('nonsense')).toBe('—');
  });
});
