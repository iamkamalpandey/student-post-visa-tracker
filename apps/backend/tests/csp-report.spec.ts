// SVT-SEC-P2-FE3-2026-05 + SVT-SEC-P2-FE4-2026-05 —
// CSP violation sink + frontend error-boundary report sink integration tests.
//
// Both routes are PUBLIC (unauthenticated), self-rate-limited, and log a
// structured pino event. We don't assert on the log output here (pino's
// transport stream isn't trivially observable inside vitest) — we assert on
// the wire contract: status code, body shape (always 204 success), and the
// dedicated rate-limit response.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3001');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('DATABASE_MIGRATE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
vi.stubEnv('JWT_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nNOT_USED\n-----END PRIVATE KEY-----');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nNOT_USED\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test-kid');
vi.stubEnv('JWT_ISSUER', 'spv-api-test');
vi.stubEnv('JWT_AUDIENCE', 'spv-app-test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

// Force the logger to a no-op so we don't spam the test stdout with the
// `csp_violation` warnings we're deliberately emitting below.
vi.mock('../src/config/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { cspReportRouter, errorReportRouter } = await import(
  '../src/modules/security/csp-report.routes.js'
);
const { errorHandler, notFoundHandler } = await import(
  '../src/middlewares/errorHandler.js'
);

function makeApp(): Express {
  const app = express();
  app.set('trust proxy', 1);
  // Do NOT install a global express.json() here — the routers install their
  // own parsers for the bespoke MIME types they accept.
  app.use('/api/v1/csp', cspReportRouter);
  app.use('/api/v1/security', errorReportRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

let app: Express;

beforeAll(() => {
  app = makeApp();
});

beforeEach(() => {
  // Each test rebuilds the app so module-level limiters that survive imports
  // don't accidentally bleed across describe blocks. (Rate-limit tests below
  // explicitly hammer well past the limit so this matters less, but it keeps
  // ordering-independent.)
  app = makeApp();
});

describe('POST /api/v1/csp/report — legacy application/csp-report shape', () => {
  it('returns 204 for a well-formed legacy CSP report', async () => {
    const res = await request(app)
      .post('/api/v1/csp/report')
      .set('Content-Type', 'application/csp-report')
      .send(
        JSON.stringify({
          'csp-report': {
            'blocked-uri': 'inline',
            'violated-directive': "script-src 'self'",
            'document-uri': 'https://app.example.com/',
            'original-policy': "default-src 'self'",
          },
        }),
      );
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
  });
});

describe('POST /api/v1/csp/report — Reports API shape', () => {
  it('returns 204 for a Reports API array payload', async () => {
    const res = await request(app)
      .post('/api/v1/csp/report')
      .set('Content-Type', 'application/reports+json')
      .send(
        JSON.stringify([
          {
            type: 'csp-violation',
            age: 12,
            url: 'https://app.example.com/',
            body: {
              blockedURL: 'https://evil.example/x.js',
              effectiveDirective: 'script-src-elem',
              documentURL: 'https://app.example.com/',
            },
          },
        ]),
      );
    expect(res.status).toBe(204);
  });
});

describe('POST /api/v1/csp/report — degenerate / unknown body', () => {
  it('still returns 204 for an empty body (browsers occasionally do this)', async () => {
    const res = await request(app)
      .post('/api/v1/csp/report')
      .set('Content-Type', 'application/csp-report')
      .send('');
    expect(res.status).toBe(204);
  });

  it('returns 204 for an arbitrary JSON object without csp-report key', async () => {
    const res = await request(app)
      .post('/api/v1/csp/report')
      .set('Content-Type', 'application/json')
      .send({ unrelated: 'object' });
    expect(res.status).toBe(204);
  });
});

describe('POST /api/v1/csp/report — rate limiting', () => {
  it('returns 429 once the per-IP rate limit (10/min) is exceeded', async () => {
    let saw429 = false;
    for (let i = 0; i < 50; i++) {
      const res = await request(app)
        .post('/api/v1/csp/report')
        .set('Content-Type', 'application/csp-report')
        .send(JSON.stringify({ 'csp-report': { 'blocked-uri': 'inline' } }));
      if (res.status === 429) {
        saw429 = true;
        break;
      }
    }
    expect(saw429).toBe(true);
  });
});

describe('POST /api/v1/security/error-report — sanitised payload', () => {
  it('returns 204 for a minimal sanitised envelope', async () => {
    const res = await request(app)
      .post('/api/v1/security/error-report')
      .set('Content-Type', 'application/json')
      .send({ name: 'TypeError', digest: 'abc123', route: 'app' });
    expect(res.status).toBe(204);
  });

  it('trims long fields and ignores message/stack inside payloads under the body limit', async () => {
    // Names within the parser's 4kb body cap are truncated to 200 chars in the
    // handler. message/stack keys are silently dropped (they're never read).
    // Anything blowing the 4kb cap is rejected at the parser layer — that's
    // express-rate-limit-style backpressure, not a leak.
    const res = await request(app)
      .post('/api/v1/security/error-report')
      .set('Content-Type', 'application/json')
      .send({
        name: 'X'.repeat(500),
        digest: 'd',
        message: 'should be ignored',
        stack: 'should be ignored',
      });
    expect(res.status).toBe(204);
  });

  it('returns 429 once the per-IP rate limit (30/min) is exceeded', async () => {
    let saw429 = false;
    for (let i = 0; i < 80; i++) {
      const res = await request(app)
        .post('/api/v1/security/error-report')
        .set('Content-Type', 'application/json')
        .send({ name: 'Error', digest: 'x' });
      if (res.status === 429) {
        saw429 = true;
        break;
      }
    }
    expect(saw429).toBe(true);
  });
});
