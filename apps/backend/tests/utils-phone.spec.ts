import { describe, it, expect } from 'vitest';
import { isE164, assertE164, stripPhoneFormatting } from '@spv/utils';

describe('@spv/utils phone (E.164)', () => {
  it('accepts well-formed E.164 numbers', () => {
    expect(isE164('+14155550123')).toBe(true);
    expect(isE164('+447911123456')).toBe(true);
    expect(isE164('+9779812345678')).toBe(true);
    // Min length: '+' + 1 digit (1-9) + 6 digits = 8 chars total
    expect(isE164('+1234567')).toBe(true);
    // Max length: '+' + 15 digits = 16 chars total
    expect(isE164('+123456789012345')).toBe(true);
  });

  it('rejects malformed numbers', () => {
    expect(isE164('14155550123')).toBe(false); // missing +
    expect(isE164('+0155550123')).toBe(false); // leading 0 after +
    expect(isE164('+')).toBe(false);
    expect(isE164('+1')).toBe(false); // too short
    expect(isE164('+1234567890123456')).toBe(false); // too long (16 digits)
    expect(isE164('+1 415 555 0123')).toBe(false); // contains spaces
    expect(isE164('+1-415-555-0123')).toBe(false); // contains dashes
    expect(isE164('not-a-phone')).toBe(false);
  });

  it('assertE164 throws on invalid input', () => {
    expect(() => assertE164('14155550123')).toThrow();
    expect(assertE164('+14155550123')).toBe('+14155550123');
  });

  it('stripPhoneFormatting strips everything but digits and +', () => {
    expect(stripPhoneFormatting('+1 (415) 555-0123')).toBe('+14155550123');
    expect(stripPhoneFormatting('+44 7911 123 456')).toBe('+447911123456');
  });
});
