import pino from 'pino';
import { env } from './env.js';

// Pino redaction list mirrors the security plan: never log auth material or PII tokens.
//
// SVT-WAVE-BLOCKER-3-2026-05 — extend the redaction set to cover identity +
// financial PII fields that the security audit (OWASP A09) flagged as
// missing: date_of_birth, ssn, bank_account, card_number, iban, swift,
// national_id, dependent.passport_number_enc (envelope-encrypted but never
// safe to log even as ciphertext).
// SVT-WAVE-PRIV-C5-2026-05 — pino redaction paths. Notes:
//   * `req.headers.authorization` covers the incoming Authorization header;
//     `authorization` (bare path) covers any other object Pino sees that
//     happens to hold an authorization value (e.g. an outbound-fetch options
//     dump). Same logic for `set-cookie`.
//   * The wildcard paths (`*.email`, `*.phone_e164` etc.) catch nested
//     occurrences (request bodies, audit payloads). Bare-key paths (without
//     `*.`) only match at log-record TOP level — both are required because
//     pino's wildcard does not cover the root.
//   * `[Redacted]` matches the literal censor string the security audit
//     pinned (case-sensitive). Tests assert this exact form.
const REDACTION_PATHS = [
  // ---- Transport headers / cookies ------------------------------------
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  // Bare-key forms so non-request log objects are also redacted. Pino's
  // path syntax requires bracket-string form for keys containing non-word
  // characters (hyphens), see https://github.com/pinojs/pino/blob/main/docs/redaction.md.
  'authorization',
  '["set-cookie"]',
  // ---- Auth material --------------------------------------------------
  '*.password',
  '*.password_hash',
  '*.token',
  '*.access_token',
  '*.refresh_token',
  '*.mfa_secret',
  // ---- Identity PII ---------------------------------------------------
  '*.passport_number',
  '*.passport_number_enc',
  '*.visa_number',
  '*.visa_number_enc',
  '*.national_id',
  '*.national_id_enc',
  '*.dob',
  '*.date_of_birth',
  '*.ssn',
  'ssn',
  // ---- Direct-contact PII (email + phone) -----------------------------
  // Bare-key paths catch top-level fields; wildcards catch nested ones.
  'email',
  'email_primary',
  'email_secondary',
  'phone_e164',
  'phone_primary_e164',
  'phone_secondary_e164',
  '*.email',
  '*.email_primary',
  '*.email_secondary',
  '*.phone_e164',
  '*.phone_primary_e164',
  '*.phone_secondary_e164',
  // ---- Financial PII --------------------------------------------------
  '*.policy_number',
  '*.policy_number_enc',
  '*.sponsor_income',
  '*.bank_account',
  '*.bank_account_number',
  '*.iban',
  '*.swift',
  '*.card_number',
  '*.cvv',
  '*.cvc',
  // ---- Integrity / encryption material --------------------------------
  '*.sha256',
  '*.dek',
  '*.kek',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  // Audit-pinned censor string: `[Redacted]` (mixed-case). The
  // logger-redaction test asserts the exact literal.
  redact: { paths: REDACTION_PATHS, censor: '[Redacted]' },
  base: { service: 'spv-backend', env: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(env.isDev
    ? { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: false } } }
    : {}),
});

export type Logger = typeof logger;
