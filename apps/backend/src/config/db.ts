import { PrismaClient } from '@prisma/client';
import { logger } from './logger.js';
import { env } from './env.js';

// Single PrismaClient per process. Tenant isolation enforced via RLS + middleware that runs
// `SET LOCAL app.tenant_id` per request (see middlewares/tenantContext.ts).
export const prisma = new PrismaClient({
  log: [
    { emit: 'event', level: 'warn' },
    { emit: 'event', level: 'error' },
  ],
});

prisma.$on('warn' as never, (e: { message?: string }) => {
  logger.warn({ prisma: true, message: e.message });
});
prisma.$on('error' as never, (e: { message?: string }) => {
  logger.error({ prisma: true, message: e.message });
});

// SVT-SEC-RLS-ESCAPE-HATCH-2026-05 — bypass-RLS admin client.
//
// Migration 20991231235983_rls_remove_escape_hatch tightened every
// tenant_isolation policy to require the matching `app.tenant_id` GUC; the
// previous "OR app_current_tenant() IS NULL" branch is gone. App requests
// hit the singleton `prisma` above wrapped by `tenantContext`, so policy
// gates apply correctly.
//
// A small set of authentication-time queries legitimately need cross-tenant
// access (login lookup by email, password-reset by email, refresh-token
// lookup by hash, logout). Those callsites previously relied on the now-
// removed escape hatch. To keep them working we expose a separate Prisma
// client connected via DATABASE_MIGRATE_URL — that URL points at the
// `spv_admin` superuser role which has BYPASSRLS, so the helper functions
// in `auth.service` / `password-reset.service` can issue narrow lookups
// (unique-key reads by email / token_hash / id) without the GUC dance.
//
// SECURITY: every caller of `prismaAdmin` must restrict itself to lookups
// that are themselves authentication primitives (the input is trusted-by-
// design to be the supplied credential material). Do NOT use this client
// for arbitrary reads.
const adminUrl =
  process.env['DATABASE_MIGRATE_URL'] || process.env['DATABASE_URL'] || '';
export const prismaAdmin = new PrismaClient({
  log: [
    { emit: 'event', level: 'warn' },
    { emit: 'event', level: 'error' },
  ],
  ...(adminUrl ? { datasources: { db: { url: adminUrl } } } : {}),
});

prismaAdmin.$on('warn' as never, (e: { message?: string }) => {
  logger.warn({ prisma: 'admin', message: e.message });
});
prismaAdmin.$on('error' as never, (e: { message?: string }) => {
  logger.error({ prisma: 'admin', message: e.message });
});

// SVT-SEC-RLS-ROLE-ASSERT-2026-06 — the runtime `prisma` client MUST connect as
// a role that RLS actually applies to. Postgres silently ignores every
// tenant_isolation policy for superusers and BYPASSRLS roles (FORCE ROW LEVEL
// SECURITY only forces policies on the *owner*, not on superusers), so a
// DATABASE_URL pointing at the DB admin/owner (e.g. DigitalOcean's `doadmin`,
// `${db.DATABASE_URL}`) would disable tenant isolation for the WHOLE app with no
// other symptom — every tenant could read every other tenant's data. We probe
// the runtime role at boot and refuse to serve a privileged role in production.
// `prismaAdmin` is deliberately superuser (narrow auth-time cross-tenant
// lookups) and is intentionally NOT checked here.
export async function assertRuntimeRoleRespectsRls(): Promise<void> {
  let row: { rolname: string; rolsuper: boolean; rolbypassrls: boolean } | undefined;
  try {
    const rows = await prisma.$queryRaw<
      Array<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>
    >`SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    row = rows[0];
  } catch (err) {
    // DB unreachable at boot — don't block startup on a transient outage; the
    // readyz gate + scheduler DB-probe handle availability, and the check
    // re-runs on the next boot.
    logger.warn({ err }, 'rls-role-assert: could not probe runtime DB role (DB unreachable?) — skipped');
    return;
  }
  if (!row) {
    logger.warn('rls-role-assert: current_user not found in pg_roles — skipped');
    return;
  }
  if (!row.rolsuper && !row.rolbypassrls) {
    logger.info({ role: row.rolname }, 'rls-role-assert: runtime DB role is RLS-enforced');
    return;
  }
  if (env.NODE_ENV === 'production') {
    logger.fatal(
      { role: row.rolname, rolsuper: row.rolsuper, rolbypassrls: row.rolbypassrls },
      'FATAL: runtime DATABASE_URL connects as a superuser/BYPASSRLS role — Postgres RLS does NOT apply, so tenant isolation is OFF. Point DATABASE_URL at the de-privileged app role (e.g. spv_app); keep DATABASE_MIGRATE_URL on the owner. Refusing to start.',
    );
    process.exit(1);
  }
  logger.warn(
    { role: row.rolname, rolsuper: row.rolsuper, rolbypassrls: row.rolbypassrls },
    'rls-role-assert: runtime DB role is superuser/BYPASSRLS so RLS is bypassed — OK for a single-role dev DB, but production MUST use spv_app.',
  );
}

export async function disconnectDb(): Promise<void> {
  await Promise.all([prisma.$disconnect(), prismaAdmin.$disconnect()]);
}
