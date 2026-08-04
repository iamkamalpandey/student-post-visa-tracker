// SVT-QA-2026-08 — client-side role guards.
//
// These decide which buttons a user is even shown. They are NOT the security
// boundary — the backend re-checks every mutation via requireRole /
// requireStudentOwnership / requireLeadOwnership, and must keep doing so.
// But a guard that wrongly returns `true` shows a counsellor an admin action
// that then 403s, and one that wrongly returns `false` silently removes
// capability a user is entitled to. Both are real defects, so the truth table
// is pinned exhaustively rather than sampled.

import { describe, it, expect } from 'vitest';
import type { Role } from '@spv/api-types';
import {
  isAdmin,
  isCounsellor,
  isReadOnly,
  canWriteStudents,
  canManageStages,
  canManageUsers,
} from '@/lib/auth-helpers';

// Every input the app can actually produce, including the absent-role states
// that occur before auth bootstrap resolves.
const INPUTS: Array<Role | null | undefined> = ['ADMIN', 'COUNSELLOR', 'VIEWER', null, undefined];

type Guard = (r?: Role | null) => boolean;

/** Exhaustive truth table: guard -> the exact set of roles it permits. */
const TABLE: Array<{ name: string; fn: Guard; allows: Array<Role | null | undefined> }> = [
  { name: 'isAdmin', fn: isAdmin, allows: ['ADMIN'] },
  { name: 'isCounsellor', fn: isCounsellor, allows: ['COUNSELLOR'] },
  // Absent role must count as read-only: during bootstrap we must not flash
  // write affordances the user may not have.
  { name: 'isReadOnly', fn: isReadOnly, allows: ['VIEWER', null, undefined] },
  { name: 'canWriteStudents', fn: canWriteStudents, allows: ['ADMIN', 'COUNSELLOR'] },
  { name: 'canManageStages', fn: canManageStages, allows: ['ADMIN'] },
  { name: 'canManageUsers', fn: canManageUsers, allows: ['ADMIN'] },
];

describe('auth-helpers — exhaustive role truth table', () => {
  for (const { name, fn, allows } of TABLE) {
    for (const role of INPUTS) {
      const expected = allows.includes(role);
      it(`${name}(${String(role)}) === ${expected}`, () => {
        expect(fn(role)).toBe(expected);
      });
    }
  }
});

describe('auth-helpers — invariants that must never regress', () => {
  it('VIEWER can never write students, manage stages, or manage users', () => {
    // VIEWER is additionally blocked server-side for every non-GET method, but
    // the UI must not offer the action in the first place.
    expect(canWriteStudents('VIEWER')).toBe(false);
    expect(canManageStages('VIEWER')).toBe(false);
    expect(canManageUsers('VIEWER')).toBe(false);
  });

  it('COUNSELLOR can write students but cannot manage stages or users', () => {
    expect(canWriteStudents('COUNSELLOR')).toBe(true);
    expect(canManageStages('COUNSELLOR')).toBe(false);
    expect(canManageUsers('COUNSELLOR')).toBe(false);
  });

  it('isReadOnly is the exact complement of "has a writing role"', () => {
    for (const role of INPUTS) {
      expect(isReadOnly(role)).toBe(!canWriteStudents(role));
    }
  });

  it('an unresolved role grants nothing', () => {
    for (const guard of [isAdmin, isCounsellor, canWriteStudents, canManageStages, canManageUsers]) {
      expect(guard(null)).toBe(false);
      expect(guard(undefined)).toBe(false);
    }
  });
});
