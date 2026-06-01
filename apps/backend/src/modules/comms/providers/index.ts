// Comms provider abstraction.
//
// Each concrete provider (Resend / Twilio / Meta WhatsApp / in-app socket) is
// responsible for a single channel and returns a synchronous-looking promise.
// The contract intentionally stays narrow: the service layer owns thread/row
// bookkeeping; providers only push the bytes.
//
// Failure mode: providers MUST resolve with `{ status: 'FAILED', error }` for
// recoverable problems (bad number, malformed body, 4xx from upstream). They
// may still throw for catastrophic infra issues — the service wraps the call
// in try/catch so the HTTP create endpoint never crashes.

export type CommsChannel = 'EMAIL' | 'SMS' | 'WHATSAPP' | 'IN_APP';

export type CommsSendInput = {
  to: string;
  subject?: string;
  body: string;
  /**
   * Per-tenant override for the FROM address. EMAIL providers MUST honour
   * this when set — falls back to the provider's default-from configured at
   * boot when null. Channels without FROM semantics (SMS, IN_APP) ignore.
   */
  from?: string | null;
  /**
   * SVT-COMPLIANCE-2026-05 — one-click unsubscribe URL (RFC 8058). EMAIL
   * providers emit it as `List-Unsubscribe` + `List-Unsubscribe-Post`
   * headers. Required by Gmail/Yahoo 2024 bulk-sender enforcement and
   * by CAN-SPAM §5 / GDPR Art 21 for marketing. Pass null for purely
   * one-off transactional sends (e.g. password reset) where unsubscribe
   * is meaningless. Channels other than EMAIL ignore.
   */
  unsubscribeUrl?: string | null;
  metadata?: Record<string, unknown>;
};

export type CommsSendResult =
  | { providerId: string; status: 'SENT'; error?: undefined }
  | { providerId: string; status: 'FAILED'; error: string };

export interface CommsProvider {
  channel: CommsChannel;
  send(msg: CommsSendInput): Promise<CommsSendResult>;
}

export type { CommsProvider as default };
