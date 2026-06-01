// OpenAPI spec contract test. Asserts that the assembled document is parseable,
// has the expected envelope, and covers a meaningful number of paths.

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Minimal env so config/env.ts can load when @spv/zod-schemas is reached.
vi.stubEnv('NODE_ENV', 'development');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3000');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const { openapiRouter } = await import('../src/modules/openapi/openapi.routes.js');

function makeApp() {
  const app = express();
  app.use('/api/v1', openapiRouter);
  return app;
}

describe('GET /api/v1/openapi.json', () => {
  it('returns 200 with a well-formed OpenAPI 3.1 document', async () => {
    const res = await request(makeApp()).get('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);

    // Round-trip through string -> JSON to prove it's machine-parseable.
    const round = JSON.parse(JSON.stringify(res.body));
    expect(round.openapi).toBe('3.1.0');
    expect(round.info?.title).toBe('Student Post-Visa Tracker API');

    const paths = Object.keys(round.paths ?? {});
    expect(paths.length).toBeGreaterThanOrEqual(30);

    expect(round.components?.securitySchemes?.bearerAuth).toBeDefined();
    expect(round.components?.securitySchemes?.bearerAuth?.scheme).toBe('bearer');

    expect(round.components?.responses?.Problem401).toBeDefined();
    expect(round.components?.responses?.Problem422).toBeDefined();
    expect(round.components?.responses?.Problem500).toBeDefined();
  });
});

describe('GET /api/v1/docs', () => {
  it('serves a Swagger UI HTML shell', async () => {
    const res = await request(makeApp()).get('/api/v1/docs');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('SwaggerUIBundle');
    expect(res.text).toContain('/api/v1/openapi.json');
  });
});
