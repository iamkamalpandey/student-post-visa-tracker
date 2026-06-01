import { PrismaClient } from '@prisma/client';
import { logger } from './logger.js';

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

export async function disconnectDb(): Promise<void> {
  await Promise.all([prisma.$disconnect(), prismaAdmin.$disconnect()]);
}
