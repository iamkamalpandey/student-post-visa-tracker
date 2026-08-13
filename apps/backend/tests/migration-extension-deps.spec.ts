// SVT-SEC-2026-08 (T0-8) — every SQL function the migrations call must be
// provided by an extension the migrations also create.
//
// WHY THIS EXISTS
// ---------------
// The tamper-evident audit chain hashes each row with
// `encode(digest(payload, 'sha256'), 'hex')`. `digest()` comes from **pgcrypto**,
// and across three migrations and six call sites, no migration ever ran
// `CREATE EXTENSION pgcrypto`. The only extension created was pg_trgm, for
// search.
//
// It was invisible for two compounding reasons:
//
//   1. PL/pgSQL function bodies are not resolved at CREATE time, only at
//      EXECUTE time. So the whole migration chain applies to a virgin database
//      and reports success — the failure waits for the first INSERT.
//   2. `writeAudit` catches its own errors by design, so that first failure is
//      logged and swallowed. Deliberate — an audit failure must never take down
//      the business operation that triggered it — but combined with (1) it
//      means the audit trail is simply empty and nothing ever says so.
//
// Every unit test mocks Prisma, so none of them could see it. It surfaced only
// when the T0-7 work stood a real de-privileged Postgres up and ran writeAudit
// against it end to end.
//
// This guard is the cheap generalisation: scan the migrations for calls to
// functions that only exist inside an extension, and require that extension to
// be created by some migration. No database needed, so it runs everywhere.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(process.cwd(), 'prisma', 'migrations');

/**
 * Functions that are NOT built into Postgres, mapped to the extension that
 * provides them. Add to this when a migration starts using a new one — that is
 * the moment to also add the CREATE EXTENSION.
 */
const EXTENSION_FUNCTIONS: Array<{ fn: string; extension: string }> = [
  { fn: 'digest', extension: 'pgcrypto' },
  { fn: 'hmac', extension: 'pgcrypto' },
  { fn: 'crypt', extension: 'pgcrypto' },
  { fn: 'gen_salt', extension: 'pgcrypto' },
  { fn: 'gen_random_bytes', extension: 'pgcrypto' },
  { fn: 'pgp_sym_encrypt', extension: 'pgcrypto' },
  { fn: 'pgp_sym_decrypt', extension: 'pgcrypto' },
  { fn: 'similarity', extension: 'pg_trgm' },
  { fn: 'show_trgm', extension: 'pg_trgm' },
  { fn: 'unaccent', extension: 'unaccent' },
  { fn: 'uuid_generate_v4', extension: 'uuid-ossp' },
];

function allMigrationSql(): Array<{ name: string; sql: string }> {
  return readdirSync(MIGRATIONS_DIR)
    .filter((d) => !d.startsWith('.') && d !== 'migration_lock.toml')
    .map((d) => {
      try {
        return { name: d, sql: readFileSync(join(MIGRATIONS_DIR, d, 'migration.sql'), 'utf8') };
      } catch {
        return { name: d, sql: '' };
      }
    })
    .filter((m) => m.sql.length > 0);
}

/** Strip SQL comments so prose about a function is not mistaken for a call. */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '');
}

const migrations = allMigrationSql();
const corpus = migrations.map((m) => ({ ...m, code: stripSqlComments(m.sql) }));
const allCode = corpus.map((m) => m.code).join('\n');

describe('T0-8 — migrations must create every extension they depend on', () => {
  it('finds the migrations directory', () => {
    expect(migrations.length).toBeGreaterThan(10);
  });

  for (const { fn, extension } of EXTENSION_FUNCTIONS) {
    // Word-boundary + open paren: `digest(` but not `my_digest(` or `digested`.
    const callSite = new RegExp(`(?<![A-Za-z0-9_])${fn}\\s*\\(`);
    const users = corpus.filter((m) => callSite.test(m.code)).map((m) => m.name);
    if (users.length === 0) continue;

    it(`${fn}() is used, so some migration must CREATE EXTENSION ${extension}`, () => {
      const creates = new RegExp(
        `CREATE\\s+EXTENSION\\s+(IF\\s+NOT\\s+EXISTS\\s+)?"?${extension}"?`,
        'i',
      ).test(allCode);

      expect(
        creates,
        `${fn}() is called in ${users.join(', ')} but no migration runs ` +
          `CREATE EXTENSION ${extension}. PL/pgSQL bodies are not resolved until they EXECUTE, ` +
          'so the migration chain will apply cleanly and then fail at runtime with ' +
          `"function ${fn}(...) does not exist" — and if the caller swallows its errors ` +
          '(writeAudit does, deliberately), the feature is silently dead.',
      ).toBe(true);
    });
  }

  it('pgcrypto specifically, because the audit chain cannot work without it', () => {
    // Called out on its own: this is the one that shipped broken, and the
    // consequence — an empty tamper-evident audit trail — is the kind of thing
    // nobody notices until it is needed as evidence.
    expect(/(?<![A-Za-z0-9_])digest\s*\(/.test(allCode)).toBe(true);
    expect(/CREATE\s+EXTENSION\s+(IF\s+NOT\s+EXISTS\s+)?"?pgcrypto"?/i.test(allCode)).toBe(true);
  });
});
