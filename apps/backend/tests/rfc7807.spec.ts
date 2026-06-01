// Extra RFC 7807 (problem+json) coverage on top of errorHandler.spec.ts.
//
// Focus: the contract surface the frontend depends on.
//   - Validation errors (ZodError → 422) carry a per-field `errors[]` array with
//     {path, message, code} for each issue.
//   - `instance` always equals req.originalUrl, including query strings.
//   - `request_id` is present on every problem document.

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';

vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3000');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', '-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----');
vi.stubEnv('JWT_PUBLIC_KEY', '-----BEGIN PUBLIC KEY-----\nstub\n-----END PUBLIC KEY-----');
vi.stubEnv('JWT_KID', 'test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const { requestId } = await import('../src/middlewares/requestId.js');
const { errorHandler, notFoundHandler } = await import('../src/middlewares/errorHandler.js');
const { BadRequest, NotFound } = await import('../src/shared/errors.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(requestId);

  app.post('/validate', (req, _res, next) => {
    try {
      z.object({
        email: z.string().email(),
        age: z.number().int().min(0),
        nested: z.object({ pin: z.string().regex(/^\d{4}$/) }),
      }).parse(req.body);
      next(BadRequest('should not reach here'));
    } catch (e) {
      next(e);
    }
  });

  app.get('/lookup', (_req, _res, next) => next(NotFound('thing missing')));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

describe('RFC 7807 problem+json', () => {
  it('validation errors include errors[] with path + message + code per field', async () => {
    const res = await request(makeApp())
      .post('/validate')
      .send({ email: 'not-an-email', age: -1, nested: { pin: 'ab12' } });

    expect(res.status).toBe(422);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.length).toBeGreaterThanOrEqual(3);

    const paths = (res.body.errors as Array<{ path: string }>).map((e) => e.path);
    expect(paths).toContain('email');
    expect(paths).toContain('age');
    expect(paths).toContain('nested.pin');

    for (const e of res.body.errors as Array<{ path: string; message: string; code: string }>) {
      expect(typeof e.path).toBe('string');
      expect(typeof e.message).toBe('string');
      expect(typeof e.code).toBe('string');
    }
  });

  it('instance equals req.originalUrl including query string', async () => {
    const res = await request(makeApp())
      .get('/lookup?id=42&trace=on');
    expect(res.status).toBe(404);
    expect(res.body.instance).toBe('/lookup?id=42&trace=on');
  });

  it('request_id is present and non-empty on every problem document', async () => {
    const res1 = await request(makeApp()).get('/lookup');
    const res2 = await request(makeApp()).post('/validate').send({});
    const res3 = await request(makeApp()).get('/no-such-route');

    for (const r of [res1, res2, res3]) {
      expect(typeof r.body.request_id).toBe('string');
      expect((r.body.request_id as string).length).toBeGreaterThan(0);
    }
  });

  it('echoes incoming x-request-id back into both header and body', async () => {
    const incoming = '01234567-89ab-cdef-0123-456789abcdef';
    const res = await request(makeApp()).get('/lookup').set('x-request-id', incoming);
    expect(res.headers['x-request-id']).toBe(incoming);
    expect(res.body.request_id).toBe(incoming);
  });

  it('notFoundHandler serves problem+json with the offending path in instance', async () => {
    const res = await request(makeApp()).delete('/nope/here');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(res.body.instance).toBe('/nope/here');
    expect(res.body.title).toBe('Not Found');
    expect(typeof res.body.detail).toBe('string');
    expect(res.body.detail).toContain('DELETE');
  });
});
