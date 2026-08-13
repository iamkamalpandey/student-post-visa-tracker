// SVT-SEC-2026-08 (T0-7) — REAL-POSTGRES proof that the app can read its OWN
// rows once RLS is actually enforced.
//
// WHY THIS EXISTS, AND WHY IT IS NOT A DUPLICATE OF ITS SIBLING
// -------------------------------------------------------------
// rls-enforcement.integration.spec.ts proves tenant A cannot read tenant B.
// That is one half of tenant isolation. Nothing proved the other half: that the
// application still FUNCTIONS under a de-privileged role. Both halves matter,
// and only the first was ever tested.
//
// The gap let T0-7 ship. Every tenant-scoped table carries
//
//     USING (tenant_id = app_current_tenant())
//
// with no `OR app_current_tenant() IS NULL` branch, and app_current_tenant() is
// NULLIF(current_setting('app.tenant_id', true), '')::uuid — so a connection
// that never set the GUC matches ZERO rows and fails every insert. Six cron
// jobs, the audit writer and a dozen request-path files were in exactly that
// state. None of it was visible, because RLS never applies to superusers and
// dev/CI run a single superuser role: everything worked right up until
// DATABASE_URL pointed at the de-privileged `spv_app` role, which is step 3 of
// the launch runbook. Securing the database was what broke the app.
//
// So this spec connects the REAL application client as a genuinely
// de-privileged role and exercises the REAL helpers (withTenantTx, writeAudit).
// It asserts both directions: the bare client sees nothing (the defect is real
// and still would be), and the scoped path sees its own rows (the fix works).
//
// SKIPS (does not fail) when no database is reachable, so `pnpm test` on a
// laptop without Postgres stays green. CI provides the service, so it runs
// there — and it creates its own de-privileged role, so it needs no new config.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';

const ADMIN_URL = process.env['DATABASE_MIGRATE_URL'] ?? process.env['DATABASE_URL'] ?? '';

const APP_ROLE = 'spv_app_rlsguc';
const APP_PASSWORD = 'rls_guc_test_only';

async function probe(): Promise<boolean> {
  if (!ADMIN_URL) return false;
  const c = new Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
  try {
    await c.connect();
    // Only meaningful if the RLS migrations actually ran (a `prisma db push`
    // database has the tables but none of the raw-SQL policies).
    const r = await c.query(
      `SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='students' LIMIT 1`,
    );
    await c.end();
    return r.rowCount === 1;
  } catch {
    try { await c.end(); } catch { /* already closed */ }
    return false;
  }
}

const ready = await probe();

/** Swap the credentials in the admin URL for the de-privileged role's. */
function deprivilegedUrl(): string {
  const u = new URL(ADMIN_URL);
  u.username = APP_ROLE;
  u.password = APP_PASSWORD;
  return u.toString();
}

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const STUDENT_A = randomUUID();
// audit_logs is deliberately append-only (an audit_logs_immutable() trigger
// rejects DELETE), so probe rows from previous runs are still there and can
// never be cleaned up. Tag each run's actions so the assertions can be exact
// instead of "at least one", which would pass even if nothing was written.
const RUN = randomUUID().slice(0, 8);
const ACTION_TENANT = `rls.guc.probe.${RUN}`;
const ACTION_SYSTEM = `rls.guc.system.probe.${RUN}`;

let admin: Client;
// Imported lazily AFTER DATABASE_URL is repointed, so the app's singleton
// connects as the de-privileged role — the whole point of the exercise.
let prisma: typeof import('../src/config/db.js')['prisma'];
let withTenantTx: typeof import('../src/shared/tenantTx.js')['withTenantTx'];
let writeAudit: typeof import('../src/shared/audit.js')['writeAudit'];

/**
 * Ensure a role RLS genuinely applies to. Postgres ignores every policy for
 * superusers and BYPASSRLS roles, so asserting against the owner would pass
 * vacuously no matter how broken things were.
 *
 * Creating the role needs CREATEROLE, which the connecting account may not
 * have. If it is already present and suitably de-privileged we use it; if we
 * can neither create nor find one, we skip rather than fail — a missing
 * privilege is an environment limitation, not a defect in the code under test.
 */
async function ensureAppRole(c: Client): Promise<boolean> {
  // Deliberately create-or-reuse, never DROP. Dropping needs rights the
  // connecting account may not have (`DROP OWNED BY` requires membership or
  // superuser), and it races the sibling integration spec when both run against
  // the same database — one spec tearing a role down while the other holds
  // connections. The role is an inert fixture; leaving it costs nothing.
  try {
    await c.query(
      `CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
  } catch {
    // Already there, or we lack CREATEROLE. Either way, only proceed if what
    // exists is genuinely de-privileged — asserting against a superuser would
    // pass vacuously no matter how broken the policies were.
    const existing = await c.query(
      `SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = $1`,
      [APP_ROLE],
    );
    const r = existing.rows[0] as
      | { rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }
      | undefined;
    if (!r || r.rolsuper || r.rolbypassrls || !r.rolcanlogin) return false;
    // Re-assert the password so a stale fixture from an older run still logs in.
    await c.query(`ALTER ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'`).catch(() => undefined);
  }
  try {
    await c.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await c.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`,
    );
    await c.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`);
  } catch {
    return false;
  }
  return true;
}

let usable = false;

if (ready) {
  admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  usable = await ensureAppRole(admin);

  if (usable) {
    vi.stubEnv('DATABASE_URL', deprivilegedUrl());
    ({ prisma } = await import('../src/config/db.js'));
    ({ withTenantTx } = await import('../src/shared/tenantTx.js'));
    ({ writeAudit } = await import('../src/shared/audit.js'));
  } else {
    await admin.end().catch(() => undefined);
  }
}

describe.skipIf(!ready || !usable)('T0-7 — the app must still read its own rows under RLS', () => {
  beforeAll(async () => {
    // The migrations apply FORCE ROW LEVEL SECURITY, which makes policies bind
    // the table OWNER as well — normal RLS exempts the owner, FORCE does not.
    // So even this fixture connection has to set the GUC before it can write.
    // (DDL is unaffected, which is why `prisma migrate deploy` runs fine as the
    // owner while its DML would not.)
    for (const t of [TENANT_A, TENANT_B]) {
      await admin.query(`SET app.tenant_id = '${t}'`);
      await admin.query(
        `INSERT INTO tenants (id, name, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (id) DO NOTHING`,
        [t, `rls-guc-${t.slice(0, 8)}`],
      );
    }
    // `countries` is a global reference table (no tenant_id, no RLS) and
    // students.nationality_code FKs into it. Seed the one row we need.
    await admin.query(
      `INSERT INTO countries (code_alpha2, code_alpha3, numeric_code, name, dial_code)
       VALUES ('NP', 'NPL', '524', 'Nepal', '+977') ON CONFLICT DO NOTHING`,
    );

    await admin.query(`SET app.tenant_id = '${TENANT_A}'`);
    const stage = randomUUID();
    await admin.query(
      `INSERT INTO lifecycle_stages (id, tenant_id, key, label, sequence, updated_at)
       VALUES ($1, $2, 'rls_guc_probe', 'RLS GUC probe', 999, now())
       ON CONFLICT DO NOTHING`,
      [stage, TENANT_A],
    );
    await admin.query(
      `INSERT INTO students
         (id, tenant_id, student_code, given_name, family_name,
          name_in_passport_enc, date_of_birth, nationality_code,
          current_stage_id, updated_at)
       VALUES ($1, $2, 'RLSGUC-1', 'Guc', 'Test', '\\x00'::bytea,
               '2000-01-01', 'NP', $3, now())
       ON CONFLICT (id) DO NOTHING`,
      [STUDENT_A, TENANT_A, stage],
    );
  });

  afterAll(async () => {
    if (!ready || !usable) return;
    await prisma.$disconnect().catch(() => undefined);
    // FORCE RLS binds the owner too, so cleanup needs the GUC per tenant.
    // audit_logs is intentionally omitted: an audit_logs_immutable() trigger
    // rejects DELETE, which is exactly the property an append-only audit trail
    // should have. The run-tagged action names keep the assertions exact.
    for (const t of [TENANT_A, TENANT_B]) {
      await admin.query(`SET app.tenant_id = '${t}'`).catch(() => undefined);
      await admin.query(`DELETE FROM students WHERE tenant_id = $1`, [t]).catch(() => undefined);
      await admin.query(`DELETE FROM lifecycle_stages WHERE tenant_id = $1`, [t]).catch(() => undefined);
      await admin.query(`DELETE FROM tenants WHERE id = $1`, [t]).catch(() => undefined);
    }
    await admin.end().catch(() => undefined);
  });

  it('runs as a role RLS actually applies to (otherwise every assertion is vacuous)', async () => {
    const rows = await prisma.$queryRaw<Array<{ rolsuper: boolean; rolbypassrls: boolean }>>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
    `;
    expect(rows[0]?.rolsuper).toBe(false);
    expect(rows[0]?.rolbypassrls).toBe(false);
  });

  // ---- the defect ----------------------------------------------------------

  it('THE DEFECT: the bare singleton, with no tenant GUC, sees zero rows', async () => {
    // This is what six cron jobs, the audit writer and a dozen request-path
    // files were doing. It does not throw. It does not warn. It returns [].
    const rows = await prisma.student.findMany({ where: { tenant_id: TENANT_A } });
    expect(rows).toHaveLength(0);
  });

  it('THE DEFECT: an explicit tenant_id filter does NOT rescue it', async () => {
    // Worth pinning, because "but every query filters by tenant_id" was the
    // reasoning in the comment that made billingDaily look safe. The policy is
    // evaluated independently of the WHERE clause.
    const count = await prisma.student.count({ where: { tenant_id: TENANT_A } });
    expect(count).toBe(0);
  });

  it('THE DEFECT: an insert with no GUC is rejected outright', async () => {
    await expect(
      prisma.tenant.create({
        data: { id: randomUUID(), name: 'should-not-land', updated_at: new Date() },
      }),
    ).rejects.toThrow();
  });

  // ---- the fix -------------------------------------------------------------

  it('THE FIX: withTenantTx sees the tenant’s own rows', async () => {
    const rows = await withTenantTx(TENANT_A, (tx) =>
      tx.student.findMany({ where: { tenant_id: TENANT_A } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(STUDENT_A);
  });

  it('THE FIX: withTenantTx still cannot reach another tenant', async () => {
    // The fix must not have bought functionality back by weakening isolation.
    const rows = await withTenantTx(TENANT_B, (tx) =>
      tx.student.findMany({ where: { tenant_id: TENANT_A } }),
    );
    expect(rows).toHaveLength(0);
  });

  it('THE FIX: writeAudit actually persists a tenant-scoped row', async () => {
    // audit_logs is `tenant_id = app_current_tenant() OR tenant_id IS NULL`, so
    // a tenant row failed the WITH CHECK on the GUC-less client — and writeAudit
    // swallows its own errors by design, so the tamper-evident chain this
    // product sells as forensic integrity would have recorded nothing but
    // system rows, silently, forever.
    await writeAudit({
      tenantId: TENANT_A,
      action: ACTION_TENANT,
      entityType: 'student',
      entityId: STUDENT_A,
    } as never);

    const r = await admin.query(
      `SELECT id FROM audit_logs WHERE tenant_id = $1 AND action = $2`,
      [TENANT_A, ACTION_TENANT],
    );
    expect(r.rowCount).toBe(1);
  });

  it('THE FIX: a system audit row (tenant_id NULL) still lands via the NULL branch', async () => {
    await writeAudit({
      tenantId: null,
      action: ACTION_SYSTEM,
      entityType: 'job',
    } as never);

    const r = await admin.query(
      `SELECT id FROM audit_logs WHERE tenant_id IS NULL AND action = $1`,
      [ACTION_SYSTEM],
    );
    expect(r.rowCount).toBe(1);
  });
});
