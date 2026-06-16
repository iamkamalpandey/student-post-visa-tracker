// SVT-V2-CRM-MIRROR-2026-06 — read the V2 MIS CRM, scoped to visa-accepted
// leads. One READ ONLY pass returns a structured dump the ingest upserts.
//
// Scope rule: a lead is in scope if it has >=1 LeadCourses row at
// stateV2='visa_accepted' (not deleted). For those leads we mirror the FULL
// person record (every application/course/history/payment/activity/profile),
// not just the visa-accepted course — that is what "mirror the lead" means.
//
// V2 uses default Prisma naming: quoted PascalCase tables, camelCase columns.

import { assertV2ReadOnly, getV2Pool } from './pool.js';
import type {
  V2Application,
  V2Assignment,
  V2Call,
  V2Country,
  V2Course,
  V2CrmDump,
  V2FollowUp,
  V2Guardian,
  V2History,
  V2Institution,
  V2LanguageTest,
  V2Lead,
  V2LeadCourse,
  V2Payment,
  V2Qualification,
  V2Remark,
  V2Visit,
} from './types.js';

function uniqNums(values: Array<number | null | undefined>): number[] {
  const set = new Set<number>();
  for (const v of values) if (typeof v === 'number') set.add(v);
  return [...set];
}

function emptyDump(): V2CrmDump {
  return {
    countries: [], institutions: [], courses: [], leads: [], applications: [],
    leadCourses: [], history: [], payments: [], remarks: [], followUps: [],
    calls: [], visits: [], assignments: [], qualifications: [], languageTests: [],
    guardians: [],
  };
}

export async function fetchV2Crm(): Promise<V2CrmDump> {
  const pool = getV2Pool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');

    // SVT-SEC-2026-06 — verify the role is read-only (catalog reads only, once
    // per process). Surfaces a superuser/write-capable credential loudly.
    await assertV2ReadOnly(client);

    const q = async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
      (await client.query(sql, params)).rows as T[];

    // 1. Scope: visa-accepted lead ids. The funnel state lives on LeadCourses,
    //    which dual-writes TWO columns that DRIFT:
    //      - `state`   = legacy free-text ("Visa Accepted") — what the V2
    //                    Applications admin page counts (~301). Well populated.
    //      - `stateV2` = typed enum ('visa_accepted') — sparsely backfilled
    //                    (~88 leads), so it UNDER-counts on its own.
    //    (NB: Application.state is a lifecycle field — ACTIVE/completed — NOT the
    //    visa funnel, so it must NOT be used here.) Union both LeadCourses
    //    columns so SPVT mirrors the same visa-accepted population V2 reports.
    const scope = await q<{ leadId: number }>(
      `SELECT "leadId" FROM "LeadCourses"
        WHERE "isDeleted" = false
          AND ("stateV2" = 'visa_accepted' OR state ILIKE '%visa%accept%')`,
    );
    const leadIds = scope.map((r) => r.leadId);
    if (leadIds.length === 0) {
      await client.query('COMMIT');
      return emptyDump();
    }

    // 2. Person + funnel + activity + profile (all scoped to the leads).
    const leads = await q<V2Lead>(`SELECT * FROM "Lead" WHERE id = ANY($1::int[])`, [leadIds]);
    const applications = await q<V2Application>(
      `SELECT * FROM "Application" WHERE "leadId" = ANY($1::int[]) AND "deletedAt" IS NULL`, [leadIds]);
    const leadCourses = await q<V2LeadCourse>(`SELECT * FROM "LeadCourses" WHERE "leadId" = ANY($1::int[])`, [leadIds]);
    const history = await q<V2History>(`SELECT * FROM "LeadCourseStateHistory" WHERE "leadId" = ANY($1::int[])`, [leadIds]);
    const remarks = await q<V2Remark>(`SELECT * FROM "Remark" WHERE "leadId" = ANY($1::int[])`, [leadIds]);
    const followUps = await q<V2FollowUp>(`SELECT * FROM "FollowUpDate" WHERE "leadId" = ANY($1::int[])`, [leadIds]);
    const calls = await q<V2Call>(`SELECT * FROM "CallHistory" WHERE "leadId" = ANY($1::int[])`, [leadIds]);
    const visits = await q<V2Visit>(`SELECT * FROM "VisitHistory" WHERE "leadId" = ANY($1::int[])`, [leadIds]);
    const qualifications = await q<V2Qualification>(`SELECT * FROM "Qualification" WHERE "leadId" = ANY($1::int[])`, [leadIds]);
    const languageTests = await q<V2LanguageTest>(`SELECT * FROM "LanguageTestResult" WHERE "leadId" = ANY($1::int[])`, [leadIds]);
    const guardians = await q<V2Guardian>(`SELECT * FROM "Guardian" WHERE "leadId" = ANY($1::int[])`, [leadIds]);

    // 3. Assignments — unify AssignedUser + Follower with a `kind` tag.
    const assignedRows = await q<Omit<V2Assignment, 'kind'>>(`SELECT * FROM "AssignedUser" WHERE "leadId" = ANY($1::int[])`, [leadIds]);
    const followerRows = await q<Omit<V2Assignment, 'kind'>>(`SELECT * FROM "Follower" WHERE "leadId" = ANY($1::int[])`, [leadIds]);
    const assignments: V2Assignment[] = [
      ...assignedRows.map((r) => ({ ...r, kind: 'ASSIGNEE' as const })),
      ...followerRows.map((r) => ({ ...r, kind: 'FOLLOWER' as const })),
    ];

    // 4. Finance — payments link to lead via Student.leadId.
    const payments = await q<V2Payment>(
      `SELECT p.*, s."leadId" AS lead_v2_id
         FROM "Payment" p JOIN "Student" s ON s."id" = p."studentId"
        WHERE s."leadId" = ANY($1::int[])`, [leadIds]);

    // 5. Catalog — only the courses/institutions/countries referenced.
    const courseIds = uniqNums([
      ...applications.map((a) => a.courseId),
      ...leadCourses.map((lc) => lc.courseId),
    ]);
    const courses = courseIds.length
      ? await q<V2Course>(`SELECT * FROM "Course" WHERE id = ANY($1::int[])`, [courseIds]) : [];
    const institutionIds = uniqNums(courses.map((c) => c.institutionId));
    const institutions = institutionIds.length
      ? await q<V2Institution>(`SELECT * FROM "Institution" WHERE id = ANY($1::int[])`, [institutionIds]) : [];
    const countryIds = uniqNums(institutions.map((i) => i.countryId));
    const countries = countryIds.length
      ? await q<V2Country>(`SELECT * FROM "Country" WHERE id = ANY($1::int[])`, [countryIds]) : [];

    await client.query('COMMIT');
    return {
      countries, institutions, courses, leads, applications, leadCourses, history,
      payments, remarks, followUps, calls, visits, assignments, qualifications,
      languageTests, guardians,
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* connection already broken */ }
    throw err;
  } finally {
    client.release();
  }
}
