// SVT-WAVE60-PROD-ENV-2026-05 — production-mode env validation.
//
// Verifies the EnvSchema refusals that protect prod:
//   - KMS_KEK_BASE64 must be present (envelope encryption can't be optional)
//   - EMAIL_PROVIDER=resend requires RESEND_API_KEY
// Plus development defaults still load when only minimum vars are present.
//
// Implementation: import the schema directly and parse a synthesised process.env
// rather than spawning a fresh node — vitest can't easily isolate env.ts because
// it executes `process.exit(1)` on invalid input. Re-implements the schema
// import path so we don't trip that exit.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { generateKeyPairSync } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }) as string;

// Snapshot of the production schema. Keep in step with apps/backend/src/config/env.ts;
// audit-naming.spec.ts would catch a drift on action names, this just checks shape.
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    CORS_ORIGIN: z.string().min(1),
    DATABASE_URL: z.string().url(),
    DATABASE_MIGRATE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    JWT_PRIVATE_KEY: z.string().min(1),
    JWT_PUBLIC_KEY: z.string().min(1),
    JWT_KID: z.string().min(1),
    JWT_PRIVATE_KEY_NEXT: z.string().min(1).optional(),
    JWT_PUBLIC_KEY_NEXT: z.string().min(1).optional(),
    JWT_KID_NEXT: z.string().min(1).optional(),
    JWT_PUBLIC_KEY_PREV: z.string().min(1).optional(),
    JWT_KID_PREV: z.string().min(1).optional(),
    JWT_ISSUER: z.string().min(1).default('spv-api'),
    JWT_AUDIENCE: z.string().min(1).default('spv-app'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 7),
    KMS_KEK_BASE64: z.string().min(32).optional(),
    KMS_PROVIDER: z.enum(['local', 'aws', 'gcp', 'vault']).default('local'),
    KMS_KEY_ID: z.string().min(1).optional(),
    KMS_LOCAL_OK: z
      .union([z.literal('true'), z.literal('false'), z.literal('1'), z.literal('0')])
      .optional()
      .transform((v) => v === 'true' || v === '1'),
    KMS_AWS_REGION: z.string().min(1).optional(),
    REFRESH_TOKEN_PEPPER: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
    CORRELATION_HMAC_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
    SEED_TENANT_NAME: z.string().default('Default Tenant'),
    SEED_ADMIN_EMAIL: z.string().email(),
    SEED_ADMIN_PASSWORD: z.string().min(12),
    SEED_ADMIN_GIVEN_NAME: z.string().default('System'),
    SEED_ADMIN_FAMILY_NAME: z.string().default('Administrator'),
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_ROOT: z.string().default('./storage'),
    RATE_LIMIT_GLOBAL_PER_MINUTE: z.coerce.number().int().positive().default(600),
    RATE_LIMIT_AUTH_PER_MINUTE: z.coerce.number().int().positive().default(5),
    EMAIL_PROVIDER: z.enum(['log', 'resend']).default('log'),
    RESEND_API_KEY: z.string().min(1).optional(),
    EMAIL_FROM: z.string().email().default('noreply@spv.local'),
  })
  .superRefine((cfg, ctx) => {
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
    if (cfg.NODE_ENV === 'production' && cfg.KMS_PROVIDER === 'local' && !cfg.KMS_LOCAL_OK) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['KMS_PROVIDER'],
        message:
          'KMS_PROVIDER=local in production requires KMS_LOCAL_OK=true (self-hosted operators only).',
      });
    }
    if (cfg.KMS_PROVIDER !== 'local' && !cfg.KMS_KEY_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['KMS_KEY_ID'],
        message: `KMS_KEY_ID is required when KMS_PROVIDER=${cfg.KMS_PROVIDER}`,
      });
    }
    if (cfg.NODE_ENV === 'production' && !cfg.REFRESH_TOKEN_PEPPER) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REFRESH_TOKEN_PEPPER'],
        message: 'REFRESH_TOKEN_PEPPER (64 hex chars) is required when NODE_ENV=production.',
      });
    }
    if (cfg.NODE_ENV === 'production' && !cfg.CORRELATION_HMAC_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORRELATION_HMAC_KEY'],
        message: 'CORRELATION_HMAC_KEY (64 hex chars) is required when NODE_ENV=production.',
      });
    }
    if (cfg.EMAIL_PROVIDER === 'resend' && !cfg.RESEND_API_KEY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RESEND_API_KEY'],
        message: 'RESEND_API_KEY is required when EMAIL_PROVIDER=resend',
      });
    }
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

const VALID_BASE = {
  CORS_ORIGIN: 'https://app.example.com',
  DATABASE_URL: 'postgresql://app:pw@db:5432/spv',
  DATABASE_MIGRATE_URL: 'postgresql://owner:pw@db:5432/spv',
  REDIS_URL: 'redis://r:6379',
  JWT_PRIVATE_KEY: PRIVATE_PEM,
  JWT_PUBLIC_KEY: PUBLIC_PEM,
  JWT_KID: 'k1',
  SEED_ADMIN_EMAIL: 'admin@example.com',
  SEED_ADMIN_PASSWORD: 'ChangeMeNow!2026',
};

describe('EnvSchema (production guards)', () => {
  it('production WITHOUT KMS_KEK_BASE64 fails parse', () => {
    const out = EnvSchema.safeParse({ ...VALID_BASE, NODE_ENV: 'production' });
    expect(out.success).toBe(false);
    if (!out.success) {
      const paths = out.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('KMS_KEK_BASE64');
    }
  });

  it('production WITH KMS_KEK_BASE64 (>=32 chars) parses (with KMS_LOCAL_OK + prod-required peppers)', () => {
    const out = EnvSchema.safeParse({
      ...VALID_BASE,
      NODE_ENV: 'production',
      KMS_KEK_BASE64: 'a'.repeat(44),
      KMS_LOCAL_OK: 'true',
      REFRESH_TOKEN_PEPPER: 'a'.repeat(64),
      CORRELATION_HMAC_KEY: 'b'.repeat(64),
    });
    expect(out.success).toBe(true);
  });

  // SVT-WAVE-KMS-PROVIDER-2026-05 — P0-K1 guards.
  it('production + KMS_PROVIDER=local WITHOUT KMS_LOCAL_OK fails parse', () => {
    const out = EnvSchema.safeParse({
      ...VALID_BASE,
      NODE_ENV: 'production',
      KMS_KEK_BASE64: 'a'.repeat(44),
      KMS_PROVIDER: 'local',
      REFRESH_TOKEN_PEPPER: 'a'.repeat(64),
      CORRELATION_HMAC_KEY: 'b'.repeat(64),
    });
    expect(out.success).toBe(false);
    if (!out.success) {
      const paths = out.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('KMS_PROVIDER');
    }
  });

  it('KMS_PROVIDER=aws WITHOUT KMS_KEY_ID fails parse', () => {
    const out = EnvSchema.safeParse({
      ...VALID_BASE,
      KMS_PROVIDER: 'aws',
    });
    expect(out.success).toBe(false);
    if (!out.success) {
      const paths = out.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('KMS_KEY_ID');
    }
  });

  it('KMS_PROVIDER=aws WITH KMS_KEY_ID parses (no KMS_KEK_BASE64 needed)', () => {
    const out = EnvSchema.safeParse({
      ...VALID_BASE,
      NODE_ENV: 'production',
      KMS_PROVIDER: 'aws',
      KMS_KEY_ID: 'arn:aws:kms:us-east-1:111111111111:key/abc',
      REFRESH_TOKEN_PEPPER: 'a'.repeat(64),
      CORRELATION_HMAC_KEY: 'b'.repeat(64),
    });
    expect(out.success).toBe(true);
  });

  it('production WITHOUT REFRESH_TOKEN_PEPPER fails parse (P1-K3)', () => {
    const out = EnvSchema.safeParse({
      ...VALID_BASE,
      NODE_ENV: 'production',
      KMS_PROVIDER: 'aws',
      KMS_KEY_ID: 'arn:aws:kms:us-east-1:111111111111:key/abc',
      CORRELATION_HMAC_KEY: 'b'.repeat(64),
    });
    expect(out.success).toBe(false);
    if (!out.success) {
      const paths = out.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('REFRESH_TOKEN_PEPPER');
    }
  });

  it('production WITHOUT CORRELATION_HMAC_KEY fails parse (P1-K4)', () => {
    const out = EnvSchema.safeParse({
      ...VALID_BASE,
      NODE_ENV: 'production',
      KMS_PROVIDER: 'aws',
      KMS_KEY_ID: 'arn:aws:kms:us-east-1:111111111111:key/abc',
      REFRESH_TOKEN_PEPPER: 'a'.repeat(64),
    });
    expect(out.success).toBe(false);
    if (!out.success) {
      const paths = out.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('CORRELATION_HMAC_KEY');
    }
  });

  it('REFRESH_TOKEN_PEPPER must be exactly 64 hex chars', () => {
    const out = EnvSchema.safeParse({
      ...VALID_BASE,
      REFRESH_TOKEN_PEPPER: 'not-hex',
    });
    expect(out.success).toBe(false);
  });

  it('EMAIL_PROVIDER=resend WITHOUT RESEND_API_KEY fails parse', () => {
    const out = EnvSchema.safeParse({
      ...VALID_BASE,
      NODE_ENV: 'staging',
      EMAIL_PROVIDER: 'resend',
    });
    expect(out.success).toBe(false);
    if (!out.success) {
      const paths = out.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('RESEND_API_KEY');
    }
  });

  it('EMAIL_PROVIDER=resend WITH RESEND_API_KEY parses', () => {
    const out = EnvSchema.safeParse({
      ...VALID_BASE,
      NODE_ENV: 'staging',
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_test_xxxxx',
    });
    expect(out.success).toBe(true);
  });

  it('rejects non-URL DATABASE_URL', () => {
    const out = EnvSchema.safeParse({ ...VALID_BASE, DATABASE_URL: 'not-a-url' });
    expect(out.success).toBe(false);
  });

  it('rejects SEED_ADMIN_PASSWORD shorter than 12 chars', () => {
    const out = EnvSchema.safeParse({ ...VALID_BASE, SEED_ADMIN_PASSWORD: 'short' });
    expect(out.success).toBe(false);
  });

  it('development defaults apply when only required vars present', () => {
    const out = EnvSchema.safeParse(VALID_BASE);
    expect(out.success).toBe(true);
    if (out.success) {
      expect(out.data.NODE_ENV).toBe('development');
      expect(out.data.PORT).toBe(4000);
      expect(out.data.LOG_LEVEL).toBe('info');
      expect(out.data.EMAIL_PROVIDER).toBe('log');
      expect(out.data.RATE_LIMIT_AUTH_PER_MINUTE).toBe(5);
    }
  });

  it('CORS_ORIGIN required (no default)', () => {
    const without = { ...VALID_BASE } as Partial<typeof VALID_BASE>;
    delete (without as { CORS_ORIGIN?: string }).CORS_ORIGIN;
    const out = EnvSchema.safeParse(without);
    expect(out.success).toBe(false);
  });

  // SVT-WAVE-JWT-ROTATE-2026-05 — guards on the optional rotation envs.
  it('JWT_PUBLIC_KEY_NEXT set without JWT_KID_NEXT fails parse', () => {
    const out = EnvSchema.safeParse({ ...VALID_BASE, JWT_PUBLIC_KEY_NEXT: PUBLIC_PEM });
    expect(out.success).toBe(false);
    if (!out.success) {
      const paths = out.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('JWT_KID_NEXT');
    }
  });

  it('JWT_PUBLIC_KEY_PREV set without JWT_KID_PREV fails parse', () => {
    const out = EnvSchema.safeParse({ ...VALID_BASE, JWT_PUBLIC_KEY_PREV: PUBLIC_PEM });
    expect(out.success).toBe(false);
    if (!out.success) {
      const paths = out.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('JWT_KID_PREV');
    }
  });

  it('full rotation envset (PRIMARY + NEXT + PREV) parses cleanly', () => {
    const out = EnvSchema.safeParse({
      ...VALID_BASE,
      JWT_PUBLIC_KEY_NEXT: PUBLIC_PEM,
      JWT_PRIVATE_KEY_NEXT: PRIVATE_PEM,
      JWT_KID_NEXT: 'k2',
      JWT_PUBLIC_KEY_PREV: PUBLIC_PEM,
      JWT_KID_PREV: 'k0',
    });
    expect(out.success).toBe(true);
  });

  it('PRIMARY-only envset (no NEXT/PREV) parses — backward compat preserved', () => {
    const out = EnvSchema.safeParse(VALID_BASE);
    expect(out.success).toBe(true);
  });
});
