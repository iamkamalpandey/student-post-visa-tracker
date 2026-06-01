import { describe, it, expect } from 'vitest';
import { uuidv7, isUuid } from '@spv/utils';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('@spv/utils uuidv7', () => {
  it('produces a syntactically valid UUID', () => {
    const id = uuidv7();
    expect(id).toMatch(UUID_RE);
    expect(isUuid(id)).toBe(true);
  });

  it('has version nibble = 7', () => {
    for (let i = 0; i < 25; i++) {
      const id = uuidv7();
      // 15th hex char (index 14) is the version nibble.
      expect(id.charAt(14)).toBe('7');
    }
  });

  it('has RFC 4122 variant bits 10xx (high nibble in {8,9,a,b})', () => {
    for (let i = 0; i < 25; i++) {
      const id = uuidv7();
      // 20th hex char (index 19) is the variant nibble.
      const variantNibble = id.charAt(19).toLowerCase();
      expect(['8', '9', 'a', 'b']).toContain(variantNibble);
    }
  });

  it('produces unique values across rapid invocations', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) ids.add(uuidv7());
    expect(ids.size).toBe(200);
  });

  it('is approximately time-ordered (ascending by string compare within the same ms-ish window)', () => {
    const a = uuidv7();
    // Force progress
    const start = Date.now();
    while (Date.now() === start) {
      // spin briefly
    }
    const b = uuidv7();
    expect(a < b).toBe(true);
  });
});
