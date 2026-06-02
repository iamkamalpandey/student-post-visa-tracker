// SVT-COMPLIANCE-2026-05 — Resend (and compatible) bounce/complaint webhook.
//
// Sender-reputation protection: ignore signed webhook events and you watch
// your domain reputation collapse in ~2 weeks because every retry to a hard-
// bounced address counts against you. Gmail/Yahoo 2024 thresholds: bounce
// rate < 0.4%, spam complaint rate < 0.3%. We honour both signals.
//
// Endpoint:
//   POST /api/v1/webhooks/resend
//   Headers:
//     svix-signature        — HMAC-SHA256(secret, svix-id + . + svix-timestamp + . + body)
//     svix-id, svix-timestamp
//   Body:
//     { type: 'email.bounced' | 'email.complained' | 'email.delivered' | ...
//     , data: { to: 'foo@bar.com', email_id: '<resend id>', ... } }
//
// Behaviour:
//   - email.bounced  (HARD only, soft bounces retried by Resend)
//     → flip every active User.email == bounced address: notifications_email_enabled=false
//     → audit: comms.bounced
//   - email.complained (spam button)
//     → flip + audit: comms.spam_complaint (more severe; never re-enable)
//   - Other types: 200 OK no-op (deliveries / opens / clicks).
//
// Idempotency: we don't write a suppression table in v1; flipping the user
// flag is itself idempotent. v2 should add EmailSuppression(email, source,
// suppressed_at) keyed on hash of lowercased email for cross-tenant scope.
//
// Auth: HMAC-SHA256 signature with RESEND_WEBHOOK_SECRET env. Missing secret
// in dev: log + accept (so local testing works). In prod: reject.

import { Router, type Request, type Response, raw as rawBody } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { prisma } from '../../config/db.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { writeAudit } from '../../shared/audit.js';

export const webhooksRouter: Router = Router();

// SVT-WAVE-WEBHOOK-FAILCLOSED-2026-05 / P1-WB6 (2026-05) — fail-closed in
// every environment except NODE_ENV=test. Until 2026-05 we accepted
// unsigned webhooks in development, which meant a dev laptop accidentally
// exposed to the internet would happily process attacker-forged bounce/
// complaint events and tank a user's notification settings. The old
// behaviour was indistinguishable from prod fail-open from the attacker's
// perspective.
//
// Boot-time guarantee: server.ts exits 1 when RESEND_WEBHOOK_SECRET is
// unset AND NODE_ENV != 'test', so reaching the 503 fallback below is now
// only possible under the `test` env. The fallback is preserved as a
// defence-in-depth net + so the supertest harness keeps working without
// every spec plumbing a secret through env.
//
// Signature semantics with a configured secret:
//   - missing svix-* headers           → 401
//   - bad signature                    → 401
//   - timestamp drift > 5 min          → 401
//   - good signature on a known event  → 200 + side-effects
function isSecretRequired(): boolean {
  return env.NODE_ENV !== 'test';
}

if (!process.env['RESEND_WEBHOOK_SECRET'] && isSecretRequired()) {
  logger.warn(
    'webhooks/resend: RESEND_WEBHOOK_SECRET is unset; the endpoint will return 503 until it is configured (NODE_ENV=%s).',
    env.NODE_ENV,
  );
}

// Read the secret on every request so a late-bound env (e.g. test that
// stubs the var after import) is honoured.
function readSecret(): string {
  return process.env['RESEND_WEBHOOK_SECRET'] ?? '';
}

function verifySignature(req: Request, bodyBuf: Buffer): boolean {
  const SECRET = readSecret();
  if (!SECRET) {
    // In test we keep the historical lenient path so route specs that don't
    // care about signing keep working. Every other env: caller-side guard
    // already 503'd, so reaching here is unreachable; defence-in-depth.
    if (isSecretRequired()) return false;
    logger.warn('webhooks/resend: RESEND_WEBHOOK_SECRET unset (test only — accept)');
    return true;
  }
  const id = req.header('svix-id') ?? '';
  const ts = req.header('svix-timestamp') ?? '';
  const sigHeader = req.header('svix-signature') ?? '';
  if (!id || !ts || !sigHeader) return false;
  // Reject replays > 5 min in the past.
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) return false;

  const signedPayload = `${id}.${ts}.${bodyBuf.toString('utf8')}`;
  const expected = createHmac('sha256', Buffer.from(SECRET, 'base64')).update(signedPayload).digest();
  // svix-signature header has form: "v1,<base64sig> v1,<base64sig> ..."
  // Compare against each.
  for (const part of sigHeader.split(' ')) {
    const [_v, sig] = part.split(',');
    if (!sig) continue;
    try {
      const provided = Buffer.from(sig, 'base64');
      if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

async function suppress(email: string, source: 'bounced' | 'complained'): Promise<void> {
  const norm = email.trim().toLowerCase();
  const users = await prisma.user.findMany({
    where: { email: norm, deleted_at: null },
    select: { id: true, tenant_id: true, notifications_email_enabled: true },
  });
  for (const user of users) {
    if (!user.notifications_email_enabled) continue;
    try {
      await prisma.user.update({
        where: { id: user.id },
        data: { notifications_email_enabled: false },
      });
      await writeAudit({
        action: source === 'bounced' ? 'comms.bounced' : 'comms.spam_complaint',
        entityType: 'user',
        entityId: user.id,
        actorId: null,
        tenantId: user.tenant_id,
        after: { source: `resend.${source}`, email: norm.replace(/(.).+(@.+)/, '$1***$2') },
      } as never);
    } catch (err) {
      logger.error({ err, userId: user.id, source }, 'webhooks/resend: suppression failed');
    }
  }
  if (users.length === 0) {
    // Email not in our user base; still log for ops visibility.
    logger.info({ source }, 'webhooks/resend: bounce/complaint for unknown email (ignored)');
  }
}

webhooksRouter.post(
  '/resend',
  // Capture the raw body so the HMAC check matches exactly what Resend signed.
  rawBody({ type: '*/*', limit: '64kb' }),
  async (req: Request, res: Response) => {
    // SVT-WAVE-WEBHOOK-FAILCLOSED-2026-05 — fail-closed when secret absent
    // in any non-test env. Returning 503 (not 401) so ops alerting
    // distinguishes "misconfigured" from "attacker tried bad signature".
    if (isSecretRequired() && !readSecret()) {
      logger.error('webhooks/resend: refusing request — RESEND_WEBHOOK_SECRET unset');
      res.status(503).json({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: 503,
        detail: 'Resend webhook is not configured (RESEND_WEBHOOK_SECRET unset).',
      });
      return;
    }
    // SVT-AUDIT-SEC-2026-06 (backlog rank 1) — prefer the raw bytes captured by
    // the global express.json({ verify }) (production path, where the global
    // parser has already consumed the stream). Fall back to req.body when it is
    // itself a Buffer (the isolated-router test path, which mounts this router
    // without the global parser so the route's own raw() parser populates it).
    const bodyBuf = Buffer.isBuffer(req.rawBody)
      ? req.rawBody
      : Buffer.isBuffer(req.body)
        ? (req.body as Buffer)
        : Buffer.alloc(0);
    if (!verifySignature(req, bodyBuf)) {
      logger.warn({ ip: req.ip }, 'webhooks/resend: signature verification failed');
      // Resend retries on non-2xx, so a 401 here means they back off — exactly
      // what we want on a bad signature.
      res.status(401).end();
      return;
    }
    let event: { type?: string; data?: { to?: string; email_id?: string } };
    try {
      event = JSON.parse(bodyBuf.toString('utf8'));
    } catch {
      res.status(400).end();
      return;
    }
    const to = event.data?.to ?? '';
    switch (event.type) {
      case 'email.bounced':
        if (to) await suppress(to, 'bounced');
        break;
      case 'email.complained':
        if (to) await suppress(to, 'complained');
        break;
      // delivered / opened / clicked — ack without action.
      default:
        break;
    }
    res.status(200).end();
  },
);
