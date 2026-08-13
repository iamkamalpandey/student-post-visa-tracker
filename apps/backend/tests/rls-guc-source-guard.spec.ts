// SVT-SEC-2026-08 (T0-7) — source guard: no background job may read or write a
// tenant-scoped table through the bare `prisma` singleton.
//
// WHY THIS TEST EXISTS
// --------------------
// Every tenant-scoped table carries
//
//   USING/WITH CHECK (tenant_id = app_current_tenant())
//
// with no `OR app_current_tenant() IS NULL` branch — 20991231235983 stripped it
// and 20991231236005 re-closed the three migrations that had re-opened it.
// `app_current_tenant()` is NULLIF(current_setting('app.tenant_id', true), '')
// cast to uuid, so a connection that never set the GUC matches ZERO rows and
// fails every insert.
//
// That is the intended fail-safe. The problem is that it is completely silent:
// a job whose scan returns nothing does not throw, does not warn, and reports a
// clean run with zero counters. Six jobs were in exactly that state, including
// the entire receivables pipeline, and no test caught it because RLS does not
// apply to superusers — dev and CI both run a single-role database, so
// everything works right up until DATABASE_URL points at the de-privileged
// `spv_app` role. The act of correctly securing the database is what breaks the
// billing engine.
//
// rls-enforcement.integration.spec.ts proves tenant A cannot read tenant B.
// Nothing proved the app can still read its OWN rows once RLS is real. This
// closes that gap without needing a database, so it runs everywhere.
//
// WHAT COUNTS AS SAFE
//   * `withTenantTx(tenantId, tx => …)` — sets the GUC, then runs the workload.
//   * an explicit `set_config('app.tenant_id', …)` inside the job's own tx.
//   * `prismaAdmin` — BYPASSRLS, for reads that are inherently cross-tenant
//     (enumerating tenants). Deliberate and greppable, which is the point.
//
// Adding a job that touches tenant data through `prisma` will fail here with the
// file name and the delegate, rather than shipping a cron that silently does
// nothing for as long as nobody checks the counters.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const JOBS_DIR = join(process.cwd(), 'src', 'jobs');

/**
 * Infrastructure jobs that operate on rows with no tenant dimension, or on
 * tables deliberately excluded from tenant isolation. Each entry names the
 * exact delegates it may use and why — an allowlist that just says "this file
 * is fine" is how a guard like this rots into a rubber stamp.
 */
const ALLOWED: Record<string, { why: string; delegates: string[] }> = {
  'runner.ts': {
    why: 'writes job_runs, which has no tenant_id — it records the run, not a tenant’s data.',
    delegates: ['jobRun'],
  },
  'scheduler.ts': {
    why: 'reads job_schedules (global) and dispatches; it touches no tenant rows itself.',
    delegates: ['jobSchedule'],
  },
  'lock.ts': {
    why: 'pg_advisory_lock only — no table access at all.',
    delegates: [],
  },
  'hashAnchor.ts': {
    why:
      'audit_anchors and audit_logs both carry the `tenant_id IS NULL` branch for global rows ' +
      '(20991231235983 kept it deliberately), and the anchor it writes is a global row.',
    delegates: ['auditAnchor', 'auditLog'],
  },
};

/** Prisma delegates that are NOT tenant-scoped and are safe on the singleton. */
const TENANTLESS_DELEGATES = new Set([
  'jobRun',
  'jobSchedule',
  'tenant', // enumerating tenants is the cross-tenant case; flagged separately below
]);

function jobFiles(): string[] {
  return readdirSync(JOBS_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
}

/**
 * Strip comments before scanning. Without this the guard reports prose: a
 * comment reading "the shape we hand to prisma.reminder.createMany" is not a
 * query, and a guard that cries wolf gets muted.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** `prisma.<delegate>.` occurrences, ignoring `prismaAdmin.`. */
function bareSingletonDelegates(src: string): string[] {
  const hits: string[] = [];
  const re = /(?<![A-Za-z])prisma\.([a-zA-Z][a-zA-Z0-9]*)\./g;
  let m: RegExpExecArray | null;
  const code = stripComments(src);
  while ((m = re.exec(code)) !== null) {
    hits.push(m[1]!);
  }
  return hits;
}

describe('T0-7 — jobs must not touch tenant tables on the GUC-less singleton', () => {
  const files = jobFiles();

  it('finds the jobs directory', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of files) {
    const allowed = ALLOWED[file];
    it(`${file}${allowed ? ' (allowed)' : ''}`, () => {
      const src = readFileSync(join(JOBS_DIR, file), 'utf8');
      let delegates = [...new Set(bareSingletonDelegates(src))].filter(
        (d) => !TENANTLESS_DELEGATES.has(d),
      );

      if (allowed) {
        // Allowlisted files may use exactly the delegates they declare — and
        // nothing more. Growing a new one has to be argued for here first.
        delegates = delegates.filter((d) => !allowed.delegates.includes(d));
        expect(
          delegates,
          `${file} is allowlisted (${allowed.why}) but now reaches undeclared tenant-scoped delegates: ${delegates.join(', ')}`,
        ).toEqual([]);
        return;
      }

      expect(
        delegates,
        `${file} uses the bare \`prisma\` singleton for ${delegates.join(', ')}. ` +
          'Under the production `spv_app` role those queries match zero rows and the job ' +
          'silently does nothing. Wrap the work in withTenantTx(tenantId, tx => …), or use ' +
          'prismaAdmin if the read is genuinely cross-tenant.',
      ).toEqual([]);
    });
  }
});

// The same defect class outside src/jobs. These files were verified by hand and
// converted; the assertions below stop them drifting back.
//
// Not yet swept, and deliberately not asserted here so this guard stays honest
// about what it covers: exports.service.ts, imports.service.ts, and a handful of
// single-call sites (comms webhooks/unsubscribe routes, billing/middleware.ts,
// dsar/controller.ts, interview-prep/controller.ts, jobs/service.ts,
// requireMfa.ts). Tracked in the register under T0-7.
describe('T0-7 — converted request-path files must not regress', () => {
  const CONVERTED: Array<{ file: string; why: string }> = [
    {
      file: 'src/middlewares/auth.ts',
      why:
        'ownership gates read students/crm_leads/18 child tables; on the GUC-less ' +
        'singleton they returned null, which the call sites treat as "not authorised" — ' +
        'failing closed, but 403ing every COUNSELLOR out of every child resource. ' +
        'prismaAdmin remains correct for the auth primitives (denylist, idle bump).',
    },
    {
      file: 'src/modules/users/users.service.ts',
      why: 'every method but list() used the singleton; user administration did not work at all.',
    },
    {
      file: 'src/modules/users/users.controller.ts',
      why: 'the actor MFA lookup used the singleton, silently blocking every role change.',
    },
    {
      file: 'src/modules/auth/mfa.service.ts',
      why: 'auth-domain primitives keyed by the session user id; converted to the adminDb idiom auth.service.ts already uses.',
    },
  ];

  for (const { file, why } of CONVERTED) {
    it(file, () => {
      const src = readFileSync(join(process.cwd(), file), 'utf8');
      const delegates = [...new Set(bareSingletonDelegates(src))];
      expect(
        delegates,
        `${file} reaches the bare \`prisma\` singleton again (${delegates.join(', ')}). ` +
          `It was converted because: ${why}`,
      ).toEqual([]);
    });
  }
});

describe('T0-7 — the audit writer must scope its own transaction', () => {
  it('shared/audit.ts routes tenant-scoped rows through withTenantTx', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'shared', 'audit.ts'), 'utf8');
    // audit_logs allows `tenant_id IS NULL` (system rows) but a tenant-scoped
    // row still has to satisfy `tenant_id = app_current_tenant()`. Without the
    // GUC every such insert failed the WITH CHECK — and writeAudit swallows its
    // own errors by design, so the tamper-evident chain would have recorded
    // nothing but system rows, silently, forever.
    expect(src).toContain('withTenantTx(');
  });
});
