// Scans for upcoming expiries (visa, passport, insurance, document) and produces a JSON
// summary the dashboard widget can consume. Designed to run periodically (cron / BullMQ /
// pg-boss). For v1 we only expose the function — wiring to a scheduler comes later.

import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../config/db.js';
import { logger } from '../config/logger.js';

type ExpiriesDb = PrismaClient | Prisma.TransactionClient | typeof prisma;

export type ExpiryRow = {
  kind: 'visa' | 'passport' | 'insurance' | 'document';
  entity_id: string;
  student_id: string;
  expires_on: string;
  days_remaining: number;
};

export async function findUpcomingExpiries(opts: {
  tenantId?: string;
  withinDays?: number;
  /**
   * RLS-scoped client (req.db). Required for HTTP-driven calls so the GUC is set.
   * For background jobs (where no req exists) the singleton works because RLS is
   * disabled when called from a tx that pre-sets app.tenant_id manually.
   */
  db?: ExpiriesDb;
}): Promise<ExpiryRow[]> {
  const client = opts.db ?? prisma;
  const within = opts.withinDays ?? 60;
  const horizon = new Date();
  horizon.setUTCDate(horizon.getUTCDate() + within);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  // SEC-burst: when caller omits tenantId AND no scoped client supplied,
  // the previous code stripped tenant filters entirely and leaked every
  // tenant's PII through the dashboard widget. Refuse the call so misuse
  // is loud, not silent. The scheduler always passes one.
  if (!opts.tenantId && !opts.db) {
    throw new Error('findUpcomingExpiries: tenantId or RLS-scoped db is required');
  }
  const tenantWhere = opts.tenantId ? { tenant_id: opts.tenantId } : {};

  // SVT-PERF-2026-06 — the date-window already bounds these to the next
  // `within` days, but with no row cap a tenant with a huge expiry backlog
  // would still materialise the whole set into Node on every dashboard load
  // (the summary only shows the soonest ~25). Cap each kind at MAX_PER_KIND
  // ordered soonest-first so the most-urgent are never dropped, and WARN (never
  // silently truncate) if any kind hits the cap so the limit is observable.
  const MAX_PER_KIND = 1000;

  const [visas, passports, insurances, docs] = await Promise.all([
    client.studentVisa.findMany({
      where: { ...tenantWhere, is_active: true, expires_on: { gte: today, lte: horizon }, student: { is: { deleted_at: null } } },
      select: { id: true, student_id: true, expires_on: true },
      orderBy: { expires_on: 'asc' },
      take: MAX_PER_KIND,
    }),
    client.studentIdentification.findMany({
      where: { ...tenantWhere, type: 'PASSPORT', expires_on: { gte: today, lte: horizon }, student: { is: { deleted_at: null } } },
      select: { id: true, student_id: true, expires_on: true },
      orderBy: { expires_on: 'asc' },
      take: MAX_PER_KIND,
    }),
    client.insuranceRecord.findMany({
      where: { ...tenantWhere, ends_on: { gte: today, lte: horizon }, student: { is: { deleted_at: null } } },
      select: { id: true, student_id: true, ends_on: true },
      orderBy: { ends_on: 'asc' },
      take: MAX_PER_KIND,
    }),
    client.document.findMany({
      where: {
        ...tenantWhere,
        deleted_at: null,
        expires_on: { gte: today, lte: horizon },
      },
      select: { id: true, student_id: true, expires_on: true },
      orderBy: { expires_on: 'asc' },
      take: MAX_PER_KIND,
    }),
  ]);

  const truncated = [
    ['visa', visas.length],
    ['passport', passports.length],
    ['insurance', insurances.length],
    ['document', docs.length],
  ].filter(([, n]) => (n as number) >= MAX_PER_KIND);
  if (truncated.length > 0) {
    logger.warn(
      { tenantId: opts.tenantId, within, cap: MAX_PER_KIND, kinds: truncated.map(([k]) => k) },
      'expiry scan: result capped at MAX_PER_KIND for one or more kinds — soonest are kept; widen handling if this recurs',
    );
  }

  const days = (d: Date) => Math.ceil((d.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));

  const rows: ExpiryRow[] = [
    ...visas.map<ExpiryRow>((r) => ({
      kind: 'visa',
      entity_id: r.id,
      student_id: r.student_id,
      expires_on: r.expires_on.toISOString().slice(0, 10),
      days_remaining: days(r.expires_on),
    })),
    ...passports
      .filter((r): r is typeof r & { expires_on: Date } => r.expires_on !== null)
      .map<ExpiryRow>((r) => ({
        kind: 'passport',
        entity_id: r.id,
        student_id: r.student_id,
        expires_on: r.expires_on.toISOString().slice(0, 10),
        days_remaining: days(r.expires_on),
      })),
    ...insurances.map<ExpiryRow>((r) => ({
      kind: 'insurance',
      entity_id: r.id,
      student_id: r.student_id,
      expires_on: r.ends_on.toISOString().slice(0, 10),
      days_remaining: days(r.ends_on),
    })),
    ...docs
      .filter((r): r is typeof r & { expires_on: Date } => r.expires_on !== null)
      .map<ExpiryRow>((r) => ({
        kind: 'document',
        entity_id: r.id,
        student_id: r.student_id,
        expires_on: r.expires_on.toISOString().slice(0, 10),
        days_remaining: days(r.expires_on),
      })),
  ];

  rows.sort((a, b) => a.days_remaining - b.days_remaining);
  logger.info({ within, count: rows.length }, 'expiry scan complete');
  return rows;
}
