// SVT-WAVE-DSAR-PUBLIC-2026-05 — public, unauthenticated DSAR intake.
//
// GDPR Art. 12 / UK DPA / India DPDP §11 require a no-friction way for any
// data subject (not just authenticated users of the consultancy's product) to
// raise an access / portability / erasure / rectification / restriction /
// objection request. The admin-only `/api/v1/dsar` surface assumed the
// counsellor was logging the request on behalf of the subject. That assumption
// breaks for subjects whose accounts were already deleted, who never had an
// account (school enquirers), or who can't get a counsellor to respond.
//
// This module is the public endpoint:
//   POST /api/v1/public/dsar
//   body: { tenant_id, subject_email, subject_type, dsar_type, request_text }
//   always 200 with a fixed message (anti-enumeration).
//
// Anti-enumeration: the response is identical whether the subject exists or
// not, so an attacker cannot probe "is alice@example.com a student of school X?"
// by submitting DSAR requests. We do NOT include any per-request token, link,
// or row id in the body.
//
// Side-effects when a match exists:
//   - DSARRequest row inserted in PENDING (30d clock starts).
//   - IN_APP CommsMessage to the tenant's first active ADMIN so they see
//     the request in the bell drawer immediately.
//   - Confirmation email to subject_email if EMAIL_PROVIDER is configured.
//   - Audit row: `dsar.public_request_received` (regardless of match).

import type { PrismaClient } from '@prisma/client';
import type { PublicDSARRequest } from '@spv/zod-schemas';

import { prisma } from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { writeAudit } from '../../shared/audit.js';
import { notifyStatusTransition } from '../../shared/transitionNotify.js';
import { env } from '../../config/env.js';
import { getProvider } from '../comms/providers/registry.js';

const DSAR_DUE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export const PUBLIC_DSAR_RESPONSE_MESSAGE =
  "If a matching subject exists, we have logged your request. You'll receive a confirmation within 24 hours.";

type ReqLike = {
  ip?: string | null;
  requestId?: string;
  header?: (name: string) => string | undefined;
};

type DB = PrismaClient;
const db = (): DB => prisma;

async function findSubject(
  tenantId: string,
  subjectType: 'student' | 'user',
  email: string,
): Promise<{ id: string } | null> {
  const lower = email.toLowerCase();
  // Both lookups must run with RLS context bound to tenantId so the policy
  // permits the read. We use the top-level prisma client (no req.db extension)
  // and bind the GUC inside a short tx.
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
    if (subjectType === 'student') {
      const row = await tx.student.findFirst({
        where: { tenant_id: tenantId, email_primary: lower, deleted_at: null },
        select: { id: true },
      });
      return row;
    }
    const row = await tx.user.findFirst({
      where: { tenant_id: tenantId, email: lower, deleted_at: null },
      select: { id: true },
    });
    return row;
  });
}

async function sendConfirmationEmail(toEmail: string, dsarType: string): Promise<void> {
  // Only send when a real provider is wired up. In dev/test EMAIL_PROVIDER=log
  // and the LogProvider just writes to pino; we still call it so the path is
  // exercised, but production gating lives in the provider, not here.
  try {
    const provider = getProvider('EMAIL');
    await provider.send({
      to: toEmail,
      subject: 'We received your data request',
      body:
        `Hello,\n\n` +
        `We have received your ${dsarType} request and will respond within 30 days as required by data-protection law.\n\n` +
        `If you did not submit this request, you can ignore this email — no action will be taken without further verification.\n`,
      from: env.EMAIL_FROM,
    });
  } catch (err) {
    // Best-effort: a flaky email provider must not crash the intake.
    logger.warn({ err }, 'public DSAR: confirmation email failed (non-fatal)');
  }
}

export const publicDsarService = {
  /**
   * Handle one public DSAR submission. Always resolves; the response body is
   * the caller's responsibility (and is constant). On a subject match, side
   * effects fire after we resolve so the HTTP latency stays flat regardless.
   */
  async submit(req: ReqLike, body: PublicDSARRequest): Promise<void> {
    const { tenant_id, subject_email, subject_type, dsar_type, request_text } = body;

    // Audit FIRST, before lookup, so an attacker probing for tenants can't
    // tell from log presence/absence whether a tenant exists.
    //
    // SVT-SEC-2026-06 — this endpoint is UNAUTHENTICATED and the tenant_id is
    // attacker-supplied, so we must NOT chain this row under the claimed tenant:
    // doing so let anyone append attacker-controlled rows (dsar_type, email
    // domain) into a victim tenant's tamper-evident audit chain (log injection /
    // forensic-noise pollution). Land it on the tenant-less system chain
    // (tenant_id: null) instead and record the claimed tenant as data in `after`.
    // Anti-enumeration is preserved (we always write the same row, same timing);
    // the legitimate tenant still gets its own chained record on a real match
    // (the DSARRequest insert below, under verified RLS context).
    await writeAudit({
      action: 'dsar.public_request_received',
      tenant_id: null,
      entity_type: 'dsar_request',
      entity_id: null,
      ip: req.ip ?? null,
      ua: req.header?.('user-agent') ?? null,
      request_id: req.requestId ?? null,
      // `after` lands inside the envelope-encrypted snapshot. Do NOT log the
      // request_text raw — it could contain PII the subject pasted in. Keep
      // a length-only marker; the DSARRequest row (when created) holds the
      // full text under the tenant's normal audit chain.
      after: {
        claimed_tenant_id: tenant_id,
        subject_type,
        subject_email_domain: subject_email.split('@')[1] ?? null,
        dsar_type,
        request_text_length: request_text.length,
      },
    });

    let subject: { id: string } | null;
    try {
      subject = await findSubject(tenant_id, subject_type, subject_email);
    } catch (err) {
      // RLS misconfig / tenant not existing → treat as "no match". Anti-
      // enumeration: never let the response branch on this.
      logger.warn({ err, tenant_id }, 'public DSAR: subject lookup failed');
      return;
    }

    if (!subject) {
      // Unknown subject — silently drop. Audit row already written above.
      return;
    }

    // Match. Insert PENDING DSARRequest under the tenant's RLS context.
    const requested_at = new Date();
    const due_by = new Date(requested_at.getTime() + DSAR_DUE_DAYS * DAY_MS);

    let createdId: string | null = null;
    try {
      const created = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant_id}, true)`;
        return tx.dSARRequest.create({
          data: {
            tenant_id,
            subject_type,
            subject_id: subject!.id,
            type: dsar_type,
            status: 'PENDING',
            requested_at,
            due_by,
            // Persist the subject-supplied narrative as `notes` so the admin
            // sees what was requested. The text is part of the tenant's data
            // (subject to that tenant's retention policy) — never globally.
            notes: request_text,
          },
        });
      });
      createdId = created.id;
    } catch (err) {
      logger.error({ err, tenant_id }, 'public DSAR: DSARRequest insert failed');
      return;
    }

    // Fan-out: in-app to admin + email to subject. Both best-effort.
    setImmediate(() => {
      void notifyStatusTransition({
        tenantId: tenant_id,
        entityId: createdId!,
        source: 'dsar',
        title: `Public DSAR received (${dsar_type})`,
        body: `A public DSAR submission of type ${dsar_type} was received and is pending review.`,
        href: `/dsar?open=${createdId}`,
        preferUserId: null,
        actorId: null,
      });
    });
    setImmediate(() => {
      void sendConfirmationEmail(subject_email, dsar_type);
    });
  },
};

export const _internal = { findSubject, sendConfirmationEmail };
