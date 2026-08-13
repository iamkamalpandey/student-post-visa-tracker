// SVT-COMPLIANCE-2026-05 — One-click unsubscribe (RFC 8058 + CAN-SPAM §5 +
// GDPR Art 21). Backs the List-Unsubscribe + List-Unsubscribe-Post headers
// emitted by the Resend provider.
//
// Token shape: HMAC-SHA256(userId + secret) => 64-hex. We don't sign the
// timestamp because RFC 8058 expects the URL to remain valid until the user
// chooses to re-subscribe (one-click should not bounce on expiry); rotating
// the secret invalidates all outstanding URLs (use sparingly).
//
// Endpoints:
//   GET  /api/v1/comms/unsubscribe?u=<userId>&t=<token>
//     Human landing page (returns simple HTML). Idempotent.
//   POST /api/v1/comms/unsubscribe
//     RFC 8058 One-Click target. Body form fields or JSON: { u, t }.
//     Response 200 with no body.
//
// Both flip `User.notifications_email_enabled = false` for the matched user
// and write an audit row. Unknown user_id or bad token → 200 OK (anti-
// enumeration) but no side effect.

import { Router, type Request, type Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { prismaAdmin } from '../../config/db.js';
import { withTenantTx } from '../../shared/tenantTx.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { writeAudit } from '../../shared/audit.js';

export const unsubscribeRouter: Router = Router();

const SECRET = env.JWT_PRIVATE_KEY; // re-use JWT private key as HMAC secret

function sign(userId: string): string {
  return createHmac('sha256', SECRET).update(userId).digest('hex');
}

function verifyToken(userId: string, token: string): boolean {
  if (!userId || !token) return false;
  if (token.length !== 64) return false;
  const expected = Buffer.from(sign(userId), 'hex');
  let provided: Buffer;
  try {
    provided = Buffer.from(token, 'hex');
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(expected, provided);
  } catch {
    return false;
  }
}

/**
 * Helper for callers (e.g. comms dispatcher) to mint a one-click unsubscribe URL.
 * Exported so the dispatcher can pass it into provider.send() via unsubscribeUrl.
 */
export function buildUnsubscribeUrl(baseUrl: string, userId: string): string {
  return `${baseUrl.replace(/\/$/, '')}/api/v1/comms/unsubscribe?u=${userId}&t=${sign(userId)}`;
}

async function applyUnsubscribe(userId: string, ctx: { ip?: string; ua?: string }): Promise<void> {
  try {
    // SVT-SEC-2026-08 (T0-7) — prismaAdmin. A one-click unsubscribe link carries
    // a signed user id and nothing else: no session, no tenant to scope to
    // before the row is read. On the singleton this returned null under the
    // production role and every unsubscribe silently did nothing — the
    // anti-enumeration "silently succeed" branch made it indistinguishable from
    // success, while the user kept receiving mail they had opted out of.
    const user = await prismaAdmin.user.findFirst({
      where: { id: userId, deleted_at: null },
      select: { id: true, tenant_id: true, notifications_email_enabled: true },
    });
    if (!user) return; // anti-enumeration: silently succeed
    if (user.notifications_email_enabled === false) return; // already unsubscribed
    // Scoped to the tenant that owns the row we just found.
    await withTenantTx(user.tenant_id, (tx) => tx.user.update({
      where: { id: user.id },
      data: { notifications_email_enabled: false },
    }));
    await writeAudit({
      action: 'comms.unsubscribed',
      entityType: 'user',
      entityId: user.id,
      tenantId: user.tenant_id,
      actorId: null,
      after: { notifications_email_enabled: false, source: 'one-click-unsubscribe' },
      metadata: { ip: ctx.ip, ua: ctx.ua },
    } as never);
  } catch (err) {
    logger.error({ err, userId }, 'comms.unsubscribe: failed to apply');
  }
}

// GET — human-facing landing page (no auth, anti-enumeration).
unsubscribeRouter.get('/', async (req: Request, res: Response) => {
  const userId = String(req.query['u'] ?? '');
  const token = String(req.query['t'] ?? '');
  if (verifyToken(userId, token)) {
    await applyUnsubscribe(userId, { ip: req.ip, ua: req.header('user-agent') ?? undefined });
  }
  // Always return a friendly 200 with no information leaking whether the
  // address was valid. RFC 8058 + Gmail bulk-sender expects 200 here.
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(
    `<!doctype html><html><head><title>Unsubscribed</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:system-ui,sans-serif;max-width:600px;margin:6em auto;padding:0 1em;color:#333}h1{font-size:1.5em}</style>
</head><body>
<h1>You're unsubscribed.</h1>
<p>You will no longer receive marketing emails from us. Transactional messages (account confirmations, security alerts) may still be sent.</p>
<p>If this was a mistake, log in to your account and re-enable email notifications in your profile.</p>
</body></html>`,
  );
});

// POST — RFC 8058 One-Click target. Accepts either form or JSON body.
unsubscribeRouter.post('/', async (req: Request, res: Response) => {
  const userId = String((req.body?.u ?? req.query['u']) ?? '');
  const token = String((req.body?.t ?? req.query['t']) ?? '');
  if (verifyToken(userId, token)) {
    await applyUnsubscribe(userId, { ip: req.ip, ua: req.header('user-agent') ?? undefined });
  }
  res.status(200).end();
});
