// Expiries service — unified scan across visa, passport, insurance, document
// and regulator-id sources.
//
// Why we don't reuse jobs/expiryAlerts.findUpcomingExpiries directly: that
// helper omits regulator IDs, omits overdue rows (gte today only) and doesn't
// resolve student_name. The triaged inbox surface needs all three so we run
// our own query bag here. Both functions share the same "kind" vocabulary
// (extended with "regulator_id") so future consolidation is straightforward.

import type { Prisma, PrismaClient } from '@prisma/client';
import type {
  ExpiriesListQuery,
  ExpiryKind,
  ExpiryRow,
} from '@spv/zod-schemas';

type DB = PrismaClient | Prisma.TransactionClient;

function severityFor(daysRemaining: number): ExpiryRow['severity'] {
  if (daysRemaining < 0) return 'overdue';
  if (daysRemaining <= 14) return 'critical';
  if (daysRemaining <= 30) return 'warning';
  return 'ok';
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// Compose a display name. We keep the encrypted passport name out of the
// surface — students.given_name + family_name is plenty for a triage list.
function studentName(s: { given_name: string; family_name: string }): string {
  return `${s.given_name} ${s.family_name}`.trim();
}

export async function listExpiries(
  db: DB,
  tenantId: string,
  q: ExpiriesListQuery,
): Promise<ExpiryRow[]> {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const horizon = new Date(today);
  horizon.setUTCDate(horizon.getUTCDate() + q.within_days);

  const dayMs = 24 * 60 * 60 * 1000;
  const days = (d: Date) =>
    Math.ceil((d.getTime() - today.getTime()) / dayMs);

  // Filter by `expires_on <= horizon` so overdue rows (date < today) are
  // included. Per-source date columns differ (`expires_on` vs `ends_on`); each
  // query below applies the right column.
  const wantKind = (k: ExpiryKind) => !q.kind || q.kind === k;

  const tasks: Promise<ExpiryRow[]>[] = [];

  if (wantKind('visa')) {
    tasks.push(
      db.studentVisa
        .findMany({
          where: {
            tenant_id: tenantId,
            is_active: true,
            expires_on: { lte: horizon },
          },
          select: {
            id: true,
            student_id: true,
            expires_on: true,
            student: { select: { given_name: true, family_name: true } },
          },
          orderBy: { expires_on: 'asc' },
        })
        .then((rows) =>
          rows.map<ExpiryRow>((r) => {
            const dr = days(r.expires_on);
            return {
              id: r.id,
              kind: 'visa',
              student_id: r.student_id,
              student_name: studentName(r.student),
              expires_on: ymd(r.expires_on),
              days_remaining: dr,
              severity: severityFor(dr),
              source_table: 'student_visas',
            };
          }),
        ),
    );
  }

  if (wantKind('passport')) {
    tasks.push(
      db.studentIdentification
        .findMany({
          where: {
            tenant_id: tenantId,
            type: 'PASSPORT',
            expires_on: { lte: horizon, not: null },
          },
          select: {
            id: true,
            student_id: true,
            expires_on: true,
            student: { select: { given_name: true, family_name: true } },
          },
          orderBy: { expires_on: 'asc' },
        })
        .then((rows) =>
          rows
            .filter((r): r is typeof r & { expires_on: Date } => r.expires_on !== null)
            .map<ExpiryRow>((r) => {
              const dr = days(r.expires_on);
              return {
                id: r.id,
                kind: 'passport',
                student_id: r.student_id,
                student_name: studentName(r.student),
                expires_on: ymd(r.expires_on),
                days_remaining: dr,
                severity: severityFor(dr),
                source_table: 'student_identifications',
              };
            }),
        ),
    );
  }

  if (wantKind('insurance')) {
    tasks.push(
      db.insuranceRecord
        .findMany({
          where: { tenant_id: tenantId, ends_on: { lte: horizon } },
          select: {
            id: true,
            student_id: true,
            ends_on: true,
            student: { select: { given_name: true, family_name: true } },
          },
          orderBy: { ends_on: 'asc' },
        })
        .then((rows) =>
          rows.map<ExpiryRow>((r) => {
            const dr = days(r.ends_on);
            return {
              id: r.id,
              kind: 'insurance',
              student_id: r.student_id,
              student_name: studentName(r.student),
              expires_on: ymd(r.ends_on),
              days_remaining: dr,
              severity: severityFor(dr),
              source_table: 'insurance_records',
            };
          }),
        ),
    );
  }

  if (wantKind('document')) {
    tasks.push(
      db.document
        .findMany({
          where: {
            tenant_id: tenantId,
            deleted_at: null,
            expires_on: { lte: horizon, not: null },
          },
          select: {
            id: true,
            student_id: true,
            expires_on: true,
            student: { select: { given_name: true, family_name: true } },
          },
          orderBy: { expires_on: 'asc' },
        })
        .then((rows) =>
          rows
            .filter((r): r is typeof r & { expires_on: Date } => r.expires_on !== null)
            .map<ExpiryRow>((r) => {
              const dr = days(r.expires_on);
              return {
                id: r.id,
                kind: 'document',
                student_id: r.student_id,
                student_name: studentName(r.student),
                expires_on: ymd(r.expires_on),
                days_remaining: dr,
                severity: severityFor(dr),
                source_table: 'documents',
              };
            }),
        ),
    );
  }

  if (wantKind('regulator_id')) {
    tasks.push(
      db.studentRegulatorIdentifier
        .findMany({
          where: {
            tenant_id: tenantId,
            expires_on: { lte: horizon, not: null },
          },
          select: {
            id: true,
            student_id: true,
            expires_on: true,
            student: { select: { given_name: true, family_name: true } },
          },
          orderBy: { expires_on: 'asc' },
        })
        .then((rows) =>
          rows
            .filter((r): r is typeof r & { expires_on: Date } => r.expires_on !== null)
            .map<ExpiryRow>((r) => {
              const dr = days(r.expires_on);
              return {
                id: r.id,
                kind: 'regulator_id',
                student_id: r.student_id,
                student_name: studentName(r.student),
                expires_on: ymd(r.expires_on),
                days_remaining: dr,
                severity: severityFor(dr),
                source_table: 'student_regulator_identifiers',
              };
            }),
        ),
    );
  }

  const grouped = await Promise.all(tasks);
  const out = grouped.flat();
  out.sort((a, b) => a.days_remaining - b.days_remaining);
  return out;
}
