// Resend email provider — hits POST https://api.resend.com/emails with the
// REST contract documented at https://resend.com/docs/api-reference/emails/send-email.
//
// We intentionally use the raw fetch HTTP path rather than the @resend/node
// SDK so the backend has zero new runtime dependencies. Node 20+ has global
// fetch; the contract is stable + small.
//
// Errors:
//   - HTTP 4xx (bad payload / unverified domain / unknown recipient) →
//     CommsSendResult { status: 'FAILED', error: <upstream body> }.
//   - HTTP 5xx / network → same FAILED return (caller logs); we don't throw so
//     the CommsMessage row records the failure rather than crashing the request.
//
// Auth: `Authorization: Bearer ${RESEND_API_KEY}`.
// Body: text-only for now. HTML render is added when message templates ship
// an html_md compile step.
//
// Idempotency: Resend exposes `idempotency_key` header in beta — we do NOT
// use it because the comms_messages row id already prevents replay (the
// dispatcher only sends a row once; SENT rows are not retried). Adding the
// header would over-protect.

import { createHash } from 'node:crypto';
import { logger } from '../../../config/logger.js';
import type {
  CommsChannel,
  CommsProvider,
  CommsSendInput,
  CommsSendResult,
} from './index.js';

export class ResendProvider implements CommsProvider {
  public readonly channel: CommsChannel = 'EMAIL';

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {
    if (!apiKey) throw new Error('ResendProvider: apiKey is required');
    if (!from) throw new Error('ResendProvider: from is required');
  }

  async send(msg: CommsSendInput): Promise<CommsSendResult> {
    if (!msg.to) return { providerId: '', status: 'FAILED', error: '"to" is required' };
    if (!msg.body) return { providerId: '', status: 'FAILED', error: '"body" is required' };

    // SVT-COMPLIANCE-2026-05 — RFC 8058 + Gmail/Yahoo 2024 bulk-sender rules
    // require `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
    // on every commercial email. We surface them on EVERY outbound for safety
    // (transactional senders are also expected to honour unsubscribe by 2026).
    // The actual unsubscribe endpoint is wired separately at /api/v1/comms/unsubscribe.
    const unsubHeaders: Record<string, string> = msg.unsubscribeUrl
      ? {
          'List-Unsubscribe': `<${msg.unsubscribeUrl}>, <mailto:unsubscribe@${(msg.from ?? this.from).split('@')[1] ?? 'spv.local'}?subject=unsubscribe>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        }
      : {};
    const payload = {
      from: msg.from ?? this.from,
      to: [msg.to],
      subject: msg.subject ?? '(no subject)',
      text: msg.body,
      ...(Object.keys(unsubHeaders).length > 0 ? { headers: unsubHeaders } : {}),
    };

    let res: Response;
    try {
      // SVT-OBSERVABILITY-2026-05 — bounded timeout. Without this, a Resend
      // outage hangs every dispatcher worker for the full Node fetch default
      // (no timeout = until TCP/TLS error) — pool exhaustion under sustained
      // outage. 10s gives a clean FAIL → dispatcher backoff.
      res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : 'network error';
      logger.warn({ err, provider: 'resend' }, 'resend.send network error');
      return { providerId: '', status: 'FAILED', error };
    }

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      // Swallow JSON parse errors — Resend always returns JSON; missing body
      // means 5xx + plain text. The status check below still surfaces it.
    }

    if (!res.ok) {
      const error =
        (body as { message?: string })?.message ??
        `HTTP ${res.status}`;
      // SVT-QA-2026-08 — do not log the recipient email or the full provider
      // body in plaintext; both are PII surfaces. Hash the recipient (matches
      // the audit-log ip_hash / ua_hash pattern) and whitelist a handful of
      // safe provider fields for diagnosis.
      const bodyMsg =
        body && typeof body === 'object'
          ? {
              message: (body as { message?: string }).message,
              type: (body as { type?: string }).type,
              statusCode: (body as { statusCode?: number }).statusCode,
            }
          : null;
      const toHash =
        typeof msg.to === 'string' && msg.to.length > 0
          ? createHash('sha256').update(msg.to.toLowerCase()).digest('hex').slice(0, 16)
          : null;
      logger.warn(
        { status: res.status, providerBody: bodyMsg, toHash },
        'resend.send failed',
      );
      return { providerId: '', status: 'FAILED', error };
    }

    const providerId = (body as { id?: string })?.id ?? `resend-${Date.now()}`;
    return { providerId, status: 'SENT' };
  }
}
