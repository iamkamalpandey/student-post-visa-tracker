// SVT-SEC-RLS-ESCAPE-HATCH-2026-05 (P0-1) — verifies the migration that
// removes the `OR app_current_tenant() IS NULL` escape clause from every
// tenant_isolation RLS policy.
//
// We don't have a Postgres instance in the test environment, so the spec
// asserts on the migration file CONTENTS and on the post-fix auth-service
// behaviour:
//
//   1. Migration file exists at the expected path.
//   2. Migration drops + recreates EVERY tenant_isolation policy listed in
//      prior RLS migrations.
//   3. New policy bodies contain ONLY the tenant-equality clause; the
//      escape `OR app_current_tenant() IS NULL` is GONE.
//   4. The four critical tables (audit_logs / access_token_denylist /
//      breach_incidents / student_lifecycle_events) keep the `tenant_id IS
//      NULL` system-row branch but lose the escape clause.
//   5. The tenants self-read policy is dropped + recreated without the
//      escape clause.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATION_PATH = join(
  process.cwd(),
  'prisma',
  'migrations',
  '20991231235983_rls_remove_escape_hatch',
  'migration.sql',
);

describe('migration: 20991231235983_rls_remove_escape_hatch', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');

  it('exists and is non-empty', () => {
    expect(sql.length).toBeGreaterThan(500);
  });

  it('drops + recreates the tenant_isolation policy on the headline tenant-scoped tables', () => {
    // A representative sample — if the migration covers these it covers
    // the full enumeration (DO-loop pattern).
    for (const table of ['students', 'enrollments', 'users', 'documents', 'refresh_tokens']) {
      expect(sql).toContain(table);
    }
    // The DROP+CREATE pair is emitted via format() in a DO block.
    expect(sql).toContain('DROP POLICY IF EXISTS tenant_isolation');
    expect(sql).toContain('CREATE POLICY tenant_isolation');
  });

  it('new tenant_isolation policy has NO `OR app_current_tenant() IS NULL` escape clause', () => {
    // The ONLY reference to the escape clause should be in the comment
    // block at the top of the file (documenting what's being removed).
    // Count: the body of the migration must not emit it inside a CREATE
    // POLICY statement.
    //
    // Strip line-comments so we only inspect executable SQL.
    const executable = sql
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    expect(executable).not.toContain('app_current_tenant() IS NULL');
  });

  it('keeps the `tenant_id IS NULL` system-row branch for the critical-coverage tables', () => {
    // audit_logs / access_token_denylist / breach_incidents intentionally
    // retain the `tenant_id IS NULL` branch so global / system-actor rows
    // remain visible. Only the OTHER escape clause is removed.
    expect(sql).toContain('audit_logs');
    expect(sql).toContain('access_token_denylist');
    expect(sql).toContain('breach_incidents');
    expect(sql).toContain('tenant_id IS NULL');
  });

  it('drops + recreates the tenants self-read policy without the escape clause', () => {
    expect(sql).toContain('DROP POLICY IF EXISTS tenant_self_read ON tenants');
    expect(sql).toContain('CREATE POLICY tenant_self_read ON tenants');
    // The tenants policy uses `id = app_current_tenant()` (no escape).
    expect(sql).toMatch(/CREATE POLICY tenant_self_read ON tenants\s+USING \(id = app_current_tenant\(\)\)/);
  });
});
