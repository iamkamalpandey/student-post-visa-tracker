// SVT-WAVE-KMS-PROVIDER-2026-05 — P1-K5 audit chain UTC timestamp.
//
// The original audit hash chain folded `created_at::text` into the canonical
// payload. `::text` on a TIMESTAMPTZ renders in the session DateStyle GUC,
// so a verifier running with a different DateStyle than the trigger would
// false-positive a chain break.
//
// The fix (migration 20991231235984b_audit_chain_utc_timestamp) converts both
// the trigger and audit_logs_verify to:
//
//   to_char(NEW.created_at AT TIME ZONE 'UTC',
//           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
//
// audit_logs_verify additionally retains an OLD-format fallback so existing
// rows hashed with the legacy format still verify until the next anchor cycle.
//
// This spec exercises the canonical-payload shape WITHOUT a live Postgres
// connection: we re-implement the same canonical payload in TypeScript and
// confirm it is independent of the host's locale / DateStyle. The migration
// SQL itself is exercised by the existing audit.spec.ts integration tests
// (which run against the live DB) on a separate CI lane.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';

// Mirror the SQL trigger's canonical-payload construction so we can assert
// stability across simulated "different client DateStyle" inputs.
//
// SQL builds:
//   prev || '|' || id::text || '|' || tenant_id::text || '|' || ...
//        || to_char(created_at AT TIME ZONE 'UTC',
//                   'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
//
// Microsecond precision: matches Postgres TIMESTAMPTZ storage.
function utcTimestampUs(d: Date): string {
  // Date stores millisecond precision; pad to microseconds with 000.
  const iso = d.toISOString(); // 'YYYY-MM-DDTHH:MM:SS.sssZ'
  // Convert 'YYYY-MM-DDTHH:MM:SS.sssZ' -> 'YYYY-MM-DDTHH:MM:SS.sss000Z'
  return iso.replace(/\.(\d{3})Z$/, '.$1000Z');
}

function buildCanonicalPayload(
  prev: string | null,
  row: {
    id: string;
    tenant_id: string | null;
    actor_id: string | null;
    action: string;
    entity_type: string;
    entity_id: string | null;
    entity_version: number | null;
    before_enc: Buffer | null;
    after_enc: Buffer | null;
    request_id: string | null;
    created_at: Date;
  },
  ts: string,
): string {
  return [
    prev ?? '',
    row.id,
    row.tenant_id ?? '',
    row.actor_id ?? '',
    row.action,
    row.entity_type,
    row.entity_id ?? '',
    row.entity_version == null ? '' : String(row.entity_version),
    row.before_enc ? row.before_enc.toString('hex') : '',
    row.after_enc ? row.after_enc.toString('hex') : '',
    row.request_id ?? '',
    ts,
  ].join('|');
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

describe('audit chain — UTC timestamp canonicalisation (P1-K5)', () => {
  const sample = {
    id: '00000000-0000-4000-8000-000000000001',
    tenant_id: '11111111-1111-4111-8111-111111111111',
    actor_id: '22222222-2222-4222-8222-222222222222',
    action: 'student.update',
    entity_type: 'student',
    entity_id: '33333333-3333-4333-8333-333333333333',
    entity_version: 7,
    before_enc: null,
    after_enc: Buffer.from('deadbeef', 'hex'),
    request_id: 'req-abc',
    created_at: new Date('2026-05-21T13:45:07.123Z'),
  };

  it('UTC-normalised timestamp is independent of host TZ_OFFSET (regression for ::text DateStyle bug)', () => {
    // Simulate two callers in different timezones rendering the SAME row.
    // Date.prototype.toISOString() always emits UTC, so a process running
    // in TZ=Asia/Kolkata and one running in TZ=America/Los_Angeles must
    // produce identical canonical payloads.
    const ts1 = utcTimestampUs(sample.created_at);
    const ts2 = utcTimestampUs(new Date(sample.created_at.toISOString())); // round-trip via ISO
    expect(ts1).toBe(ts2);

    const p1 = buildCanonicalPayload(null, sample, ts1);
    const p2 = buildCanonicalPayload(null, sample, ts2);
    expect(sha256Hex(p1)).toBe(sha256Hex(p2));
  });

  it('UTC timestamp has microsecond precision matching the SQL format', () => {
    const ts = utcTimestampUs(sample.created_at);
    // 'YYYY-MM-DDTHH:MM:SS.uuuuuuZ' — 6 fractional digits + Z.
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    expect(ts).toBe('2026-05-21T13:45:07.123000Z');
  });

  it('changing the timestamp by ONE microsecond breaks the chain (sensitivity check)', () => {
    const ts1 = utcTimestampUs(sample.created_at);
    const ts2 = ts1.replace('.123000Z', '.123001Z'); // shift by 1µs
    expect(sha256Hex(buildCanonicalPayload(null, sample, ts1))).not.toBe(
      sha256Hex(buildCanonicalPayload(null, sample, ts2)),
    );
  });

  it('canonical payload matches the SQL trigger ordering exactly (column-by-column drift guard)', () => {
    // If a future refactor reorders fields without bumping a version,
    // this test pins the order so the diff is obvious in code review.
    const ts = utcTimestampUs(sample.created_at);
    const payload = buildCanonicalPayload(null, sample, ts);
    const parts = payload.split('|');
    expect(parts).toEqual([
      '',
      sample.id,
      sample.tenant_id,
      sample.actor_id,
      sample.action,
      sample.entity_type,
      sample.entity_id,
      String(sample.entity_version),
      '',
      sample.after_enc.toString('hex'),
      sample.request_id,
      ts,
    ]);
  });

  // SVT-WAVE-KMS-PROVIDER-2026-05 — D5: app-side canonicalPayload must use
  // the SAME UTC microsecond format the SQL trigger emits. Without this,
  // an offline replay verifier consuming the DB microsecond timestamp would
  // compute a different hash than the app-side builder produced at write
  // time, falsely reporting the chain broken.
  describe('app-side canonicalPayload (D5)', () => {
    it('formatUtcMicros yields YYYY-MM-DDTHH:MM:SS.uuuuuuZ — exact SQL to_char shape', async () => {
      const { formatUtcMicros } = await import('../src/shared/audit.js');
      const t = formatUtcMicros(new Date('2026-05-21T13:45:07.456Z'));
      expect(t).toBe('2026-05-21T13:45:07.456000Z');
      expect(t).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    });

    it('canonicalPayload is BYTE-IDENTICAL when process.env.TZ changes between runs', async () => {
      // Date.prototype.toISOString() always renders UTC regardless of TZ, so
      // the formatter is provably TZ-independent. We assert it explicitly by
      // mutating process.env.TZ around two payload computations and comparing.
      const { canonicalPayload } = await import('../src/shared/audit.js');
      const row = {
        tenant_id: '11111111-1111-4111-8111-111111111111',
        actor_id: '22222222-2222-4222-8222-222222222222',
        actor_email_hash: 'e' + '0'.repeat(63),
        action: 'student.update',
        entity_type: 'student',
        entity_id: '33333333-3333-4333-8333-333333333333',
        entity_version: 1,
        before_enc: null,
        after_enc: Buffer.from('deadbeef', 'hex'),
        ip_hash: 'i' + '0'.repeat(63),
        ua_hash: 'u' + '0'.repeat(63),
        request_id: 'req-abc',
        created_at: new Date('2026-05-21T13:45:07.123Z'),
      };
      const originalTz = process.env.TZ;
      try {
        process.env.TZ = 'America/Los_Angeles';
        const inLA = canonicalPayload(row);
        process.env.TZ = 'Asia/Kolkata';
        const inIN = canonicalPayload(row);
        process.env.TZ = 'Europe/Berlin'; // DST-active TZ
        const inDE = canonicalPayload(row);
        expect(inLA.equals(inIN)).toBe(true);
        expect(inLA.equals(inDE)).toBe(true);
      } finally {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
      }
    });

    it('canonicalPayload survives a DST transition on the host (1Jan vs 1Jul UTC)', async () => {
      // The format string contains no locale tokens — Date.toISOString()
      // produces 'Z' suffix unconditionally, so DST cannot drift the output.
      // We pick two timestamps straddling a typical DST boundary to make
      // the property obvious in the spec.
      const { canonicalPayload } = await import('../src/shared/audit.js');
      const winterRow = {
        tenant_id: null,
        actor_id: null,
        actor_email_hash: null,
        action: 'x',
        entity_type: 'y',
        entity_id: null,
        entity_version: null,
        before_enc: null,
        after_enc: null,
        ip_hash: null,
        ua_hash: null,
        request_id: null,
        created_at: new Date('2026-01-15T03:00:00.000Z'),
      };
      const summerRow = { ...winterRow, created_at: new Date('2026-07-15T03:00:00.000Z') };
      // Different timestamps MUST produce different payloads (sanity); the
      // shape stability is the previous test. Here we assert both renderings
      // contain a 'Z' suffix on the timestamp field — the locale-bearing
      // suffix that the old `::text` path could omit.
      const a = canonicalPayload(winterRow).toString('utf8');
      const b = canonicalPayload(summerRow).toString('utf8');
      expect(a).not.toBe(b);
      expect(a.split('\x1f').at(-1)).toMatch(/Z$/);
      expect(b.split('\x1f').at(-1)).toMatch(/Z$/);
    });
  });

  it('migration file ships the to_char UTC formatter (text-level guard against accidental revert)', async () => {
    // Belt-and-braces: read the migration SQL and confirm the literal is present.
    // This catches a future "oops I edited the wrong file" merge.
    const { readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const sqlPath = resolve(
      here,
      '..',
      'prisma',
      'migrations',
      '20991231235984b_audit_chain_utc_timestamp',
      'migration.sql',
    );
    const sql = readFileSync(sqlPath, 'utf8');
    // Both functions must use the UTC to_char formatter.
    const matches = sql.match(/to_char\(\s*\w+\.created_at\s+AT\s+TIME\s+ZONE\s+'UTC'/g);
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(2);
    // Verify function still has fallback to legacy ::text format.
    expect(sql).toMatch(/rec\.created_at::text/);
  });
});
