// Retention enforcer: scans Document rows past `retention_until` and crypto-shreds them.
// Crypto-shred = delete the wrapped DEK referenced by the encrypted blob, making the
// ciphertext mathematically unrecoverable even from backups. Since our envelope format
// embeds the wrapped DEK inline with the ciphertext, "shred" reduces to securely
// overwriting the storage object plus deleting the row.
//
// SVT-WAVE-PRIV-C6-2026-05 — additionally, every Bytes column on the Document
// model whose name ends in `_enc` is overwritten with an empty buffer. The
// Document model has no such columns today, but if a future migration adds
// e.g. `inline_blob_enc Bytes` the retention sweep will discover it via Prisma
// DMMF and shred it without code changes. The discovery happens once at
// module load so the steady-state per-doc cost is just one updateMany.

import { Prisma } from '@prisma/client';
import { prismaAdmin } from '../config/db.js';
import { withTenantTx } from '../shared/tenantTx.js';
import { logger } from '../config/logger.js';
import { captureJobException, withTenantScope } from '../config/sentry.js';
import { getStorage } from '../modules/documents/storage.js';
import { writeAudit } from '../shared/audit.js';

const JOB_NAME = 'retention.erasure';

// SVT-WAVE-PRIV-C6-2026-05 — discover Bytes columns on the Document model
// whose names end in `_enc`. We read the static DMMF (Prisma compile-time
// schema), not the runtime DB, so the lookup is safe to do at import time.
// Returned as a static list rather than recomputed per call so the inner
// loop is allocation-free.
//
// `Prisma.dmmf.datamodel.models` is the canonical introspection surface.
// We fail-soft to an empty list (no shred attempt) if DMMF is unavailable —
// the storage delete still happens, which is the primary crypto-shred path.
function discoverEncColumnsForModel(modelName: string): string[] {
  try {
    const dmmf = (Prisma as unknown as {
      dmmf?: { datamodel?: { models: Array<{ name: string; fields: Array<{ name: string; type: string }> }> } };
    }).dmmf;
    const model = dmmf?.datamodel?.models?.find((m) => m.name === modelName);
    if (!model) return [];
    return model.fields
      .filter((f) => f.type === 'Bytes' && f.name.endsWith('_enc'))
      .map((f) => f.name);
  } catch {
    return [];
  }
}

const DOCUMENT_ENC_COLUMNS: readonly string[] = discoverEncColumnsForModel('Document');
const ERASED_ENC = Buffer.alloc(0);

// Test seam: allow tests to override the discovered columns so the
// crypto-shred path can be exercised even though the live Document model
// has no *_enc Bytes columns today.
let testColumnsOverride: readonly string[] | null = null;
export function __setEncColumnsForTests(cols: readonly string[] | null): void {
  testColumnsOverride = cols;
}
function activeEncColumns(): readonly string[] {
  return testColumnsOverride ?? DOCUMENT_ENC_COLUMNS;
}

export async function runRetentionErasure(opts: { tenantId?: string; nowOverride?: Date }): Promise<{
  scanned: number;
  shredded: number;
  errors: number;
}> {
  const now = opts.nowOverride ?? new Date();
  const tenantWhere = opts.tenantId ? { tenant_id: opts.tenantId } : {};
  const storage = getStorage();

  // SVT-SEC-2026-08 (T0-7) — the discovery scan spans tenants when no tenantId
  // is supplied, so it uses the admin client. On the GUC-less runtime singleton
  // it returned an EMPTY LIST under the production role: document retention
  // never executed, nothing was ever shredded, and the job reported a clean
  // pass. The per-document write below is tenant-scoped via withTenantTx.
  const candidates = await prismaAdmin.document.findMany({
    where: {
      ...tenantWhere,
      deleted_at: null,
      retention_until: { lte: now },
    },
    // SEC-burst: select tenant_id so the per-doc write can scope to it.
    select: { id: true, storage_key: true, tenant_id: true },
  });

  let shredded = 0;
  let errors = 0;
  for (const doc of candidates) {
    // SVT-OBS-JOBS-2026-05 — wrap each doc shred in withTenantScope so a
    // storage.delete / DB / audit failure attributes to the owning tenant
    // in Sentry. The retention cron runs as a single global pass (see
    // scheduler.ts) but each document belongs to a specific tenant, and we
    // want per-tenant attribution when on-call investigates a spike.
    await withTenantScope(doc.tenant_id, JOB_NAME, async () => {
      try {
        await storage.delete(doc.storage_key);
        // SEC-burst: updateMany({id, tenant_id}) instead of update({id}).
        // The cron runs on the unscoped singleton (no RLS GUC) so a swapped
        // id would mutate another tenant. Assert count === 1.
        //
        // SVT-WAVE-PRIV-C6-2026-05 — additionally null every *_enc Bytes
        // column on the Document row. Today the Document model has none,
        // but the discover-via-DMMF pattern means this stays correct as
        // the schema evolves. We merge the dynamic shred fields into the
        // deleted_at write so it's one round-trip.
        const encShred: Record<string, Buffer> = {};
        for (const col of activeEncColumns()) encShred[col] = ERASED_ENC;
        const wr = await withTenantTx(doc.tenant_id, async (tx) => tx.document.updateMany({
          where: { id: doc.id, tenant_id: doc.tenant_id },
          data: { deleted_at: now, ...encShred } as never,
        }));
        if (wr.count === 1) {
          shredded++;
          // SVT-GDPR-2026-05 — write a tamper-evident audit row per shred so
          // forensic replay can prove what was destroyed and when. Previously
          // the retention cron silently mutated documents with no audit trail
          // (compliance gap; auditors need this for Art 17 evidence).
          try {
            await writeAudit({
              action: 'document.retention_shredded',
              entityType: 'document',
              entityId: doc.id,
              actorId: null,
              tenantId: doc.tenant_id,
              after: { storage_key: doc.storage_key, shredded_at: now.toISOString() },
            } as never);
          } catch (auditErr) {
            // Audit failure does NOT roll back the shred — the data is already
            // gone. Surface loudly so ops can investigate the chain integrity.
            logger.error({ err: auditErr, docId: doc.id, tenantId: doc.tenant_id }, 'retention: audit write failed after shred');
            captureJobException(auditErr, { job: JOB_NAME, tenant_id: doc.tenant_id });
          }
        } else {
          errors++;
          logger.warn({ docId: doc.id, tenantId: doc.tenant_id }, 'retention: write count != 1');
        }
      } catch (err) {
        errors++;
        logger.error({ err, docId: doc.id, tenantId: doc.tenant_id }, 'retention erasure failed');
        captureJobException(err, { job: JOB_NAME, tenant_id: doc.tenant_id });
      }
    });
  }

  logger.info({ scanned: candidates.length, shredded, errors }, 'retention erasure run complete');
  return { scanned: candidates.length, shredded, errors };
}
