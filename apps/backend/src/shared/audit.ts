// Append-only audit log writer.
//
// Schema (see prisma/schema.prisma — AuditLog):
//   - tenant_id, actor_id, actor_email_hash
//   - action (e.g. 'auth.login.success'), entity_type, entity_id, entity_version
//   - before_enc, after_enc       — envelope-encrypted JSON snapshots
//   - ip_hash, ua_hash, request_id — correlation tokens (see shared/hashing.ts)
//   - prev_hash, entry_hash       — tamper-evident chain (see invariants below)
//
// Tamper-evident chain
// --------------------
// entry_hash = sha256(prev_hash || canonical_payload)
//
// CANONICAL PAYLOAD (SVT-WAVE-KMS-PROVIDER-2026-05 — P2-K5):
// ---------------------------------------------------------
//   parts = [
//     tenant_id ?? '',
//     actor_id ?? '',
//     actor_email_hash ?? '',
//     action,
//     entity_type,
//     entity_id ?? '',
//     entity_version === null ? '' : String(entity_version),
//     before_enc?.toString('base64') ?? '',
//     after_enc?.toString('base64') ?? '',
//     ip_hash ?? '',
//     ua_hash ?? '',
//     request_id ?? '',
//     to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
//   ]
//   canonical_payload = Buffer.from(parts.join('\x1f'), 'utf8')
//
// CRITICAL: the timestamp is the DB-side `to_char(... AT TIME ZONE 'UTC',
// 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` rendering — microsecond precision, UTC,
// independent of session DateStyle. NEVER `new Date().toISOString()` from
// app-side code: Node `Date` is millisecond-precision and the trigger sees
// the database `now()` (microsecond). A two-source timestamp = chain break
// at replay time. See migration 20991231235984b_audit_chain_utc_timestamp
// + tests/audit-chain-utc.spec.ts for the regression coverage.
//
// The DB trigger fills prev_hash and entry_hash automatically by reading the latest row
// (FOR UPDATE) and computing the chain. We replicate the *same* algorithm here and write the
// app-side computed entry_hash too, so:
//   - the trigger remains the source of truth in the live table,
//   - replay tooling that consumes a serialised log (S3 export, WORM bucket) can recompute
//     and verify without re-running PostgreSQL.
//
// App-side note: shared/audit.ts now uses `formatUtcMicros(created_at)` which
// renders 'YYYY-MM-DDTHH:MM:SS.uuuuuuZ' (microsecond, UTC). This is what the
// DB trigger emits via `to_char(... AT TIME ZONE 'UTC',
// 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`, so an offline replay verifier consuming
// the DB row + the app-side canonical builder produces byte-identical output.
// JavaScript Date is millisecond-precision so the trailing micros are always
// '000' on the app-side path; the format pin defends against a future change
// that hands the verifier a DB-native microsecond timestamp.
//
// We INSERT in a *separate* prisma transaction (the top-level prisma client, not any
// caller-provided tx). The audit row must persist even if the business transaction rolls
// back — otherwise a "rejected DSAR write" would leave no trace. Errors are swallowed and
// logged via pino; we never throw to the caller because that would let the audit subsystem
// take down a successful business operation.

import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../config/db.js';
import { logger } from '../config/logger.js';
import { encryptJson } from './encryption.js';
import { emailHashHmac, hashIp, hashUa } from './hashing.js';
import { withTenantTx } from './tenantTx.js';

export type AuditEvent = {
  tenantId?: string | null;
  actorId?: string | null;
  actorEmail?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  entityVersion?: number | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  ua?: string | null;
  requestId?: string | null;
};

// Loose input accepted by writeAudit(loose). Auth-domain callers pre-hash IP/UA/
// email and use snake_case; other callers use camelCase + raw values. We normalise
// in writeAuditImpl so either idiom produces a fully-populated row. `metadata` is
// folded into `after` so forensic context lands in the encrypted snapshot.
export type AuditEventLoose = {
  action: string;
  // camelCase + raw (re-hashed by writeAuditImpl)
  tenantId?: string | null;
  actorId?: string | null;
  actorEmail?: string | null;
  entityType?: string;
  entityId?: string | null;
  entityVersion?: number | null;
  ip?: string | null;
  ua?: string | null;
  requestId?: string | null;
  before?: unknown;
  after?: unknown;
  // snake_case + pre-hashed (passed through verbatim)
  tenant_id?: string | null;
  actor_id?: string | null;
  actor_email_hash?: string | null;
  entity_type?: string;
  entity_id?: string | null;
  entity_version?: number | null;
  ip_hash?: string | null;
  ua_hash?: string | null;
  request_id?: string | null;
  metadata?: Record<string, unknown> | null;
};

/**
 * Compute the canonical payload that feeds the chain hash. Order is fixed and documented so
 * external verifiers can reproduce it byte-for-byte. We only include the *hashed* PII inputs,
 * never the raw values.
 *
 * SVT-WAVE-KMS-PROVIDER-2026-05 — P1-K5: the timestamp is serialised at
 * MICROSECOND precision, UTC-anchored, using the explicit literal format
 * 'YYYY-MM-DDTHH:MM:SS.uuuuuuZ'. This matches the DB-side rendering
 *   to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
 * used by audit_logs_hash_chain() (migration 20991231235984b).
 *
 * SVT-WAVE-AUDIT-FORENSIC-2026-06: this payload includes the forensic
 * correlation hashes (actor_email_hash, ip_hash, ua_hash). The DB trigger's
 * v2 canonical payload now ALSO covers them (migration
 * 20991231235994_audit_chain_forensic_fields), so those fields are part of
 * the tamper-evident chain — a DB-level rewrite of who/from-where is now
 * detected by audit_logs_verify(). NOTE: the trigger is still the sole
 * authoritative hash; this app-side value differs in framing (id, hex vs
 * base64, '|' vs \x1f) and is overwritten on insert. It exists for a future
 * offline replay verifier and to keep the protected field-set documented in
 * one place.
 *
 * Rationale: `Date.prototype.toISOString()` always emits UTC (`Z`), so it is
 * NOT directly affected by `process.env.TZ`. BUT it only emits millisecond
 * precision, while Postgres TIMESTAMPTZ holds microseconds. A future change
 * that hands an offline replay verifier the DB microsecond timestamp would
 * silently break verification because the app-side payload would have rounded
 * to milliseconds. Pinning the format here protects against DST shifts,
 * locale-dependent ::text rendering, and millisecond-vs-microsecond drift.
 */
export function formatUtcMicros(d: Date): string {
  // Date stores millisecond precision; pad to microseconds with three zeros.
  // The Z is preserved verbatim from toISOString() to guarantee UTC anchoring.
  const iso = d.toISOString(); // 'YYYY-MM-DDTHH:MM:SS.sssZ'
  return iso.replace(/\.(\d{3})Z$/, '.$1000Z');
}

export function canonicalPayload(row: {
  tenant_id: string | null;
  actor_id: string | null;
  actor_email_hash: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  entity_version: number | null;
  before_enc: Buffer | null;
  after_enc: Buffer | null;
  ip_hash: string | null;
  ua_hash: string | null;
  request_id: string | null;
  created_at: Date;
}): Buffer {
  const parts = [
    row.tenant_id ?? '',
    row.actor_id ?? '',
    row.actor_email_hash ?? '',
    row.action,
    row.entity_type,
    row.entity_id ?? '',
    row.entity_version === null || row.entity_version === undefined ? '' : String(row.entity_version),
    row.before_enc ? row.before_enc.toString('base64') : '',
    row.after_enc ? row.after_enc.toString('base64') : '',
    row.ip_hash ?? '',
    row.ua_hash ?? '',
    row.request_id ?? '',
    formatUtcMicros(row.created_at),
  ];
  return Buffer.from(parts.join('\x1f'), 'utf8'); // unit-separator delimits unambiguously
}

function chainHash(prev: string | null, payload: Buffer): string {
  return createHash('sha256').update(prev ?? '').update(payload).digest('hex');
}

/**
 * Persist an audit event. Never throws; failures are logged.
 *
 * The DB trigger will (and must) overwrite prev_hash / entry_hash with its own values. The
 * values we write are correct under the same algorithm, but the trigger holds an exclusive
 * lock on the predecessor row to guarantee linearisability under concurrent inserts; we can't
 * reproduce that race-free from app code, so the trigger always wins.
 */
/**
 * Backward-compatible overload: callers may pass either `writeAudit(event)` or
 * `writeAudit(req, partialEvent)`. The req-form lifts ip/ua/requestId/actor from
 * the Express request automatically so controllers don't have to repeat themselves.
 */
type ReqLike = {
  ip?: string | null;
  user?: { sub?: string; tid?: string };
  requestId?: string;
  header?: (name: string) => string | undefined;
};
// `entityType` is also made optional here: many callers pass `entity_type`
// (snake_case) instead. The implementation folds either spelling — see the
// `entityType: b.entityType ?? b.entity_type ?? ''` line below.
type PartialEvent = Omit<
  AuditEvent,
  'tenantId' | 'actorId' | 'ip' | 'ua' | 'requestId' | 'entityType'
> &
  Partial<
    Pick<AuditEvent, 'tenantId' | 'actorId' | 'ip' | 'ua' | 'requestId' | 'entityType'>
  > & {
    // snake_case aliases used by some controllers
    entity_type?: string;
    entity_id?: string | null;
    entity_version?: number | null;
    actorEmail?: string | null;
  };

export async function writeAudit(event: AuditEventLoose): Promise<void>;
export async function writeAudit(req: ReqLike, fields: PartialEvent): Promise<void>;
export async function writeAudit(
  a: AuditEventLoose | ReqLike,
  b?: PartialEvent,
): Promise<void> {
  if (b !== undefined) {
    // 2-arg form: lift ip/ua/actor from the request, accept snake_case entity_* aliases.
    const event: AuditEvent = {
      tenantId: (a as ReqLike).user?.tid ?? null,
      actorId: (a as ReqLike).user?.sub ?? null,
      ip: (a as ReqLike).ip ?? null,
      ua: (a as ReqLike).header?.('user-agent') ?? null,
      requestId: (a as ReqLike).requestId ?? null,
      action: b.action,
      entityType: b.entityType ?? b.entity_type ?? '',
      entityId: b.entityId ?? b.entity_id ?? null,
      entityVersion: b.entityVersion ?? b.entity_version ?? null,
      before: b.before,
      after: b.after,
      actorEmail: b.actorEmail ?? null,
    };
    return writeAuditImpl(event);
  }
  // 1-arg form: normalise the loose input (snake_case + pre-hashed) into the
  // canonical row shape. `metadata` folds into `after` so it lands in the
  // envelope-encrypted snapshot. Pre-hashed inputs win over raw because callers
  // that pre-hash do so deliberately (auth domain).
  const loose = a as AuditEventLoose;
  return writeAuditImpl({
    action: loose.action,
    tenantId: loose.tenantId ?? loose.tenant_id ?? null,
    actorId: loose.actorId ?? loose.actor_id ?? null,
    actorEmail: loose.actorEmail ?? null,
    entityType: loose.entityType ?? loose.entity_type ?? '',
    entityId: loose.entityId ?? loose.entity_id ?? null,
    entityVersion: loose.entityVersion ?? loose.entity_version ?? null,
    before: loose.before,
    after: mergeMetadata(loose.after, loose.metadata),
    ip: loose.ip ?? null,
    ua: loose.ua ?? null,
    requestId: loose.requestId ?? loose.request_id ?? null,
    // pre-hashed pass-throughs (consumed by writeAuditImpl via a side channel)
    ...(loose.actor_email_hash !== undefined ? { __actor_email_hash: loose.actor_email_hash } : {}),
    ...(loose.ip_hash !== undefined ? { __ip_hash: loose.ip_hash } : {}),
    ...(loose.ua_hash !== undefined ? { __ua_hash: loose.ua_hash } : {}),
  } as AuditEvent & { __actor_email_hash?: string | null; __ip_hash?: string | null; __ua_hash?: string | null });
}

function mergeMetadata(after: unknown, metadata: Record<string, unknown> | null | undefined): unknown {
  if (metadata == null || Object.keys(metadata).length === 0) return after;
  if (after === undefined) return metadata;
  if (typeof after === 'object' && after !== null && !Array.isArray(after)) {
    return { ...(after as Record<string, unknown>), ...metadata };
  }
  return { after, metadata };
}

// SVT-WAVE-MEDIUM-AUDIT-REDACT-2026-05 — deep-strip envelope-encrypted +
// raw PII fields from audit before/after blobs BEFORE encryption. The audit
// row is itself envelope-encrypted, but storing a second copy of the same
// per-tenant DEK ciphertext (passport_number_enc Buffer values) means a KEK
// rotation crypto-shreds the source table but NOT the audit. Strip the
// fields so the audit captures the shape of the change without the secret.
//
// Stripped keys:
//   - any *_enc Buffer (envelope ciphertext)
//   - passport_number / national_id / visa_number / policy_number / mfa_secret
//   - password / password_hash / token / *_token
//   - dob / date_of_birth / ssn / bank_account / iban / swift / card_number
//   - sponsor_income
const AUDIT_REDACTED_KEYS = new Set([
  'passport_number',
  'national_id',
  'visa_number',
  'policy_number',
  'mfa_secret',
  'password',
  'password_hash',
  'token',
  'access_token',
  'refresh_token',
  'dob',
  'date_of_birth',
  'ssn',
  'bank_account',
  'bank_account_number',
  'iban',
  'swift',
  'card_number',
  'cvv',
  'cvc',
  'sponsor_income',
  'annual_income_minor_enc',
]);

function redactAuditSnapshot(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Buffer.isBuffer(value)) return '[REDACTED:Buffer]';
  if (Array.isArray(value)) return value.map(redactAuditSnapshot);
  if (typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k.endsWith('_enc')) {
      out[k] = '[REDACTED:enc]';
      continue;
    }
    if (AUDIT_REDACTED_KEYS.has(k)) {
      out[k] = '[REDACTED]';
      continue;
    }
    out[k] = redactAuditSnapshot(v);
  }
  return out;
}

async function writeAuditImpl(
  event: AuditEvent & {
    __actor_email_hash?: string | null;
    __ip_hash?: string | null;
    __ua_hash?: string | null;
  },
): Promise<void> {
  try {
    const beforeClean = event.before === undefined ? undefined : redactAuditSnapshot(event.before);
    const afterClean = event.after === undefined ? undefined : redactAuditSnapshot(event.after);
    const before_enc = beforeClean === undefined ? null : await encryptJson(beforeClean);
    const after_enc = afterClean === undefined ? null : await encryptJson(afterClean);

    const created_at = new Date();
    const partial = {
      tenant_id: event.tenantId ?? null,
      actor_id: event.actorId ?? null,
      // Pre-hashed wins over raw to support auth-domain callers that hash earlier.
      actor_email_hash:
        event.__actor_email_hash ?? (event.actorEmail ? emailHashHmac(event.actorEmail) : null),
      action: event.action,
      entity_type: event.entityType,
      entity_id: event.entityId ?? null,
      entity_version: event.entityVersion ?? null,
      before_enc,
      after_enc,
      ip_hash: event.__ip_hash ?? (event.ip ? hashIp(event.ip) : null),
      ua_hash: event.__ua_hash ?? (event.ua ? hashUa(event.ua) : null),
      request_id: event.requestId ?? null,
      created_at,
    };

    // Independent transaction: business code may have its own tx that rolls back; the audit
    // row must still land. We pass through the top-level prisma client deliberately.
    //
    // SVT-SEC-2026-08 (T0-7) — but that top-level client has no tenant GUC, and
    // the audit_logs policy is
    //
    //   USING/WITH CHECK (tenant_id = app_current_tenant() OR tenant_id IS NULL)
    //
    // so under the de-privileged production role EVERY tenant-scoped audit write
    // failed the WITH CHECK — and the catch below (correctly) swallowed it. The
    // tamper-evident chain that this product sells as forensic integrity would
    // have recorded nothing but system rows, silently, from the first day
    // DATABASE_URL pointed at `spv_app`. Dev and CI never saw it because RLS does
    // not apply to the single superuser role they run as.
    //
    // withTenantTx is still an independent transaction — it wraps its own
    // prisma.$transaction — so the "audit survives a caller rollback" property
    // above is preserved exactly. Rows with no tenant (system/global events) keep
    // the plain path and land via the `tenant_id IS NULL` branch of the policy.
    //
    // The GUC also makes the DB trigger correct rather than merely permitted:
    // audit_logs_hash_chain() chains per tenant (`WHERE tenant_id IS NOT
    // DISTINCT FROM NEW.tenant_id`) and runs as the invoker, so it needs to see
    // this tenant's rows to find the true chain head.
    const writeRow = async (tx: Prisma.TransactionClient) => {
      // NB: the DB trigger overwrites prev_hash/entry_hash and is the authority
      // (see 20991231235994). This app-side computation is the fallback for
      // databases built with `prisma db push`, which skips the raw-SQL
      // migrations that install the trigger.
      const last = await tx.auditLog.findFirst({
        orderBy: { created_at: 'desc' },
        select: { entry_hash: true },
      });
      const prev_hash = last?.entry_hash ?? null;
      const entry_hash = chainHash(prev_hash, canonicalPayload(partial));

      await tx.auditLog.create({
        data: {
          ...partial,
          prev_hash,
          entry_hash,
        },
      });
    };

    if (partial.tenant_id) {
      await withTenantTx(partial.tenant_id, writeRow);
    } else {
      await prisma.$transaction(writeRow);
    }
  } catch (err) {
    // Last-resort safety net. We must never propagate audit failures to the caller.
    logger.error(
      { err, action: event.action, entityType: event.entityType, entityId: event.entityId },
      'Audit write failed',
    );
  }
}
