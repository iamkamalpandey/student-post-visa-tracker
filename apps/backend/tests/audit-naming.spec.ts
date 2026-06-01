import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// SVT-AUDIT-NAMING-2026-05: every writeAudit({ action: '<x>' }) must use the
// canonical <snake_case_entity>.<verb> pattern. Past-tense for CRUD verbs;
// compound verbs allowed for FSM transitions + auth subdomain.
const CANONICAL = /^(auth\.[a-z_.]+|[a-z_]+(?:\.[a-z_]+)+)$/;

// Verbs that must be past-tense when the action is a CRUD-style flip.
const CRUD_PRESENT = new Set(['create', 'update', 'delete', 'enqueue', 'cancel', 'start', 'patch']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('audit action taxonomy', () => {
  it('every writeAudit action uses canonical <entity>.<verb> shape', () => {
    const files = walk('src');
    const offenders: Array<{ file: string; action: string }> = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/action:\s*['"]([a-z_.]+)['"]/g)) {
        const a = m[1]!;
        if (!CANONICAL.test(a)) {
          offenders.push({ file: f, action: a });
          continue;
        }
        const last = a.split('.').pop()!;
        if (CRUD_PRESENT.has(last)) {
          offenders.push({ file: f, action: a });
        }
      }
    }
    if (offenders.length > 0) {
      console.log('Non-canonical audit actions:', JSON.stringify(offenders, null, 2));
    }
    expect(offenders).toEqual([]);
  });
});
