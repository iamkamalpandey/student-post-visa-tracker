// SVT-WAVE-STATUS-PUBLIC-2026-05 — tenant-facing operational status surface.
//
// Powers GET /api/v1/public/status (unauthenticated). Aggregates subsystem
// liveness + the last 90 days of *open* BreachIncident rows into a shape the
// public status page can render without leaking internals.
//
// Sensitive-field policy
// ----------------------
// BreachIncident has fields counsellors / admins must NEVER see on a public
// page: `description` (often contains affected sub-processor names, root-cause
// narrative), `remediation` (the fix steps — useful to attackers), and
// `affected_subjects_count` (regulators / press will sue if a stale count
// leaks). The shaping function below picks an explicit allowlist; reviewers
// should not change it without a privacy sign-off.
//
// Caching
// -------
// 60s in-process TTL. The status page auto-refreshes every 60s via meta-refresh,
// so without caching N tenants polling on the same minute would each issue a
// DB ping + Redis ping + breach query. The cache is module-level on purpose:
// status is the same for every caller (no tenant scope), so a single shared
// snapshot is correct.

import type { PrismaClient } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { getRedisClient } from '../../shared/redisClient.js';

// Public response shape — exported as a TS type so the frontend's
// `lib/api-types` re-export (or duplicate) stays honest.
export type SubsystemStatus = 'operational' | 'degraded' | 'unknown';
export type OverallStatus = 'operational' | 'degraded' | 'major_outage';

export interface PublicSubsystem {
  name: string;
  status: SubsystemStatus;
  last_checked: string; // ISO timestamp
}

export interface PublicIncident {
  id: string;
  title: string;
  severity: string;
  started_at: string;
  resolved_at: string | null;
  status: 'open' | 'resolved';
}

export interface PublicStatus {
  status: OverallStatus;
  generated_at: string;
  subsystems: PublicSubsystem[];
  incidents: PublicIncident[];
}

const CACHE_TTL_MS = 60_000;
const INCIDENT_WINDOW_DAYS = 90;
const JOB_LIVENESS_HOURS = 26; // a job that ran in the last 26h is considered alive (covers daily crons + a buffer)

let cachedSnapshot: { at: number; value: PublicStatus } | null = null;

// Surface a name from the breach row. The schema doesn't have a dedicated
// `title` column, so we synthesize one from severity + detected_at date.
// Critically we do NOT pull from `description` — that's the admin-only field.
function deriveIncidentTitle(severity: string, detected_at: Date): string {
  const date = detected_at.toISOString().slice(0, 10);
  return `${severity} severity incident (${date})`;
}

async function checkDb(db: PrismaClient): Promise<PublicSubsystem> {
  const name = 'Database';
  const now = new Date().toISOString();
  try {
    await db.$queryRaw`SELECT 1`;
    return { name, status: 'operational', last_checked: now };
  } catch (err) {
    logger.warn({ err }, 'public status: DB ping failed');
    return { name, status: 'degraded', last_checked: now };
  }
}

async function checkRedis(): Promise<PublicSubsystem | null> {
  // Redis is optional — REDIS_URL gates whether it's even configured. If the
  // env var is unset, omit the subsystem entirely (we don't want a permanent
  // "unknown" row for a feature the operator chose not to enable).
  if (!process.env.REDIS_URL) return null;
  const name = 'Cache';
  const now = new Date().toISOString();
  try {
    const client = await getRedisClient();
    if (!client) {
      // REDIS_URL was set but the optional package isn't installed; we degrade
      // here so operators see the gap on the status page they themselves wrote.
      return { name, status: 'degraded', last_checked: now };
    }
    // A SET-NX with a tiny TTL is the cheapest health probe that touches the
    // wire path the rest of the app uses (auth.ts, requireMfa.ts). PING would
    // be cheaper but doesn't exercise the write path.
    await client.set('healthz:status', '1', { NX: true, EX: 5 });
    return { name, status: 'operational', last_checked: now };
  } catch (err) {
    logger.warn({ err }, 'public status: Redis ping failed');
    return { name, status: 'degraded', last_checked: now };
  }
}

async function checkAv(): Promise<PublicSubsystem | null> {
  // AV is similarly optional. Document uploads use ClamAV via av.ts when a
  // clamd is reachable on 127.0.0.1:3310; if no host is configured (operators
  // can opt in via CLAMAV_HOST / CLAMAV_PORT), we omit the row.
  const { env } = await import('../../config/env.js');
  const host = env.CLAMAV_HOST;
  if (!host) return null;
  const name = 'Antivirus';
  const now = new Date().toISOString();
  const port = env.CLAMAV_PORT;
  try {
    const { scanBuffer } = await import('../documents/av.js');
    // Scan an empty buffer — clamd responds with `stream: OK` for empty
    // streams, which validates the wire round-trip without paying for a real
    // scan. ERROR is fail-closed in av.ts, so any wire issue surfaces here.
    const r = await scanBuffer(Buffer.alloc(0), { host, port, timeoutMs: 5_000 });
    return {
      name,
      status: r.result === 'ERROR' ? 'degraded' : 'operational',
      last_checked: now,
    };
  } catch (err) {
    logger.warn({ err }, 'public status: AV ping failed');
    return { name, status: 'degraded', last_checked: now };
  }
}

async function checkJobs(db: PrismaClient): Promise<PublicSubsystem> {
  // Background jobs are "alive" if ANY job has reached terminal state in the
  // last JOB_LIVENESS_HOURS. We deliberately don't require all named jobs to
  // be present — a fresh deployment with no cron tick yet shouldn't show red.
  const name = 'Background jobs';
  const now = new Date().toISOString();
  try {
    const since = new Date(Date.now() - JOB_LIVENESS_HOURS * 3_600_000);
    const recent = await db.jobRun.findFirst({
      where: { finished_at: { gte: since } },
      orderBy: { finished_at: 'desc' },
      select: { id: true },
    });
    return {
      name,
      // 'unknown' (not degraded) when there's no recent run — a brand-new
      // environment shouldn't paint a permanent yellow on the page.
      status: recent ? 'operational' : 'unknown',
      last_checked: now,
    };
  } catch (err) {
    logger.warn({ err }, 'public status: job liveness check failed');
    return { name, status: 'degraded', last_checked: now };
  }
}

function rollUp(subsystems: PublicSubsystem[]): OverallStatus {
  // Roll-up policy: any degraded subsystem → degraded overall. We reserve
  // 'major_outage' for the case where the DB itself is down — without a DB
  // the rest of the app is unusable, regardless of how green the other rows
  // look. 'unknown' (no recent job run) is NOT degraded.
  const db = subsystems.find((s) => s.name === 'Database');
  if (db?.status === 'degraded') return 'major_outage';
  if (subsystems.some((s) => s.status === 'degraded')) return 'degraded';
  return 'operational';
}

async function loadIncidents(db: PrismaClient): Promise<PublicIncident[]> {
  try {
    const since = new Date(Date.now() - INCIDENT_WINDOW_DAYS * 24 * 3_600_000);
    // Pull the minimal column set explicitly. NEVER `select: undefined` here —
    // we don't want a future schema column (e.g. `internal_notes`) to leak by
    // accident. The mapping function below ALSO only emits whitelisted fields.
    const rows = await db.breachIncident.findMany({
      where: { detected_at: { gte: since } },
      orderBy: { detected_at: 'desc' },
      take: 50,
      select: {
        id: true,
        severity: true,
        detected_at: true,
        closed_at: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      title: deriveIncidentTitle(r.severity, r.detected_at),
      severity: r.severity,
      started_at: r.detected_at.toISOString(),
      resolved_at: r.closed_at ? r.closed_at.toISOString() : null,
      status: r.closed_at ? 'resolved' : 'open',
    }));
  } catch (err) {
    logger.warn({ err }, 'public status: incident load failed');
    return [];
  }
}

async function buildSnapshot(db: PrismaClient): Promise<PublicStatus> {
  const [dbCheck, redisCheck, avCheck, jobCheck, incidents] = await Promise.all([
    checkDb(db),
    checkRedis(),
    checkAv(),
    checkJobs(db),
    loadIncidents(db),
  ]);
  const subsystems: PublicSubsystem[] = [dbCheck];
  if (redisCheck) subsystems.push(redisCheck);
  if (avCheck) subsystems.push(avCheck);
  subsystems.push(jobCheck);

  return {
    status: rollUp(subsystems),
    generated_at: new Date().toISOString(),
    subsystems,
    incidents,
  };
}

export const publicStatusService = {
  /**
   * Return the cached status snapshot, regenerating if stale. The cache is
   * shared across all callers because the response is identical regardless of
   * who's asking (no tenant scoping on the public surface).
   */
  async get(db: PrismaClient = prisma): Promise<PublicStatus> {
    const now = Date.now();
    if (cachedSnapshot && now - cachedSnapshot.at < CACHE_TTL_MS) {
      return cachedSnapshot.value;
    }
    const snap = await buildSnapshot(db);
    cachedSnapshot = { at: now, value: snap };
    return snap;
  },
};

/** Test-only: force the next call to rebuild. */
export function __resetStatusCacheForTests(): void {
  cachedSnapshot = null;
}
