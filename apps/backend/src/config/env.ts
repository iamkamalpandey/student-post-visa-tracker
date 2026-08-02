import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Comma-separated list of allowed origins.
  CORS_ORIGIN: z.string().min(1),

  DATABASE_URL: z.string().url(),
  DATABASE_MIGRATE_URL: z.string().url(),

  REDIS_URL: z.string().url(),

  JWT_PRIVATE_KEY: z.string().min(1),
  JWT_PUBLIC_KEY: z.string().min(1),
  JWT_KID: z.string().min(1),
  // SVT-WAVE-JWT-ROTATE-2026-05 — graceful rotation (overlap window).
  // NEXT = the key rotating in (published in JWKS, accepted on verify, not yet
  // used for signing). PREV = the key rotated out (public half only; published
  // in JWKS and accepted on verify so still-live tokens validate). See
  // infra/docs/runbooks/jwt-key-rotation.md for the rotation procedure.
  JWT_PRIVATE_KEY_NEXT: z.string().min(1).optional(),
  JWT_PUBLIC_KEY_NEXT: z.string().min(1).optional(),
  JWT_KID_NEXT: z.string().min(1).optional(),
  JWT_PUBLIC_KEY_PREV: z.string().min(1).optional(),
  JWT_KID_PREV: z.string().min(1).optional(),
  JWT_ISSUER: z.string().min(1).default('spv-api'),
  JWT_AUDIENCE: z.string().min(1).default('spv-app'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 7),
  // SVT-SEC-IDLE-2026-05 — idle-session cutoff in minutes. Refresh rejected
  // when last_used_at < now - IDLE_TIMEOUT_MIN. Defaults to 30min per OWASP.
  IDLE_TIMEOUT_MIN: z.coerce.number().int().positive().default(30),

  KMS_KEK_BASE64: z.string().min(32).optional(),
  // SVT-WAVE-KMS-PROVIDER-2026-05 — selects the KMS implementation. `local` is
  // process-local AES-256-GCM (KEK from KMS_KEK_BASE64, never use in prod without
  // KMS_LOCAL_OK=true); `aws` resolves to AwsKmsKms (lazy-imports
  // @aws-sdk/client-kms — boot fails fast if the dep is missing). `gcp` and
  // `vault` are reserved enum slots — getKms() will throw a clear "not
  // implemented" message until a provider class lands.
  KMS_PROVIDER: z.enum(['local', 'aws', 'gcp', 'vault']).default('local'),
  // KMS_KEY_ID — provider-native key identifier (AWS ARN/alias, GCP resource
  // name, Vault key name). Required when KMS_PROVIDER != 'local'.
  KMS_KEY_ID: z.string().min(1).optional(),
  // Explicit acknowledgement that operators run LocalKms in production
  // on purpose (self-hosted single-tenant w/ disk-encrypted KEK material).
  // Without this, NODE_ENV=production + KMS_PROVIDER=local refuses to start.
  KMS_LOCAL_OK: z
    .union([z.literal('true'), z.literal('false'), z.literal('1'), z.literal('0')])
    .optional()
    .transform((v) => v === 'true' || v === '1'),
  // AWS region for KMS API calls when KMS_PROVIDER=aws. Falls back to
  // AWS_REGION which the AWS SDK already honours, so only set this if you
  // need to override the SDK's default resolution.
  KMS_AWS_REGION: z.string().min(1).optional(),
  // REFRESH_TOKEN_PEPPER — 32-byte hex (64 chars). HMAC pepper applied to
  // refresh-token storage hashes. Required in production; rotating it
  // invalidates every issued refresh token and forces re-login (no DB
  // migration needed because hashes simply stop matching).
  REFRESH_TOKEN_PEPPER: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
  // CORRELATION_HMAC_KEY — 32-byte hex (64 chars). HMAC key for
  // IP/UA/email/jti audit-log correlation tokens. Independent of
  // JWT_PRIVATE_KEY so rotating signing keys does NOT invalidate the
  // correlation namespace (which would erase the operator's ability to
  // pivot across the audit log by IP/email after a JWT rotation). Required
  // in production.
  CORRELATION_HMAC_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
  // SVT-WAVE-KMS-PROVIDER-2026-05 — P1-K4 base64 alias for
  // CORRELATION_HMAC_KEY. Operators who already generate KMS_KEK_BASE64
  // with `openssl rand -base64 32` can re-use the same incantation here.
  // When BOTH are set, LOG_HMAC_KEY_BASE64 wins (it's the documented
  // newer spelling); when only CORRELATION_HMAC_KEY is set, behaviour is
  // unchanged. Decoded byte length must be exactly 32 (256 bits).
  LOG_HMAC_KEY_BASE64: z
    .string()
    .min(1)
    .refine((s) => {
      try {
        return Buffer.from(s, 'base64').length === 32;
      } catch {
        return false;
      }
    }, 'LOG_HMAC_KEY_BASE64 must decode to exactly 32 bytes (generate with: openssl rand -base64 32)')
    .optional(),

  SEED_TENANT_NAME: z.string().default('Default Tenant'),
  SEED_ADMIN_EMAIL: z.string().email(),
  SEED_ADMIN_PASSWORD: z.string().min(12),
  SEED_ADMIN_GIVEN_NAME: z.string().default('System'),
  SEED_ADMIN_FAMILY_NAME: z.string().default('Administrator'),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_ROOT: z.string().default('./storage'),

  // --- S3 / DO Spaces Configuration ---
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().min(1).optional(),
  S3_BUCKET: z.string().min(1).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),

  // --- ClamAV Configuration ---
  CLAMAV_HOST: z.string().optional(),
  CLAMAV_PORT: z.coerce.number().int().positive().default(3310),

  RATE_LIMIT_GLOBAL_PER_MINUTE: z.coerce.number().int().positive().default(600),
  // 5 attempts/min — protects against credential stuffing. The 6th request
  // inside a 60s window returns 429. Account-level lockout (5 fails / 15 min)
  // in auth.service.ts is the deeper defence; this is the rate ceiling.
  RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().positive().default(5),

  // SVT-WAVE7-EMAIL-2026-05 — outbound email provider.
  // EMAIL_PROVIDER drives the registry (`log` for dev/test, `resend` for prod).
  // RESEND_API_KEY required when EMAIL_PROVIDER=resend.
  // EMAIL_FROM required for both providers (used as the `from` address).
  EMAIL_PROVIDER: z.enum(['log', 'resend']).default('log'),
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z.string().email().default('noreply@spv.local'),

  // SVT-WAVE-BILLING-SEC-P0-F1 — adjustments whose absolute magnitude exceeds
  // this minor-unit threshold require ADMIN even for normally-counsellor-
  // permitted kinds (DISCOUNT / SCHOLARSHIP). Defaults to 100000 minor units
  // (= $1000 in USD-2dp). Set to 0 to disable the threshold (all magnitudes
  // are allowed at the FSM/role default).
  BILLING_ADJUSTMENT_ADMIN_THRESHOLD_MINOR: z.coerce
    .bigint()
    .nonnegative()
    .default(100000n),

  // SVT-AUDIT-OPS-2026-05 — error tracking. SENTRY_DSN absent = disabled.
  SENTRY_DSN: z.string().url().optional(),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.05),
  SENTRY_RELEASE: z.string().optional(),
  GIT_COMMIT: z.string().optional(),

  // SVT-SEC-HIBP-FAIL-CLOSED-2026-05 (P2-14) — what to do when HIBP is
  // unreachable. The string is consumed by `ensurePasswordNotPwned` to
  // decide whether to return 503 (closed) or allow the password (open).
  // Default is environment-dependent:
  //   - production: fail-CLOSED. An HIBP outage MUST NOT silently allow
  //     breached passwords through — that defeats the point of the check.
  //   - dev / test: fail-OPEN. Dev environments routinely run offline (no
  //     internet egress in CI sandboxes); hard 503s would block every
  //     password change. Operators can override either way via the env.
  // Accepted values: 'true' | 'false'. Empty falls through to the
  // environment-aware default applied in the post-parse normalisation
  // below.
  HIBP_FAIL_CLOSED: z.enum(['true', 'false']).optional(),

  // SVT-V2-TRACKER-2026-06 — read-only ingestion from the external "V2 MIS"
  // (TheNextMis) Postgres. All optional so existing deploys boot unchanged;
  // when V2_INGEST_ENABLED=true the superRefine below requires the source URL
  // + destination tenant. V2_MIS_DATABASE_SSL=true enables TLS to managed
  // remotes (DigitalOcean etc.); leave unset for a local copy.
  V2_MIS_DATABASE_URL: z.string().url().optional(),
  V2_MIS_DATABASE_SSL: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  // SVT-SEC-2026-06 — CA bundle (inline PEM or a file path) for FULL TLS
  // verification of the managed V2 DB. When set, pool.ts uses
  // rejectUnauthorized:true; when unset it falls back to encrypted-but-
  // unverified TLS with a loud warning (dev only). Ship the DO CA in prod.
  V2_MIS_DATABASE_CA: z.string().optional(),
  // Assert (once per process) that the V2 credential is read-only — catalog
  // reads only, never writes to V2. Default on; flip to 'false' to silence.
  V2_MIS_ASSERT_READONLY: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  V2_INGEST_TENANT_ID: z.string().uuid().optional(),
  V2_INGEST_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Fallback currency for seeded fees when V2 Course.feeCurrency is blank.
  // NPR — V2 is a Nepal consultancy (V2 Payment.currency defaults NPR).
  V2_INGEST_DEFAULT_CURRENCY: z.string().length(3).default('NPR'),
  // SVT-FEDERATION-2026-06 — read source for the visa-accepted CRM data:
  //   'mirror' = read the synced crm_* tables (current default).
  //   'live'   = read V2 directly per request (read-only) + stitch the spv_*
  //              overlay; no sync. Flip only after the live path is verified.
  // Prometheus /metrics endpoint bearer token. Required for scraper access.
  METRICS_TOKEN: z.string().min(16).optional(),
  SPV_READ_MODE: z.enum(['mirror', 'live']).default('mirror'),
}).superRefine((cfg, ctx) => {
  // KMS_KEK_BASE64 must be present in production when using the local provider
  // (envelope encryption requires the KEK to be loadable). Remote providers
  // (AWS/GCP/Vault) hold the KEK themselves so KMS_KEK_BASE64 is irrelevant.
  if (
    cfg.NODE_ENV === 'production' &&
    cfg.KMS_PROVIDER === 'local' &&
    (!cfg.KMS_KEK_BASE64 || cfg.KMS_KEK_BASE64.length < 32)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['KMS_KEK_BASE64'],
      message: 'KMS_KEK_BASE64 (>=32 chars) is required when NODE_ENV=production AND KMS_PROVIDER=local',
    });
  }
  // SVT-WAVE-KMS-PROVIDER-2026-05 — refuse to boot in prod with the in-process
  // LocalKms unless KMS_LOCAL_OK=true is set explicitly. Default-deny stops
  // an operator from accidentally shipping a managed-secret app without a
  // managed KMS.
  if (cfg.NODE_ENV === 'production' && cfg.KMS_PROVIDER === 'local' && !cfg.KMS_LOCAL_OK) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['KMS_PROVIDER'],
      message:
        'KMS_PROVIDER=local in production requires KMS_LOCAL_OK=true (self-hosted operators only). ' +
        'Production deployments should use KMS_PROVIDER=aws|gcp|vault with a managed key.',
    });
  }
  // Remote providers MUST be given a key id; without it the SDK has nothing
  // to encrypt against and we would fail at first-write rather than boot.
  if (cfg.KMS_PROVIDER !== 'local' && !cfg.KMS_KEY_ID) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['KMS_KEY_ID'],
      message: `KMS_KEY_ID is required when KMS_PROVIDER=${cfg.KMS_PROVIDER}`,
    });
  }
  // SVT-WAVE-KMS-PROVIDER-2026-05 — REFRESH_TOKEN_PEPPER + CORRELATION_HMAC_KEY
  // are mandatory in production. They are independent secrets (intentionally
  // not derived from JWT keys) so that signing-key rotation does not silently
  // invalidate refresh-token lookups or audit-log correlation indexes.
  if (cfg.NODE_ENV === 'production' && !cfg.REFRESH_TOKEN_PEPPER) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['REFRESH_TOKEN_PEPPER'],
      message:
        'REFRESH_TOKEN_PEPPER (64 hex chars) is required when NODE_ENV=production. ' +
        'Generate with: openssl rand -hex 32',
    });
  }
  // SVT-WAVE-KMS-PROVIDER-2026-05 — P1-K4 either spelling satisfies the
  // production requirement. LOG_HMAC_KEY_BASE64 is the documented newer
  // form; CORRELATION_HMAC_KEY is the legacy hex form. Operators may set
  // either, but not neither.
  if (
    cfg.NODE_ENV === 'production' &&
    !cfg.CORRELATION_HMAC_KEY &&
    !cfg.LOG_HMAC_KEY_BASE64
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['LOG_HMAC_KEY_BASE64'],
      message:
        'LOG_HMAC_KEY_BASE64 (base64-encoded 32 bytes) or CORRELATION_HMAC_KEY ' +
        '(64 hex chars) is required when NODE_ENV=production. ' +
        'Generate with: openssl rand -base64 32',
    });
  }
  if (cfg.EMAIL_PROVIDER === 'resend' && !cfg.RESEND_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['RESEND_API_KEY'],
      message: 'RESEND_API_KEY is required when EMAIL_PROVIDER=resend',
    });
  }
  // SVT-V2-TRACKER-2026-06 — switching the ingest on requires both a source
  // connection and a destination tenant, else the daily job has nothing to
  // read / nowhere to write.
  if (cfg.V2_INGEST_ENABLED && !cfg.V2_MIS_DATABASE_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['V2_MIS_DATABASE_URL'],
      message: 'V2_MIS_DATABASE_URL is required when V2_INGEST_ENABLED=true',
    });
  }

  // --- S3 storage driver validation ---
  if (cfg.STORAGE_DRIVER === 's3') {
    if (!cfg.S3_ENDPOINT) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['S3_ENDPOINT'], message: 'S3_ENDPOINT is required when STORAGE_DRIVER=s3' });
    if (!cfg.S3_REGION) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['S3_REGION'], message: 'S3_REGION is required when STORAGE_DRIVER=s3' });
    if (!cfg.S3_BUCKET) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['S3_BUCKET'], message: 'S3_BUCKET is required when STORAGE_DRIVER=s3' });
    if (!cfg.S3_ACCESS_KEY_ID) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['S3_ACCESS_KEY_ID'], message: 'S3_ACCESS_KEY_ID is required when STORAGE_DRIVER=s3' });
    if (!cfg.S3_SECRET_ACCESS_KEY) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['S3_SECRET_ACCESS_KEY'], message: 'S3_SECRET_ACCESS_KEY is required when STORAGE_DRIVER=s3' });
  }
  if (cfg.V2_INGEST_ENABLED && !cfg.V2_INGEST_TENANT_ID) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['V2_INGEST_TENANT_ID'],
      message: 'V2_INGEST_TENANT_ID is required when V2_INGEST_ENABLED=true',
    });
  }
  // SVT-WAVE-JWT-ROTATE-2026-05 — paired NEXT/PREV vars must declare a kid,
  // otherwise the JWKS entry has no stable identifier and rotation breaks.
  if (cfg.JWT_PUBLIC_KEY_NEXT && !cfg.JWT_KID_NEXT) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['JWT_KID_NEXT'],
      message: 'JWT_KID_NEXT is required when JWT_PUBLIC_KEY_NEXT is set',
    });
  }
  if (cfg.JWT_PRIVATE_KEY_NEXT && !cfg.JWT_PUBLIC_KEY_NEXT) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['JWT_PUBLIC_KEY_NEXT'],
      message: 'JWT_PUBLIC_KEY_NEXT is required when JWT_PRIVATE_KEY_NEXT is set',
    });
  }
  if (cfg.JWT_PUBLIC_KEY_PREV && !cfg.JWT_KID_PREV) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['JWT_KID_PREV'],
      message: 'JWT_KID_PREV is required when JWT_PUBLIC_KEY_PREV is set',
    });
  }
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(parsed.error.format());
  process.exit(1);
}

const raw = parsed.data;

// Allow PEMs to be supplied with literal \n in single-line env values.
const unescapePem = (s: string) => s.replace(/\\n/g, '\n');

const unescapeOpt = (s: string | undefined) => (s ? unescapePem(s) : undefined);

// SVT-SEC-HIBP-FAIL-CLOSED-2026-05 (P2-14) — apply the env-aware default
// for HIBP_FAIL_CLOSED. Production defaults to 'true' so an HIBP outage
// returns 503 instead of silently allowing a possibly-breached password;
// non-production defaults to 'false' because dev/CI commonly run offline.
// The resolved value is also written back to process.env so the
// `process.env['HIBP_FAIL_CLOSED']` lookup in shared/hibp.ts picks up the
// default without a code change to that module.
const hibpFailClosedResolved: 'true' | 'false' =
  raw.HIBP_FAIL_CLOSED ?? (raw.NODE_ENV === 'production' ? 'true' : 'false');
process.env['HIBP_FAIL_CLOSED'] = hibpFailClosedResolved;

export const env = {
  ...raw,
  HIBP_FAIL_CLOSED: hibpFailClosedResolved,
  JWT_PRIVATE_KEY: unescapePem(raw.JWT_PRIVATE_KEY),
  JWT_PUBLIC_KEY: unescapePem(raw.JWT_PUBLIC_KEY),
  JWT_PRIVATE_KEY_NEXT: unescapeOpt(raw.JWT_PRIVATE_KEY_NEXT),
  JWT_PUBLIC_KEY_NEXT: unescapeOpt(raw.JWT_PUBLIC_KEY_NEXT),
  JWT_PUBLIC_KEY_PREV: unescapeOpt(raw.JWT_PUBLIC_KEY_PREV),
  isProd: raw.NODE_ENV === 'production',
  isDev: raw.NODE_ENV === 'development',
  isTest: raw.NODE_ENV === 'test',
};

export type Env = typeof env;
