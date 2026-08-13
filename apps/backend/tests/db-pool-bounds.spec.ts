// SVT-OPS-2026-08 (T4-5) — both Prisma pools must be explicitly bounded.
//
// WHY, FROM A REAL OUTAGE
// -----------------------
// The managed Postgres this app runs on allows `max_connections = 25` with
// `superuser_reserved_connections = 3` — so 22 for the application, shared with
// the provider's own monitoring. Prisma's default pool is
// `physical_cpus * 2 + 1` PER CLIENT, and this process constructs two clients
// (`prisma` and `prismaAdmin`). Nothing anywhere stated a ceiling.
//
// On 2026-08-13T04:23Z three crons fired in the same second and the database
// answered:
//
//   FATAL: remaining connection slots are reserved for roles with the
//   SUPERUSER attribute
//
// `reminder.dispatcher` FAILED. The trigger was the T0-7 fix — scoping work
// into withTenantTx holds a connection for a transaction rather than a single
// statement — but the defect is the unbounded pool. A CPU-derived, per-machine,
// undocumented ceiling against a hard 22-connection budget will always find a
// day to bite; it just needs enough concurrency.
//
// This test pins the bound so the next person to change pooling has to do it
// deliberately.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DB_TS = readFileSync(join(process.cwd(), 'src', 'config', 'db.ts'), 'utf8');

describe('T4-5 — connection pools are explicitly bounded', () => {
  it('applies a connection_limit to the runtime client', () => {
    expect(DB_TS).toMatch(/connection_limit=/);
    expect(DB_TS).toMatch(/boundPool\(process\.env\['DATABASE_URL'\]/);
  });

  it('applies a connection_limit to the admin client too', () => {
    // The admin client is the easy one to forget: it is only used for narrow
    // auth lookups and cross-tenant job scans, so it looks harmless — while
    // quietly holding its own full-size pool.
    expect(DB_TS).toMatch(/const adminUrl = boundPool\(/);
  });

  it('keeps the combined default well inside the 22-connection budget', () => {
    const runtime = Number(/DB_CONNECTION_LIMIT'\] \?\? (\d+)/.exec(DB_TS)?.[1]);
    const admin = Number(/DB_ADMIN_CONNECTION_LIMIT'\] \?\? (\d+)/.exec(DB_TS)?.[1]);
    expect(Number.isFinite(runtime)).toBe(true);
    expect(Number.isFinite(admin)).toBe(true);

    // Two clients per instance. Leave headroom for the migrate job, the
    // provider's monitoring, and a human with psql open during an incident.
    expect(
      runtime + admin,
      `runtime(${runtime}) + admin(${admin}) must stay well under the 22 ` +
        'connections this database actually grants the app.',
    ).toBeLessThanOrEqual(12);

    // The admin client must not be the bigger of the two — it serves no
    // request traffic.
    expect(admin).toBeLessThan(runtime);
  });

  it('never overrides an operator who set connection_limit in the URL', () => {
    expect(DB_TS).toMatch(/connection_limit=\/\.test\(rawUrl\)/);
  });
});
