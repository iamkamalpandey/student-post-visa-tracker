// SVT P2 — bulk-import integrity guards in the dry-run pre-flight:
//   1. an empty (0-row) file is flagged, not silently "successful";
//   2. two rows that share a dedupe key (would collide last-write-wins on
//      apply) are flagged so the operator fixes the source.
// Uses a tiny fake Prisma client — the dry-run only reads (country lookup +
// existence probe), so stubbing those is enough to exercise the new logic.

import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { runDryRun } from '../src/modules/imports/lib/dry-run.js';

const fakeDb = {
  country: { findUnique: async () => ({ code_alpha2: 'GB' }) },
  institution: { findFirst: async () => null },
} as unknown as PrismaClient;

const inst = (legal_name: string) => ({
  legal_name,
  display_name: legal_name,
  type: 'UNIVERSITY',
  country_code: 'GB',
});

describe('runDryRun integrity guards (SVT P2)', () => {
  it('flags an empty file instead of reporting a silent success', async () => {
    const s = await runDryRun({ resource: 'students', rows: [], mapping: {}, tenantId: 't', db: fakeDb });
    expect(s.errors).toBe(1);
    expect(s.willCreate).toBe(0);
    expect(s.sample[0]?.field).toBe('(file)');
    expect(s.sample[0]?.error).toMatch(/no data rows/i);
  });

  it('flags a within-file duplicate (same dedupe key) as an error', async () => {
    const s = await runDryRun({
      resource: 'institutions',
      rows: [inst('Acme University'), inst('Acme University')],
      mapping: {},
      tenantId: 't',
      db: fakeDb,
    });
    expect(s.willCreate).toBe(1); // first occurrence still counts
    expect(s.errors).toBe(1); // second occurrence flagged
    expect(s.sample[0]?.error).toMatch(/Duplicate of row 1/);
  });

  it('treats case/whitespace variants of the key as the same duplicate', async () => {
    const s = await runDryRun({
      resource: 'institutions',
      rows: [inst('Acme University'), inst('  acme university  ')],
      mapping: {},
      tenantId: 't',
      db: fakeDb,
    });
    expect(s.errors).toBe(1);
  });

  it('does NOT flag distinct rows', async () => {
    const s = await runDryRun({
      resource: 'institutions',
      rows: [inst('Acme University'), inst('Beta College')],
      mapping: {},
      tenantId: 't',
      db: fakeDb,
    });
    expect(s.errors).toBe(0);
    expect(s.willCreate).toBe(2);
  });
});
