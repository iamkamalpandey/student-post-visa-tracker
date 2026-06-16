import { describe, it, expect } from 'vitest';
import { currencyMinorDigits, decimalToMinor } from '../src/shared/money.js';

// SVT-DEPLOY-AUDIT-2026-06 — battle-test the money conversion used by the V2
// ingest (fee/payment amounts) + the lead→student convert (fee migration).
// A wrong exponent or rounding here = wrong money. No float, currency-aware.

describe('currencyMinorDigits', () => {
  it('knows ISO-4217 exponents', () => {
    expect(currencyMinorDigits('USD')).toBe(2);
    expect(currencyMinorDigits('NPR')).toBe(2);
    expect(currencyMinorDigits('GBP')).toBe(2);
    expect(currencyMinorDigits('JPY')).toBe(0); // 0-decimal
    expect(currencyMinorDigits('KWD')).toBe(3); // 3-decimal
    expect(currencyMinorDigits('BHD')).toBe(3);
  });
  it('is case-insensitive + defaults to 2', () => {
    expect(currencyMinorDigits('jpy')).toBe(0);
    expect(currencyMinorDigits('usd')).toBe(2);
    expect(currencyMinorDigits('')).toBe(2); // → USD default
    expect(currencyMinorDigits('ZZZ')).toBe(2); // unknown → fallback
  });
});

describe('decimalToMinor', () => {
  it('returns null for null/blank/malformed', () => {
    expect(decimalToMinor(null, 'USD')).toBeNull();
    expect(decimalToMinor(undefined, 'USD')).toBeNull();
    expect(decimalToMinor('', 'USD')).toBeNull();
    expect(decimalToMinor('   ', 'USD')).toBeNull();
    expect(decimalToMinor('abc', 'USD')).toBeNull();
    expect(decimalToMinor('1.2.3', 'USD')).toBeNull();
    expect(decimalToMinor('1,000', 'USD')).toBeNull(); // commas not parsed
  });

  it('scales 2-decimal currencies (USD/NPR)', () => {
    expect(decimalToMinor('0', 'USD')).toBe(0n);
    expect(decimalToMinor('0.00', 'USD')).toBe(0n);
    expect(decimalToMinor('100', 'USD')).toBe(10000n);
    expect(decimalToMinor('100.5', 'USD')).toBe(10050n); // short fraction padded
    expect(decimalToMinor('100.50', 'NPR')).toBe(10050n);
    expect(decimalToMinor('12345.67', 'USD')).toBe(1234567n);
  });

  it('respects 0-decimal (JPY) + 3-decimal (KWD)', () => {
    expect(decimalToMinor('1000', 'JPY')).toBe(1000n);
    expect(decimalToMinor('1.234', 'KWD')).toBe(1234n);
    expect(decimalToMinor('5', 'KWD')).toBe(5000n);
  });

  it('rounds HALF-UP at the minor boundary', () => {
    expect(decimalToMinor('1.005', 'USD')).toBe(101n); // dropped digit 5 → up
    expect(decimalToMinor('1.004', 'USD')).toBe(100n); // dropped digit 4 → down
    expect(decimalToMinor('1.999', 'USD')).toBe(200n); // carries
    expect(decimalToMinor('1000.99', 'JPY')).toBe(1001n); // 0-dp: .99 → +1
    expect(decimalToMinor('1.2345', 'KWD')).toBe(1235n); // 3-dp: dropped 5 → up
    expect(decimalToMinor('1.2344', 'KWD')).toBe(1234n);
  });

  it('handles large values without float drift', () => {
    expect(decimalToMinor('99999999999.99', 'USD')).toBe(9999999999999n);
    // The classic float trap: 0.1 + 0.2 style — exact here.
    expect(decimalToMinor('0.30', 'USD')).toBe(30n);
    expect(decimalToMinor('0.1', 'USD')).toBe(10n);
  });

  it('handles negatives (adjustments/refunds)', () => {
    expect(decimalToMinor('-5.50', 'USD')).toBe(-550n);
    expect(decimalToMinor('-0.01', 'USD')).toBe(-1n);
  });

  it('is currency-case-insensitive', () => {
    expect(decimalToMinor('10', 'jpy')).toBe(10n);
    expect(decimalToMinor('10', 'kwd')).toBe(10000n);
  });
});
