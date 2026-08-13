// SVT-QA-2026-08 — REAL-POSTGRES tenant-isolation proof.
//
// Everything else in this suite mocks Prisma, which means the single most
// important security property in the product — that tenant A can never read
// tenant B's rows — has never actually been executed against a database. The
// RLS policies live in raw-SQL migrations that `prisma db push` skips, so even
// the dev database usually lacks them. A regression here (a dropped policy, a
// re-introduced `OR app_current_tenant() IS NULL` escape hatch, a table added
// without RLS) would pass every existing test and ship silently.
//
// This test connects to a real Postgres, applies the migrations, and asserts
// isolation from the perspective of a genuinely de-privileged role.
//
// WHY A SEPARATE ROLE: Postgres does NOT apply RLS to superusers or to roles
// with BYPASSRLS. CI connects as the database owner, so asserting isolation on
// that connection would pass vacuously no matter how broken the policies are.
// The test therefore creates `spv_app_rlstest` (NOSUPERUSER NOBYPASSRLS),
// grants it exactly what the runtime role gets, and does every assertion
// through it. That mirrors the production `spv_app` role the app is meant to
// run as.
//
// SKIPS (does not fail) when no database is reachable, so `pnpm test` on a
// laptop without Docker stays green. CI provides the service, so it runs there.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';

const ADMIN_URL =
  process.env['DATABASE_MIGRATE_URL'] ??
  process.env['DATABASE_URL'] ??
  '';

const TEST_ROLE = 'spv_app_rlstest';
const TEST_ROLE_PASSWORD = 'rls_test_only_password';

/** Can we reach a database at all? Decides run-vs-skip. */
async function probeDb(): Promise<boolean> {
  if (!ADMIN_URL) return false;
  const c = new Client({ connectionString: ADMIN_URL, connectionTimeoutMillis: 3000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    try { await c.end(); } catch { /* already closed */ }
    return false;
  }
}

const dbReachable = await probeDb();

/** Does the schema actually carry the RLS policies (i.e. were migrations applied)? */
async function policiesPresent(admin: Client): Promise<boolean> {
  const r = await admin.query(
    `SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'students' LIMIT 1`,
  );
  return r.rowCount === 1;
}

function roleUrl(): string {
  const u = new URL(ADMIN_URL);
  u.username = TEST_ROLE;
  u.password = TEST_ROLE_PASSWORD;
  return u.toString();
}

describe.skipIf(!dbReachable)('RLS tenant isolation (real Postgres)', () => {
  let admin: Client;
  let app: Client;
  let ready = false;

  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const stageA = randomUUID();
  const stageB = randomUUID();
  const studentA = randomUUID();
  const studentB = randomUUID();

  /**
   * Read as the admin connection, scoped to a tenant.
   *
   * SVT-SEC-2026-08 — FORCE ROW LEVEL SECURITY binds the table owner too, so
   * even these verification reads need the GUC. Without it the admin sees zero
   * rows and an assertion like `check.rows[0].given_name` throws — which looks
   * like an isolation failure when it is really the fixture being unable to
   * look.
   */
  async function adminRead(tid: string, sql: string, params: unknown[]) {
    await admin.query(`SET app.tenant_id = '${tid}'`);
    try {
      return await admin.query(sql, params);
    } finally {
      await admin.query(`RESET app.tenant_id`).catch(() => undefined);
    }
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect();

    if (!(await policiesPresent(admin))) {
      // Migrations were not applied to this database. Fail LOUDLY rather than
      // skip: a CI run that silently stops testing isolation is exactly the
      // false-confidence this file exists to prevent.
      throw new Error(
        'RLS policies absent on public.students — run `prisma migrate deploy` before this suite. ' +
          '`prisma db push` does NOT apply the raw-SQL migrations that create the policies.',
      );
    }

    // De-privileged role, created-or-reused.
    //
    // SVT-SEC-2026-08 — this used to REASSIGN OWNED / DROP OWNED / DROP ROLE
    // first. That needs role-management rights the connecting account often
    // does not have: the launch runbook prescribes DATABASE_MIGRATE_URL = the
    // *owner* role (`spv`), not a superuser, and an owner cannot DROP OWNED BY
    // another role. So this suite failed — loudly, but for an environment
    // reason — in exactly the configuration the project tells you to run. It
    // also raced the sibling rls-tenant-guc spec when both ran against one
    // database, one tearing a role down while the other held connections.
    //
    // The role carries no state worth resetting; the assertions below own their
    // fixtures. Create it if absent, otherwise reuse it — but only after
    // confirming what exists is genuinely de-privileged, because asserting
    // isolation through a superuser would pass no matter how broken RLS was.
    const created = await admin
      .query(
        `CREATE ROLE ${TEST_ROLE} LOGIN PASSWORD '${TEST_ROLE_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
      )
      .then(() => true)
      .catch(() => false);
    if (!created) {
      const r = await admin.query(
        `SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = $1`,
        [TEST_ROLE],
      );
      const row = r.rows[0] as
        | { rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }
        | undefined;
      if (!row || row.rolsuper || row.rolbypassrls || !row.rolcanlogin) {
        throw new Error(
          `Cannot provision a de-privileged ${TEST_ROLE}: this suite must not assert tenant ` +
            'isolation through a privileged role, because Postgres ignores RLS for superusers ' +
            'and BYPASSRLS roles and every assertion would pass vacuously.',
        );
      }
      await admin.query(`ALTER ROLE ${TEST_ROLE} LOGIN PASSWORD '${TEST_ROLE_PASSWORD}'`);
    }
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${TEST_ROLE}`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${TEST_ROLE}`,
    );
    await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${TEST_ROLE}`);

    // Seed two tenants with one student each.
    //
    // SVT-SEC-2026-08 — this used to say "as the owner (bypasses RLS)". That is
    // false: the migrations apply FORCE ROW LEVEL SECURITY, which makes the
    // policies bind the table OWNER too — plain RLS exempts the owner, FORCE
    // does not. The seed only ever worked because the connection happened to be
    // a SUPERUSER, which genuinely does bypass. Run it as the owner role the
    // launch runbook prescribes for DATABASE_MIGRATE_URL (`spv`) and every
    // INSERT below is rejected by the very policies under test.
    //
    // So the fixture sets the GUC per tenant, exactly like application code has
    // to. (DDL is unaffected, which is why `prisma migrate deploy` runs fine as
    // the owner while its DML would not.)
    for (const [tid, name] of [[tenantA, 'RLS Test Tenant A'], [tenantB, 'RLS Test Tenant B']] as const) {
      await admin.query(`SET app.tenant_id = '${tid}'`);
      await admin.query(
        `INSERT INTO tenants (id, name, created_at, updated_at) VALUES ($1,$2,now(),now())`,
        [tid, name],
      );
    }
    for (const [tid, sid] of [[tenantA, stageA], [tenantB, stageB]] as const) {
      await admin.query(`SET app.tenant_id = '${tid}'`);
      await admin.query(
        `INSERT INTO lifecycle_stages (id, tenant_id, key, label, sequence, category, is_initial, is_terminal, created_at, updated_at)
         VALUES ($1,$2,'rls_test','RLS Test',1,'IN_PROGRESS',true,false,now(),now())`,
        [sid, tid],
      );
    }
    // SVT-CI-2026-08 — students.nationality_code FKs to countries(code_alpha2),
    // and CI provisions its database with `migrate deploy` ALONE — no seed. So
    // the suite has to supply the reference rows it depends on rather than
    // assuming a populated lookup table.
    //
    // Deliberately never cleaned up: `countries` is global reference data, not
    // tenant data. On a seeded database the row already exists (ON CONFLICT
    // makes this a no-op), and deleting it in afterAll would strip real
    // reference data from a developer's dev DB.
    await admin.query(
      `INSERT INTO countries (code_alpha2, code_alpha3, numeric_code, name, dial_code)
       VALUES ('NP','NPL','524','Nepal','+977')
       ON CONFLICT (code_alpha2) DO NOTHING`,
    );

    // SVT-CI-2026-08 — name_in_passport_enc is BYTEA NOT NULL in the baseline
    // migration, so the seed must supply it. The bytes are a placeholder, NOT a
    // valid envelope: this suite asserts row VISIBILITY under RLS and never
    // decrypts anything. (This omission went unnoticed because the whole file
    // skips unless the migrations have been applied, and they could not be —
    // see the …235995 fix in this same change.)
    // One INSERT per tenant, because the GUC can only name one tenant at a time
    // and the WITH CHECK is evaluated per row.
    for (const [sid, tid, stg, code, given, family] of [
      [studentA, tenantA, stageA, 'RLS-A-1', 'Alice', 'Anderson'],
      [studentB, tenantB, stageB, 'RLS-B-1', 'Bob', 'Brown'],
    ] as const) {
      await admin.query(`SET app.tenant_id = '${tid}'`);
      await admin.query(
        `INSERT INTO students (id, tenant_id, student_code, given_name, family_name, date_of_birth,
                               nationality_code, current_stage_id, stage_entered_at,
                               name_in_passport_enc, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'2000-01-01','NP',$6,now(),decode('00','hex'),now(),now())`,
        [sid, tid, code, given, family, stg],
      );
    }
    // Leave no tenant pinned, so the assertions below cannot accidentally
    // inherit a GUC the application would not have set.
    await admin.query(`RESET app.tenant_id`);

    app = new Client({ connectionString: roleUrl() });
    await app.connect();
    ready = true;
  }, 60_000);

  afterAll(async () => {
    if (app) { try { await app.end(); } catch { /* ignore */ } }
    if (admin) {
      try {
        // FORCE RLS binds the owner on DELETE too — same reason as the seed.
        for (const tid of [tenantA, tenantB]) {
          await admin.query(`SET app.tenant_id = '${tid}'`);
          await admin.query(`DELETE FROM students WHERE tenant_id = $1`, [tid]);
          await admin.query(`DELETE FROM lifecycle_stages WHERE tenant_id = $1`, [tid]);
          await admin.query(`DELETE FROM tenants WHERE id = $1`, [tid]);
        }
        await admin.query(`RESET app.tenant_id`);
        // Best-effort: dropping a role needs rights an owner-level admin does
        // not have. The role is inert and is reused on the next run.
        await admin.query(`
          DO $$
          BEGIN
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${TEST_ROLE}') THEN
              EXECUTE 'REASSIGN OWNED BY ${TEST_ROLE} TO CURRENT_USER';
              EXECUTE 'DROP OWNED BY ${TEST_ROLE}';
              EXECUTE 'DROP ROLE ${TEST_ROLE}';
            END IF;
          END $$;
        `);
      } catch { /* best-effort cleanup */ }
      try { await admin.end(); } catch { /* ignore */ }
    }
  }, 60_000);

  it('the test role is genuinely subject to RLS (guards against a vacuous pass)', async () => {
    expect(ready).toBe(true);
    const r = await app.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    // If either were true, every assertion below would pass no matter how
    // broken the policies are. This is the meta-assertion that makes the rest
    // of the file meaningful.
    expect(r.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
  });

  it('sees ONLY tenant A rows when app.tenant_id = A', async () => {
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
    const r = await app.query(`SELECT id, tenant_id FROM students WHERE student_code LIKE 'RLS-%'`);
    await app.query('COMMIT');

    expect(r.rows.map((x) => x.id)).toEqual([studentA]);
    expect(r.rows.every((x) => x.tenant_id === tenantA)).toBe(true);
  });

  it('sees ONLY tenant B rows when app.tenant_id = B', async () => {
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantB]);
    const r = await app.query(`SELECT id FROM students WHERE student_code LIKE 'RLS-%'`);
    await app.query('COMMIT');

    expect(r.rows.map((x) => x.id)).toEqual([studentB]);
  });

  it('cannot reach tenant B by asking for its id directly while scoped to A', async () => {
    // The direct-id probe is the shape an IDOR attempt actually takes.
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
    const r = await app.query(`SELECT id FROM students WHERE id = $1`, [studentB]);
    await app.query('COMMIT');

    expect(r.rowCount).toBe(0);
  });

  it('returns ZERO rows when no app.tenant_id is set (escape hatch stays removed)', async () => {
    // Migration 20991231235983_rls_remove_escape_hatch deleted the
    // `OR app_current_tenant() IS NULL` clause. If anyone re-adds it, a code
    // path that forgets tenantContext would quietly read the whole table.
    const r = await app.query(`SELECT id FROM students WHERE student_code LIKE 'RLS-%'`);
    expect(r.rowCount).toBe(0);
  });

  it('cannot INSERT a row into another tenant (WITH CHECK holds)', async () => {
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
    await expect(
      app.query(
        `INSERT INTO students (id, tenant_id, student_code, given_name, family_name, date_of_birth,
                               nationality_code, current_stage_id, stage_entered_at, created_at, updated_at)
         VALUES ($1,$2,'RLS-EVIL','Mal','Ory','2000-01-01','NP',$3,now(),now(),now())`,
        [randomUUID(), tenantB, stageB],
      ),
    ).rejects.toThrow(/row-level security/i);
    await app.query('ROLLBACK');
  });

  it('cannot UPDATE another tenant\'s row while scoped to A', async () => {
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
    const r = await app.query(`UPDATE students SET given_name = 'Hacked' WHERE id = $1`, [studentB]);
    await app.query('COMMIT');

    // The row is invisible, so the UPDATE matches nothing — no error, zero rows.
    expect(r.rowCount).toBe(0);

    const check = await adminRead(tenantB, `SELECT given_name FROM students WHERE id = $1`, [studentB]);
    expect(check.rows[0].given_name).toBe('Bob');
  });

  it('cannot DELETE another tenant\'s row while scoped to A', async () => {
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
    const r = await app.query(`DELETE FROM students WHERE id = $1`, [studentB]);
    await app.query('COMMIT');

    expect(r.rowCount).toBe(0);
    const check = await adminRead(tenantB, `SELECT 1 FROM students WHERE id = $1`, [studentB]);
    expect(check.rowCount).toBe(1);
  });

  it('the GUC is transaction-local — it does not leak to the next statement', async () => {
    // set_config(..., true) is LOCAL scope. If someone changed it to `false`,
    // a pooled connection would carry the previous request's tenant id into
    // the next request — a cross-tenant leak with no code change visible at
    // the call site.
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
    await app.query('COMMIT');

    const r = await app.query(`SELECT id FROM students WHERE student_code LIKE 'RLS-%'`);
    expect(r.rowCount).toBe(0);
  });

  // SVT-SEC-2026-08 — schema-wide invariants, not single-table behaviour.
  //
  // The tests above prove RLS works on `students`. They say nothing about the
  // other ~100 tenant tables, and that gap is exactly where the last hole was:
  // `interview_attempts` carried tenant_id AND candidate_name/candidate_email
  // with no RLS at all, and no test noticed because no test looked at the
  // schema as a whole. These three assertions look at every table at once, so
  // a new tenant-owned table cannot ship unprotected.
  describe('schema-wide RLS invariants', () => {
    it('every table with a tenant_id column has RLS enabled', async () => {
      expect(ready).toBe(true);
      const r = await admin.query(`
        SELECT c.relname
          FROM pg_class c
          JOIN information_schema.columns col
            ON col.table_name = c.relname AND col.column_name = 'tenant_id'
         WHERE c.relkind = 'r'
           AND col.table_schema = 'public'
           AND NOT c.relrowsecurity
         ORDER BY 1
      `);
      expect(r.rows.map((x: { relname: string }) => x.relname)).toEqual([]);
    });

    it('every RLS table also FORCEs it, so the owner cannot bypass', async () => {
      expect(ready).toBe(true);
      // ONE documented exception. jobs/hashAnchor.ts writes an audit anchor for
      // every tenant from a single unscoped connection with no app.tenant_id
      // set — correct for a system-wide integrity job. FORCEing RLS there would
      // make that insert fail its own WITH CHECK and silently stop nightly
      // tamper-evidence, trading a real security control for a cosmetic one.
      // The residual exposure is the owner role, which already holds DDL.
      // Any OTHER table appearing here is a genuine gap, not a new exception.
      const KNOWN_UNFORCED = ['audit_anchors'];
      const r = await admin.query(`
        SELECT c.relname
          FROM pg_class c
          JOIN information_schema.columns col
            ON col.table_name = c.relname AND col.column_name = 'tenant_id'
         WHERE c.relkind = 'r'
           AND col.table_schema = 'public'
           AND c.relrowsecurity
           AND NOT c.relforcerowsecurity
         ORDER BY 1
      `);
      const unforced = r.rows.map((x: { relname: string }) => x.relname);
      expect(unforced.filter((t: string) => !KNOWN_UNFORCED.includes(t))).toEqual([]);
    });

    it('no policy anywhere reintroduces the `app_current_tenant() IS NULL` escape hatch', async () => {
      // That clause makes a connection which never set the GUC see EVERYTHING
      // rather than nothing. It has been removed twice already
      // (…235983, …236005) and re-added twice by later migrations, so it is
      // asserted globally rather than per table.
      expect(ready).toBe(true);
      const r = await admin.query(`
        SELECT tablename, policyname
          FROM pg_policies
         WHERE qual LIKE '%app_current_tenant() IS NULL%'
            OR with_check LIKE '%app_current_tenant() IS NULL%'
         ORDER BY tablename
      `);
      expect(r.rows).toEqual([]);
    });
  });
});
