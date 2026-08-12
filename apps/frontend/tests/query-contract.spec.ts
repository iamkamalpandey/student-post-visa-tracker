// SVT-CONTRACT-2026-08 — the params the frontend sends must be accepted by the
// zod schema the backend validates with.
//
// This bug class has now bitten three times in this codebase:
//
//   1. Reminders — the tab sent `q` and `page`; ReminderListQuery is .strict()
//      and declared neither, so every keystroke in the search box was a 422.
//      Nobody noticed because the tab also filters client-side over the rows
//      already loaded, so search *appeared* to work while only ever covering
//      the current page.
//   2. The commissions summary strip read `totals` / `buckets`, which the API
//      has never sent, so all four cards rendered "—" permanently.
//   3. Three pickers requested `limit: 200` against a schema capping it at 100,
//      so they 400'd and stayed empty — one dialog could not be completed.
//
// Every one of those is a silent failure: the UI renders, the user acts, and
// the request dies somewhere they cannot see. A type check cannot catch it
// because the params cross the wire as plain JSON.
//
// These tests run the REAL frontend param builders through the REAL backend
// schemas, so drift fails in CI instead of in production.

import { describe, it, expect } from 'vitest';
import {
  ReminderListQuery,
  StudentListQuery,
  InstitutionListQuery,
  PaginationQuery,
} from '@spv/zod-schemas';
import { buildReminderParams } from '@/lib/queries';

/**
 * Query params arrive at the server as strings. Mirror that so a schema which
 * only accepts a real number (rather than z.coerce.number) is caught here
 * rather than at runtime.
 */
function asWireParams(params: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    out[k] = String(v);
  }
  return out;
}

describe('reminders — every param the Reminders tab sends is accepted', () => {
  it('accepts the full filter set the tab builds', () => {
    // Exactly what RemindersTab passes into useReminders.
    const params = buildReminderParams({
      q: 'passport',
      status: 'PENDING',
      type: 'VISA_EXPIRY',
      assigned_to_id: '11111111-1111-7111-8111-111111111111',
      student_id: '22222222-2222-7222-8222-222222222222',
      due_from: '2026-01-01',
      due_to: '2026-12-31',
      limit: 25,
      page: 2,
    } as never);

    const parsed = ReminderListQuery.safeParse(asWireParams(params));
    expect(parsed.success).toBe(true);
  });

  it('accepts a free-text search — the case that used to 422 on every keystroke', () => {
    const params = buildReminderParams({ q: 'Sharma' } as never);
    expect(params['q']).toBe('Sharma');
    expect(ReminderListQuery.safeParse(asWireParams(params)).success).toBe(true);
  });

  it('accepts a page number — the numbered pager the tab renders', () => {
    const params = buildReminderParams({ page: 3 } as never);
    expect(params['page']).toBe(3);
    expect(ReminderListQuery.safeParse(asWireParams(params)).success).toBe(true);
  });

  it('omits blank and "all" filters instead of sending empties', () => {
    const params = buildReminderParams({ q: '   ', status: 'all', type: 'all' } as never);
    expect(params).toEqual({});
    expect(ReminderListQuery.safeParse({}).success).toBe(true);
  });

  it('still rejects a param nobody declared, so the schema keeps its teeth', () => {
    // .strict() is what makes this whole class of bug detectable at all — if
    // this ever passes, the schemas have stopped guarding the contract.
    const parsed = ReminderListQuery.safeParse({ definitely_not_a_field: 'x' });
    expect(parsed.success).toBe(false);
  });
});

describe('list limits — callers must respect the shared pagination cap', () => {
  // PaginationQuery caps `limit` at 100. Three dialogs asked for 200 and got a
  // 400, leaving their pickers permanently empty.
  const MAX_LIMIT = 100;

  it('accepts the maximum the schema allows', () => {
    expect(PaginationQuery.safeParse({ limit: String(MAX_LIMIT) }).success).toBe(true);
  });

  it('rejects the over-cap value that broke the pickers', () => {
    expect(PaginationQuery.safeParse({ limit: '200' }).success).toBe(false);
  });

  it.each([
    ['students', StudentListQuery],
    ['institutions', InstitutionListQuery],
    ['reminders', ReminderListQuery],
  ])('%s list query rejects limit above the cap', (_name, schema) => {
    expect(schema.safeParse({ limit: '200' }).success).toBe(false);
    expect(schema.safeParse({ limit: '100' }).success).toBe(true);
  });
});

describe('students — the filters the list screen and the CSV export both send', () => {
  // These are the params app/(app)/students/Client.tsx puts on the wire. The
  // export used to discard all but `status`, which is why a filtered export
  // returned the entire tenant.
  it('accepts the full filter set', () => {
    const parsed = StudentListQuery.safeParse(
      asWireParams({
        search: 'Gurung',
        stage_id: '33333333-3333-7333-8333-333333333333',
        status: 'ACTIVE',
        sla_breached: true,
        limit: 25,
      }),
    );
    expect(parsed.success).toBe(true);
  });

  // SVT-UX-2026-08 — the list screen now pages with a keyset cursor. Before
  // this it sent only `{limit}` and rendered the server's response unsliced,
  // so "next page" relabelled the footer and showed the SAME rows — student 26
  // was unreachable on the flagship table. If `cursor` were ever dropped from
  // StudentListQuery (which is .strict()) paging would 422 on every click, so
  // it is pinned here alongside the filters.
  it('accepts a cursor, so keyset paging is not a 422', () => {
    const parsed = StudentListQuery.safeParse(
      asWireParams({ limit: 25, cursor: '33333333-3333-7333-8333-333333333333' }),
    );
    expect(parsed.success).toBe(true);
  });

  it('accepts a cursor combined with the filters, which is the real paging call', () => {
    const parsed = StudentListQuery.safeParse(
      asWireParams({
        search: 'Gurung',
        stage_id: '33333333-3333-7333-8333-333333333333',
        status: 'ACTIVE',
        sla_breached: true,
        limit: 50,
        cursor: '44444444-4444-7444-8444-444444444444',
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it('still rejects an offset-style `page` param — the API has no offset', () => {
    // Guards against someone "restoring" the numeric pager. StudentListQuery is
    // .strict(), so this must fail rather than be silently ignored.
    expect(StudentListQuery.safeParse(asWireParams({ limit: 25, page: 3 })).success).toBe(false);
  });
});
