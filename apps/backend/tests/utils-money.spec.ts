import { describe, it, expect } from 'vitest';
import { toMinor, toMajor } from '@spv/utils';

describe('@spv/utils money', () => {
  it('round-trips JPY (minorUnit=0)', () => {
    const cases = ['0', '1', '12345', '99999999999'];
    for (const v of cases) {
      const minor = toMinor(v, 0);
      expect(toMajor(minor, 0)).toBe(v);
    }
  });

  it('round-trips USD (minorUnit=2)', () => {
    const cases = ['0.00', '0.01', '1.23', '12345.67', '999999999.99'];
    for (const v of cases) {
      const minor = toMinor(v, 2);
      expect(toMajor(minor, 2)).toBe(v);
    }
  });

  it('round-trips BHD (minorUnit=3)', () => {
    const cases = ['0.000', '0.001', '1.234', '12345.678'];
    for (const v of cases) {
      const minor = toMinor(v, 3);
      expect(toMajor(minor, 3)).toBe(v);
    }
  });

  it('handles negative amounts', () => {
    expect(toMinor('-1.23', 2)).toBe(-123n);
    expect(toMajor(-123n, 2)).toBe('-1.23');
  });

  it('truncates excess fractional digits when going minor', () => {
    // toMinor with minorUnit=2 and three fraction digits should truncate the third.
    expect(toMinor('1.239', 2)).toBe(123n);
  });

  it('accepts numeric input', () => {
    expect(toMinor(12.34, 2)).toBe(1234n);
  });
});
