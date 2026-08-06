#!/usr/bin/env tsx
// SVT-WAVE-KMS-PROVIDER-2026-05 — KEK re-wrap script (backend-resident).
//
// Walks every column in the database that holds envelope-encrypted PII (the
// `*_enc Bytes` columns), decrypts each cell with the OLD KEK, re-encrypts it
// with the NEW KEK, and writes the new blob back. The KEK never appears in
// the database — the wrapped DEK does, and that's what we replace.
//
// Why this script exists
// ----------------------
// Lazy re-wrap (rotate KEK on next write only) leaves the security boundary
// equal to the WEAKEST historical KEK forever: an attacker who recovers an
// old KEK can still unwrap any record that hasn't been touched since. After a
// suspected KEK compromise, this script must be run end-to-end so the
// compromised KEK can be DESTROYED in the KMS provider.
//
// Usage
// -----
//   pnpm --filter backend tsx scripts/rewrap-secrets.ts --dry-run
//   pnpm --filter backend tsx scripts/rewrap-secrets.ts \
//        --old-kek-id <id> --new-kek-id <id>
//
// Why this lives under apps/backend/scripts/ and not infra/scripts/:
//   - the script depends on @prisma/client and on the encryption helpers
//     under apps/backend/src; pnpm resolves those only inside the backend
//     workspace. `infra/scripts/rewrap-secrets.ts` is a thin shim that
//     re-execs this file via tsx.
//
// Environment
// -----------
//   - The OLD KEK must still be loadable by the current KMS instance (it
//     must unwrap successfully). For LocalKms that means KMS_KEK_BASE64
//     points at the OLD key; for AwsKmsKms it means AWS retains the old
//     key version in Enabled state.
//   - The NEW KEK must be the *active* one for fresh wraps. The script
//     re-encrypts via the standard encryptField() path, so whatever
//     getKms() resolves to is the new KEK.
//
// Idempotency / crash recovery
// ----------------------------
// Progress is persisted in `kek_rotation_progress`. Each (table, column,
// row_id) tuple is written when the row has been successfully re-wrapped.
// On --resume (always honoured), the script SKIPs any tuple already in
// the progress table.
//
// Transactions are per-batch (default 500 rows). Within a batch we
// read + decrypt + re-encrypt + update atomically, then mark the batch
// complete in the progress table.

import { PrismaClient, Prisma } from '@prisma/client';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decryptFieldRaw, encryptField, envelopeKekId } from '../src/shared/encryption.js';
import { getKms } from '../src/config/kms.js';
import { logger } from '../src/config/logger.js';

// Minimal argv parser — avoid a dep on `commander` to keep this script
// self-contained. Recognises --flag, --flag value, --flag=value.
function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || !a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[a.slice(2)] = next;
      i++;
    } else {
      out[a.slice(2)] = true;
    }
  }
  return out;
}

// ----------------------------------------------------------------------------
// Schema of encrypted columns. Discovered manually from prisma/schema.prisma
// (grep '_enc\\s\\+Bytes'). Keep this list in sync — if a new *_enc column
// lands without an entry here, the schema-coverage assertion in the
// rewrap-secrets spec catches it.
// ----------------------------------------------------------------------------
export type EncryptedColumn = {
  /** Table name (DB-side, snake_case). */
  table: string;
  /** Primary-key column name. All current targets use `id UUID`. */
  pk: string;
  /** The Bytes column holding the envelope-encrypted payload. */
  column: string;
  /** True if the column is nullable — controls the read-side filter. */
  nullable: boolean;
};

export const ENCRYPTED_COLUMNS: EncryptedColumn[] = [
  { table: 'users', pk: 'id', column: 'mfa_secret_enc', nullable: true },
  { table: 'students', pk: 'id', column: 'name_in_passport_enc', nullable: false },
  { table: 'student_identifications', pk: 'id', column: 'document_number_enc', nullable: false },
  { table: 'student_visas', pk: 'id', column: 'visa_number_enc', nullable: false },
  { table: 'student_regulator_identifiers', pk: 'id', column: 'value_enc', nullable: false },
  { table: 'student_dependents', pk: 'id', column: 'passport_number_enc', nullable: true },
  { table: 'student_contacts', pk: 'id', column: 'annual_income_minor_enc', nullable: true },
  { table: 'insurance_records', pk: 'id', column: 'policy_number_enc', nullable: false },
  { table: 'audit_logs', pk: 'id', column: 'before_enc', nullable: true },
  { table: 'audit_logs', pk: 'id', column: 'after_enc', nullable: true },
];

export type RewrapArgs = {
  oldKekId?: string;
  newKekId?: string;
  dryRun: boolean;
  batchSize: number;
  resume: boolean;
  // SVT-WAVE-KMS-PROVIDER-2026-05 — P0-K2 tenant scoping. When set, only
  // rows whose `tenant_id` matches are re-wrapped. Lets the operator
  // schedule a large tenant separately or parallelise across tenants via
  // xargs -P N. See infra/docs/runbooks/kek-rotation.md phase 4.
  tenantId?: string;
  // SVT-WAVE-KMS-PROVIDER-2026-05 — D2 table scoping. When set, ONLY the
  // matching table is re-wrapped (all columns under that table). Lets the
  // operator stage rotations one table at a time (e.g. start with
  // `audit_logs` which has the highest row count and the most KMS-call
  // budget impact). Matches against `EncryptedColumn.table` exactly —
  // unknown table names fail fast at startup rather than silently no-op.
  table?: string;
};

/**
 * Re-wrap one table/column pair. Returns the count of rows touched.
 *
 * Behaviour:
 *   - Reads rows where (column IS NOT NULL) AND (id NOT IN progress_table)
 *     in batches.
 *   - For each row: decryptFieldRaw with current KMS (must be able to
 *     unwrap the OLD KEK), then encryptField with current KMS (which now
 *     wraps under the NEW KEK).
 *   - Writes the new blob and the progress row inside a single transaction.
 *   - --dry-run: decrypts to verify readability but writes NOTHING.
 */
export async function rewrapColumn(
  prisma: PrismaClient,
  col: EncryptedColumn,
  args: RewrapArgs,
): Promise<number> {
  const tableId = Prisma.raw(`"${col.table}"`);
  const colId = Prisma.raw(`"${col.column}"`);
  const pkId = Prisma.raw(`"${col.pk}"`);
  // SVT-CRYPTO-2026-08 — the KEK new writes are wrapped under. Rows whose v2
  // envelope already names it are skipped (see the loop below), which makes a
  // re-run cheap and therefore makes the whole operation safely resumable.
  const activeKekId = getKms().rotateKekId();
  let touched = 0;
  let cursor: string | null = null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const cursorClause = cursor
      ? Prisma.sql`AND t.${pkId}::text > ${cursor}`
      : Prisma.empty;
    // Tenant scope (optional). Tables without a tenant_id column (e.g.
    // global lookups; none today, but defensive) are silently included.
    // The kek-rotation runbook documents per-tenant scheduling.
    const tenantClause = args.tenantId
      ? Prisma.sql`AND t.tenant_id::text = ${args.tenantId}`
      : Prisma.empty;
    // Pull a page of rows that are NOT yet in progress for this column.
    // Using a left-anti-join via NOT EXISTS keeps the resume path cheap
    // (single index lookup per candidate row).
    const rows: { id: string; blob: Buffer }[] = await prisma.$queryRaw`
      SELECT t.${pkId}::text AS id, t.${colId} AS blob
        FROM ${tableId} t
       WHERE t.${colId} IS NOT NULL
         ${cursorClause}
         ${tenantClause}
         AND NOT EXISTS (
           SELECT 1 FROM "kek_rotation_progress" p
            WHERE p.table_name = ${col.table}
              AND p.column_name = ${col.column}
              AND p.row_id = t.${pkId}::text
         )
       ORDER BY t.${pkId}::text
       LIMIT ${args.batchSize}
    `;
    if (rows.length === 0) break;

    // Decrypt + re-encrypt OUTSIDE the DB transaction (these are pure
    // CPU + remote KMS calls). Doing them inside would hold a write
    // transaction open across network IO.
    const rewrapped: { id: string; newBlob: Buffer }[] = [];
    let skippedAlreadyCurrent = 0;
    for (const r of rows) {
      // SVT-CRYPTO-2026-08 — v2 envelopes record the KEK that wrapped them, so
      // a row already under the ACTIVE key needs no work. Skipping those turns
      // a re-run from "decrypt + re-encrypt every row again" into a cheap scan,
      // which matters because rewrap is exactly the operation you want to be
      // able to resume after an interruption without redoing everything.
      // Legacy v1 blobs return null and are always rewrapped (that is how they
      // acquire an id in the first place).
      if (envelopeKekId(r.blob) === activeKekId) {
        skippedAlreadyCurrent += 1;
        continue;
      }
      const plain = await decryptFieldRaw(r.blob);
      const newBlob = await encryptField(plain);
      // Defensive: confirm a round-trip on the NEW blob before persisting.
      // Catches the (extremely unlikely) case where the new KEK fails to
      // wrap a fresh DEK.
      const roundtrip = await decryptFieldRaw(newBlob);
      if (!roundtrip.equals(plain)) {
        throw new Error(
          `rewrap-secrets: round-trip verification FAILED for ${col.table}.${col.column} id=${r.id} — refusing to write`,
        );
      }
      rewrapped.push({ id: r.id, newBlob });
    }

    if (!args.dryRun) {
      await prisma.$transaction(async (tx) => {
        for (const w of rewrapped) {
          await tx.$executeRaw`
            UPDATE ${tableId}
               SET ${colId} = ${w.newBlob}
             WHERE ${pkId}::text = ${w.id}
          `;
          await tx.$executeRaw`
            INSERT INTO "kek_rotation_progress" (table_name, column_name, row_id, old_kek_id, new_kek_id, rewrapped_at)
            VALUES (${col.table}, ${col.column}, ${w.id}, ${args.oldKekId ?? null}, ${args.newKekId ?? null}, NOW())
            ON CONFLICT (table_name, column_name, row_id) DO NOTHING
          `;
        }
      });
    }

    touched += rows.length;
    cursor = rows[rows.length - 1]!.id;
    logger.info(
      {
        table: col.table,
        column: col.column,
        batchSize: rows.length,
        rewrapped: rewrapped.length,
        // SVT-CRYPTO-2026-08 — rows already wrapped under the active KEK.
        // On a resumed run this should be most of the batch.
        skippedAlreadyCurrent,
        totalForColumn: touched,
        dryRun: args.dryRun,
      },
      'rewrap-secrets: batch complete',
    );
  }
  return touched;
}

export async function runRewrap(args: RewrapArgs, prisma = new PrismaClient()): Promise<{
  totals: Record<string, number>;
  grandTotal: number;
}> {
  // Sanity-check the KMS is reachable BEFORE we touch any rows — fail fast.
  const kms = getKms();
  logger.info(
    { activeKekId: kms.rotateKekId(), provider: process.env.KMS_PROVIDER ?? 'local' },
    'rewrap-secrets: KMS ready',
  );

  // D2 --table scoping. Fail fast on unknown table names so an operator
  // typo (e.g. --table user instead of users) doesn't silently no-op the
  // rotation and leave half the DB on the old KEK.
  let columns = ENCRYPTED_COLUMNS;
  if (args.table) {
    columns = ENCRYPTED_COLUMNS.filter((c) => c.table === args.table);
    if (columns.length === 0) {
      const known = [...new Set(ENCRYPTED_COLUMNS.map((c) => c.table))].sort().join(', ');
      throw new Error(
        `rewrap-secrets: --table='${args.table}' does not match any encrypted column. ` +
          `Known tables: ${known}`,
      );
    }
  }

  const totals: Record<string, number> = {};
  let grandTotal = 0;
  for (const col of columns) {
    const key = `${col.table}.${col.column}`;
    const n = await rewrapColumn(prisma, col, args);
    totals[key] = n;
    grandTotal += n;
  }
  return { totals, grandTotal };
}

async function main() {
  const raw = parseArgs(process.argv.slice(2));
  if (raw['help'] === true || raw['h'] === true) {
    process.stdout.write(
      'Usage: pnpm --filter backend tsx scripts/rewrap-secrets.ts [options]\n' +
        '\n' +
        '  --old-kek-id <id>   identifier of the KEK currently wrapping ciphertext (audit metadata)\n' +
        '  --new-kek-id <id>   identifier of the KEK that should wrap going forward (audit metadata)\n' +
        '  --dry-run           decrypt every row to verify readability; write nothing\n' +
        '  --resume            continue after a previous crash (default; kek_rotation_progress is always consulted)\n' +
        '  --batch-size <n>    rows per batch (default 500)\n' +
        '  --tenant <id>       only re-wrap rows whose tenant_id matches (P0-K2; supports parallel xargs -P N)\n' +
        '  --table <name>      only re-wrap the named table (D2; staggered rollout — fails fast on unknown table)\n',
    );
    return;
  }
  const batchSize = Number.parseInt(String(raw['batch-size'] ?? '500'), 10);
  const args: RewrapArgs = {
    oldKekId: typeof raw['old-kek-id'] === 'string' ? raw['old-kek-id'] : undefined,
    newKekId: typeof raw['new-kek-id'] === 'string' ? raw['new-kek-id'] : undefined,
    dryRun: raw['dry-run'] === true,
    resume: raw['resume'] === true,
    batchSize: Number.isFinite(batchSize) && batchSize > 0 ? batchSize : 500,
    tenantId: typeof raw['tenant'] === 'string' ? raw['tenant'] : undefined,
    table: typeof raw['table'] === 'string' ? raw['table'] : undefined,
  };

  logger.info(args, 'rewrap-secrets: starting');
  const prisma = new PrismaClient();
  try {
    const { totals, grandTotal } = await runRewrap(args, prisma);
    logger.info({ totals, grandTotal, dryRun: args.dryRun }, 'rewrap-secrets: complete');
  } finally {
    await prisma.$disconnect();
  }
}

// Only run when invoked directly (not when imported by tests).
//
// SVT-CI-2026-08 — this used to be
//   import.meta.url.endsWith(argv1.replace(/\\/g, '/'))
// which is wrong in BOTH directions and failed silently either way:
//
//   - `import.meta.url` is a file:// URL, so any character that percent-encodes
//     (a space, most commonly) makes the suffix compare fail. On a checkout
//     path containing a space the script parsed its args, decided it was being
//     imported, ran nothing and exited 0. For a KEK re-wrap after a suspected
//     compromise that is the worst possible failure mode: the operator sees a
//     clean exit and destroys a KEK that is still wrapping live ciphertext.
//   - When `process.argv[1]` is absent it defaults to '', and every string
//     ends with '', so the guard flips to true and `main()` fires inside any
//     importing process.
//
// Compare resolved real paths instead. realpathSync normalises symlinks and
// drive-letter case on Windows; the try/catch covers argv[1] not existing.
const isDirect = (() => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) return false;
    const self = realpathSync(fileURLToPath(import.meta.url));
    return self === realpathSync(resolve(argv1));
  } catch {
    return false;
  }
})();
if (isDirect) {
  main().catch((err) => {
    logger.error({ err }, 'rewrap-secrets: fatal');
    process.exit(1);
  });
}
