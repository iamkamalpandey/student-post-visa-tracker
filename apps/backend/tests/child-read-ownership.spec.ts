// SVT-AUDIT-IDOR-2026-06 — regression coverage for the cross-counsellor IDOR
// fix (audit backlog rank 2). Student child-resource READ routes (flat GET /:id
// and the nested per-student list GET /) must carry the SAME ownership guard
// their write siblings already had, so a COUNSELLOR cannot read another
// counsellor's students' PII by enumerating UUIDs.
//
// Two layers of coverage:
//   1. Behavioural — exercise requireStudentOwnershipViaChild through a real
//      express stack with a mocked prisma: owner→200, non-owner→403, admin→200,
//      missing-row→403.
//   2. Wiring guard — assert every child module's routes.ts keeps the guard on
//      its read routes, so a future edit can't silently drop it.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3001');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const TENANT = '11111111-1111-7111-8111-111111111111';
const OWNER = '22222222-2222-7222-8222-222222222222';
const OTHER = '33333333-3333-7333-8333-333333333333';
const ADMIN = '44444444-4444-7444-8444-444444444444';
const STUDENT = '55555555-5555-7555-8555-555555555555';
const CONTACT = '66666666-6666-7666-8666-666666666666';

// Mocked prisma: only the two delegates requireStudentOwnershipViaChild('contact')
// touches — the child resolver (studentContact.findFirst) and the ownership
// assertion (student.findFirst).
const studentContact = { findFirst: vi.fn() };
const student = { findFirst: vi.fn() };
vi.mock('../src/config/db.js', () => ({
  prisma: { studentContact, student },
  disconnectDb: async () => undefined,
}));

const { requireStudentOwnershipViaChild } = await import('../src/middlewares/auth.js');
const express = (await import('express')).default;
const request = (await import('supertest')).default;

type Role = 'ADMIN' | 'COUNSELLOR' | 'VIEWER';
function appAs(role: Role, sub: string) {
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = { sub, tid: TENANT, role };
    next();
  });
  app.get(
    '/contacts/:id',
    requireStudentOwnershipViaChild('contact', 'id'),
    (_req, res) => res.json({ ok: true }),
  );
  // Minimal error handler mirroring the app's status-aware shape.
  app.use((err: { status?: number; message?: string }, _req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }, _next: unknown) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });
  return app;
}

beforeEach(() => {
  studentContact.findFirst.mockReset();
  student.findFirst.mockReset();
});

describe('requireStudentOwnershipViaChild — child read access control', () => {
  it('owner COUNSELLOR reading their own student’s child row → 200', async () => {
    studentContact.findFirst.mockResolvedValue({ student_id: STUDENT });
    student.findFirst.mockResolvedValue({ assigned_to_id: OWNER });
    const res = await request(appAs('COUNSELLOR', OWNER)).get(`/contacts/${CONTACT}`);
    expect(res.status).toBe(200);
  });

  it('non-owner COUNSELLOR reading another counsellor’s student child row → 403', async () => {
    studentContact.findFirst.mockResolvedValue({ student_id: STUDENT });
    student.findFirst.mockResolvedValue({ assigned_to_id: OWNER }); // owned by someone else
    const res = await request(appAs('COUNSELLOR', OTHER)).get(`/contacts/${CONTACT}`);
    expect(res.status).toBe(403);
  });

  it('ADMIN reads any child row → 200 (ownership short-circuit, no resolver call)', async () => {
    const res = await request(appAs('ADMIN', ADMIN)).get(`/contacts/${CONTACT}`);
    expect(res.status).toBe(200);
    expect(studentContact.findFirst).not.toHaveBeenCalled();
  });

  it('missing / cross-tenant child row → 403 (no leak)', async () => {
    studentContact.findFirst.mockResolvedValue(null);
    const res = await request(appAs('COUNSELLOR', OTHER)).get(`/contacts/${CONTACT}`);
    expect(res.status).toBe(403);
  });

  it('child row whose parent student is gone → 403', async () => {
    studentContact.findFirst.mockResolvedValue({ student_id: STUDENT });
    student.findFirst.mockResolvedValue(null);
    const res = await request(appAs('COUNSELLOR', OWNER)).get(`/contacts/${CONTACT}`);
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Wiring guard: every child module must keep the ownership guard on its read
// routes. Keyed by module dir → resolver key used in CHILD_STUDENT_RESOLVERS.
// ---------------------------------------------------------------------------
const CHILD_MODULES: Record<string, string> = {
  contacts: 'contact',
  identifications: 'identification',
  finance: 'finance',
  visas: 'visa',
  dependents: 'dependent',
  insurance: 'insurance',
  qualifications: 'qualification',
  'language-tests': 'languageTest',
  compliance: 'compliance',
  engagement: 'engagement',
  employment: 'employment',
  accommodation: 'accommodation',
  travel: 'travel',
  'regulator-ids': 'regulatorId',
};

describe('child read routes keep their ownership guard (wiring guard)', () => {
  for (const [mod, key] of Object.entries(CHILD_MODULES)) {
    it(`${mod}: flat GET /:id + nested list are ownership-gated`, () => {
      const src = readFileSync(
        join(process.cwd(), 'src', 'modules', mod, 'routes.ts'),
        'utf8',
      );
      // Every flat read carries the child ownership guard with the right key.
      const flatGet = src.split('\n').find((l) => /Router\.get\('\/:id'/.test(l));
      expect(flatGet, `${mod} flat GET /:id route`).toBeDefined();
      expect(flatGet!).toContain(`requireStudentOwnershipViaChild('${key}', 'id')`);
      // The nested per-student list carries the parent ownership guard.
      const nestedList = src
        .split('\n')
        .find((l) => /StudentRouter\.get\('\/'/.test(l));
      expect(nestedList, `${mod} nested list GET /`).toBeDefined();
      expect(nestedList!).toContain("requireStudentOwnership('studentId')");
    });
  }

  it('sponsorships: flat student-sponsorship link GET /:id is ownership-gated', () => {
    const src = readFileSync(
      join(process.cwd(), 'src', 'modules', 'sponsorships', 'routes.ts'),
      'utf8',
    );
    const flatGet = src
      .split('\n')
      .find((l) => /sponsorshipRouter\.get\('\/:id'/.test(l));
    expect(flatGet).toBeDefined();
    expect(flatGet!).toContain("requireStudentOwnershipViaChild('sponsorship', 'id')");
  });

  // SVT-RBAC-OWN-2026-06 — checklist + enrollments use bespoke router names
  // (studentChecklistProgressRouter / studentEnrollmentsRouter) that the generic
  // `StudentRouter.get('/')` regex above never matched, which is exactly how the
  // read IDOR on these two slipped past the wiring guard. Pin them explicitly.
  it('checklist student-progress GET / is ownership-gated', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'modules', 'checklist', 'routes.ts'), 'utf8');
    const idx = src.indexOf('studentChecklistProgressRouter.get(');
    expect(idx, 'studentChecklistProgressRouter.get route').toBeGreaterThan(-1);
    expect(src.slice(idx, idx + 220)).toContain("requireStudentOwnership('studentId')");
  });

  it('checklist student-progress POST / is ownership-gated', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'modules', 'checklist', 'routes.ts'), 'utf8');
    const idx = src.indexOf('studentChecklistProgressRouter.post(');
    expect(idx, 'studentChecklistProgressRouter.post route').toBeGreaterThan(-1);
    expect(src.slice(idx, idx + 260)).toContain("requireStudentOwnership('studentId')");
  });

  it('enrollments student-nested list GET / is ownership-gated', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'modules', 'enrollments', 'enrollments.routes.ts'), 'utf8');
    const idx = src.indexOf('studentEnrollmentsRouter.get(');
    expect(idx, 'studentEnrollmentsRouter.get route').toBeGreaterThan(-1);
    // Window spans the route block (the guard may sit a few comment lines in).
    expect(src.slice(idx, idx + 500)).toContain("requireStudentOwnership('studentId')");
  });
});
