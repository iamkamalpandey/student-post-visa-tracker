// SVT-LIFECYCLE-2026-06 — guards the seeded default lifecycle-stage data: the
// post-visa journey now continues past "enrolled" to graduation / post-study
// work, and the data must stay structurally sound (single initial + terminal,
// contiguous sequence, valid categories) for the stage FSM + dashboards.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const VALID_CATEGORIES = new Set([
  'PRE_DEPARTURE',
  'IN_TRANSIT',
  'POST_ARRIVAL',
  'ENROLLED',
  'COMPLETED',
  'EXCEPTION',
  'IN_PROGRESS',
]);

type Stage = {
  key: string;
  label: string;
  sequence: number;
  category: string;
  is_initial: boolean;
  is_terminal: boolean;
};

const stages: Stage[] = JSON.parse(
  readFileSync(resolve(process.cwd(), 'prisma/data/default-stages.json'), 'utf8'),
);

describe('default lifecycle stages data', () => {
  it('is a non-empty array of well-formed stages with valid categories', () => {
    expect(Array.isArray(stages)).toBe(true);
    expect(stages.length).toBeGreaterThan(0);
    for (const s of stages) {
      expect(typeof s.key).toBe('string');
      expect(typeof s.label).toBe('string');
      expect(VALID_CATEGORIES.has(s.category), s.category).toBe(true);
    }
  });

  it('has exactly one initial and exactly one terminal stage', () => {
    expect(stages.filter((s) => s.is_initial)).toHaveLength(1);
    expect(stages.filter((s) => s.is_terminal)).toHaveLength(1);
  });

  it('has unique keys and a contiguous 1..N sequence', () => {
    const keys = stages.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    const seqs = stages.map((s) => s.sequence).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: stages.length }, (_, i) => i + 1));
  });

  it('covers the full post-visa lifecycle incl. graduation / post-study-work', () => {
    const byKey = new Map(stages.map((s) => [s.key, s]));
    expect(byKey.get('visa_approved')?.is_initial).toBe(true);
    // "enrolled" is no longer the end — the agency relationship (and any PSW
    // commission/upsell) continues to graduation and post-study work.
    expect(byKey.get('enrolled')?.is_terminal).toBe(false);
    for (const k of ['course_completed', 'graduated', 'post_study_work']) {
      expect(byKey.has(k), k).toBe(true);
    }
    expect(byKey.get('post_study_work')?.is_terminal).toBe(true);
  });
});

const countryTemplates: Record<string, Stage[]> = JSON.parse(
  readFileSync(resolve(process.cwd(), 'prisma/data/country-stage-templates.json'), 'utf8'),
);

describe('country stage templates data', () => {
  const COUNTRY_PSW: Record<string, string> = {
    US: 'opt',
    UK: 'graduate_route',
    AU: 'post_study_work_485',
    CA: 'pgwp',
  };

  for (const [country, sts] of Object.entries(countryTemplates)) {
    it(`${country}: well-formed with one terminal + country-specific post-study stage`, () => {
      // Single terminal, contiguous sequence, valid categories.
      expect(sts.filter((s) => s.is_terminal)).toHaveLength(1);
      const seqs = sts.map((s) => s.sequence).sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: sts.length }, (_, i) => i + 1));
      for (const s of sts) expect(VALID_CATEGORIES.has(s.category), s.category).toBe(true);
      const byKey = new Map(sts.map((s) => [s.key, s]));
      // enrolment is no longer terminal; graduation + the destination's PSW route follow.
      expect(byKey.get('enrolled')?.is_terminal).toBe(false);
      expect(byKey.has('graduated')).toBe(true);
      const psw = COUNTRY_PSW[country];
      if (psw) {
        expect(byKey.has(psw), `${country} expects ${psw}`).toBe(true);
        expect(byKey.get(psw)?.is_terminal).toBe(true);
      }
    });
  }
});
