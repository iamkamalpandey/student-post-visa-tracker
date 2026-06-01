import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Stub minimal env so any module pulling in src/config/env.ts can load. We are NOT importing
// createApp() here because it pulls in the auth router which is not yet implemented; we
// instead mount the existing health router directly. Once auth lands, swap to createApp().
vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3000');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const { healthRouter } = await import('../src/modules/health/health.routes.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/health', healthRouter);
  return app;
}

describe('GET /api/v1/health/livez', () => {
  it('returns 200 and {status:"ok"}', async () => {
    const res = await request(makeApp()).get('/api/v1/health/livez');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});

describe('GET /api/v1/health/readyz', () => {
  it('returns valid JSON with either 200 or 503 depending on DB availability', async () => {
    const res = await request(makeApp()).get('/api/v1/health/readyz');
    expect([200, 503]).toContain(res.status);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toBeTypeOf('object');
    expect(res.body.status).toBeTypeOf('string');
  });
});
