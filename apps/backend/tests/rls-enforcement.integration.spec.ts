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

    // De-privileged role. DROP first so a crashed prior run cannot poison this one.
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
    await admin.query(
      `CREATE ROLE ${TEST_ROLE} LOGIN PASSWORD '${TEST_ROLE_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${TEST_ROLE}`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${TEST_ROLE}`,
    );
    await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${TEST_ROLE}`);

    // Seed two tenants with one student each, as the owner (bypasses RLS).
    await admin.query(
      `INSERT INTO tenants (id, name, created_at, updated_at) VALUES ($1,$2,now(),now()), ($3,$4,now(),now())`,
      [tenantA, 'RLS Test Tenant A', tenantB, 'RLS Test Tenant B'],
    );
    for (const [tid, sid] of [[tenantA, stageA], [tenantB, stageB]] as const) {
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
    await admin.query(
      `INSERT INTO students (id, tenant_id, student_code, given_name, family_name, date_of_birth,
                             nationality_code, current_stage_id, stage_entered_at,
                             name_in_passport_enc, created_at, updated_at)
       VALUES ($1,$2,'RLS-A-1','Alice','Anderson','2000-01-01','NP',$3,now(),decode('00','hex'),now(),now()),
              ($4,$5,'RLS-B-1','Bob','Brown','2000-01-01','NP',$6,now(),decode('00','hex'),now(),now())`,
      [studentA, tenantA, stageA, studentB, tenantB, stageB],
    );

    app = new Client({ connectionString: roleUrl() });
    await app.connect();
    ready = true;
  }, 60_000);

  afterAll(async () => {
    if (app) { try { await app.end(); } catch { /* ignore */ } }
    if (admin) {
      try {
        await admin.query(`DELETE FROM students WHERE tenant_id = ANY($1)`, [[tenantA, tenantB]]);
        await admin.query(`DELETE FROM lifecycle_stages WHERE tenant_id = ANY($1)`, [[tenantA, tenantB]]);
        await admin.query(`DELETE FROM tenants WHERE id = ANY($1)`, [[tenantA, tenantB]]);
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

    const check = await admin.query(`SELECT given_name FROM students WHERE id = $1`, [studentB]);
    expect(check.rows[0].given_name).toBe('Bob');
  });

  it('cannot DELETE another tenant\'s row while scoped to A', async () => {
    await app.query('BEGIN');
    await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantA]);
    const r = await app.query(`DELETE FROM students WHERE id = $1`, [studentB]);
    await app.query('COMMIT');

    expect(r.rowCount).toBe(0);
    const check = await admin.query(`SELECT 1 FROM students WHERE id = $1`, [studentB]);
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
});
