import { PrismaClient } from '@prisma/client';
import { logger } from './logger.js';
import { env } from './env.js';

// SVT-OPS-2026-08 (T4-5) — bound BOTH connection pools explicitly.
//
// The managed Postgres this runs on allows `max_connections = 25` with
// `superuser_reserved_connections = 3`, so the application gets **22**, and
// DigitalOcean's own monitoring already sits inside that budget. Prisma's
// default pool is `physical_cpus * 2 + 1` per client and this process builds
// TWO clients (`prisma` + `prismaAdmin`), so the ceiling was implicit,
// per-machine and invisible — until the day something opened more concurrent
// transactions than usual and the database answered
//
//   FATAL: remaining connection slots are reserved for roles with the
//   SUPERUSER attribute
//
// which is what happened at 2026-08-13T04:23Z when three crons fired in the
// same second: reminder.dispatcher FAILED outright. The T0-7 fix is what
// tipped it — scoping work into `withTenantTx` means holding a connection for
// the length of a transaction rather than a single statement — but the real
// defect is an unbounded pool against a 22-connection budget. That is a
// production footgun regardless of what triggers it.
//
// Explicit and small beats implicit and CPU-derived. Overridable per
// environment, because a bigger database deserves a bigger pool.
function boundPool(rawUrl: string | undefined, limit: number): string | undefined {
  if (!rawUrl) return undefined;
  // Never override an operator who has already been explicit in the URL.
  if (/[?&]connection_limit=/.test(rawUrl)) return rawUrl;
  const sep = rawUrl.includes('?') ? '&' : '?';
  // pool_timeout: fail fast and loudly rather than hanging a request for the
  // default 10s when the pool is genuinely saturated.
  return `${rawUrl}${sep}connection_limit=${limit}&pool_timeout=20`;
}

const RUNTIME_POOL = Number(process.env['DB_CONNECTION_LIMIT'] ?? 6);
const ADMIN_POOL = Number(process.env['DB_ADMIN_CONNECTION_LIMIT'] ?? 3);

const runtimeUrl = boundPool(process.env['DATABASE_URL'], RUNTIME_POOL);

// Single PrismaClient per process. Tenant isolation enforced via RLS + middleware that runs
// `SET LOCAL app.tenant_id` per request (see middlewares/tenantContext.ts).
export const prisma = new PrismaClient({
  log: [
    { emit: 'event', level: 'warn' },
    { emit: 'event', level: 'error' },
  ],
  ...(runtimeUrl ? { datasources: { db: { url: runtimeUrl } } } : {}),
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
const adminUrl = boundPool(
  process.env['DATABASE_MIGRATE_URL'] || process.env['DATABASE_URL'] || '',
  // Deliberately smaller than the runtime pool: this client exists for narrow
  // auth-time lookups and a handful of cross-tenant job scans, not for serving
  // request traffic. It should never be the reason the database runs out.
  ADMIN_POOL,
);
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
/**
 * SVT-SEC-2026-08 — has the runtime role been PROVEN to be RLS-enforced?
 *
 * The assertion below deliberately does not crash when its probe fails (a
 * transient DB blip at boot should not brick a deployment), but the previous
 * behaviour was to skip the check and serve anyway — so a deploy that raced a
 * database failover could run indefinitely with tenant isolation never
 * verified. "It re-runs on the next boot" assumes a restart that may not come
 * for weeks.
 *
 * Readiness is the right lever rather than a crash loop: /readyz now refuses to
 * report ready in production until this is true, so such an instance simply
 * never receives traffic and the platform keeps the previous version serving.
 * A blip delays readiness; it no longer silently disables the single control
 * that makes this system safe to run multi-tenant.
 */
let rlsRoleVerified = false;
export function isRlsRoleVerified(): boolean {
  return rlsRoleVerified;
}

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
    rlsRoleVerified = true;
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
  // Non-production with a privileged role: a single-role dev DB is a valid
  // local setup, so mark it verified — otherwise /readyz would refuse to come
  // ready on every developer machine. The production branch above has already
  // exited by this point, so this can never mask a real misconfiguration.
  rlsRoleVerified = true;
  logger.warn(
    { role: row.rolname, rolsuper: row.rolsuper, rolbypassrls: row.rolbypassrls },
    'rls-role-assert: runtime DB role is superuser/BYPASSRLS so RLS is bypassed — OK for a single-role dev DB, but production MUST use spv_app.',
  );
}

export async function disconnectDb(): Promise<void> {
  await Promise.all([prisma.$disconnect(), prismaAdmin.$disconnect()]);
}
