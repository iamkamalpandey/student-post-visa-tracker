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
const { BadRequest, NotFound, Unauthorized, Conflict } = await import('../src/shared/errors.js');

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(requestId);

  app.get('/throw/zod', (_req, _res, next) => {
    try {
      z.object({ email: z.string().email() }).parse({ email: 'not-an-email' });
      next();
    } catch (e) {
      next(e);
    }
  });
  app.get('/throw/badrequest', (_req, _res, next) => next(BadRequest('field x is bad')));
  app.get('/throw/unauthorized', (_req, _res, next) => next(Unauthorized()));
  app.get('/throw/notfound', (_req, _res, next) => next(NotFound('thing missing')));
  app.get('/throw/conflict', (_req, _res, next) => next(Conflict('etag stale')));
  app.get('/throw/generic', (_req, _res, next) => next(new Error('boom')));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const PROBLEM = /^application\/problem\+json/;

function assertProblemShape(body: unknown, expectedStatus: number, instance: string) {
  expect(body).toBeTypeOf('object');
  const b = body as Record<string, unknown>;
  expect(b['type']).toBeTypeOf('string');
  expect(b['title']).toBeTypeOf('string');
  expect(b['status']).toBe(expectedStatus);
  expect(b['instance']).toBe(instance);
  expect(b['request_id']).toBeTypeOf('string');
  expect((b['request_id'] as string).length).toBeGreaterThan(0);
}

describe('errorHandler (RFC 7807)', () => {
  it('maps ZodError to 422 with field errors', async () => {
    const res = await request(makeApp()).get('/throw/zod');
    expect(res.status).toBe(422);
    expect(res.headers['content-type']).toMatch(PROBLEM);
    assertProblemShape(res.body, 422, '/throw/zod');
    expect(Array.isArray(res.body.errors)).toBe(true);
    expect(res.body.errors.length).toBeGreaterThan(0);
    expect(res.body.errors[0]).toHaveProperty('path');
    expect(res.body.errors[0]).toHaveProperty('message');
  });

  it('maps HttpError variants to their status codes', async () => {
    const cases: Array<{ path: string; status: number; title: string }> = [
      { path: '/throw/badrequest', status: 400, title: 'Bad Request' },
      { path: '/throw/unauthorized', status: 401, title: 'Unauthorized' },
      { path: '/throw/notfound', status: 404, title: 'Not Found' },
      { path: '/throw/conflict', status: 409, title: 'Conflict' },
    ];
    for (const c of cases) {
      const res = await request(makeApp()).get(c.path);
      expect(res.status).toBe(c.status);
      expect(res.headers['content-type']).toMatch(PROBLEM);
      assertProblemShape(res.body, c.status, c.path);
      expect(res.body.title).toBe(c.title);
    }
  });

  it('maps generic Error to 500 with problem+json shape', async () => {
    const res = await request(makeApp()).get('/throw/generic');
    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(PROBLEM);
    assertProblemShape(res.body, 500, '/throw/generic');
    expect(res.body.title).toBe('Internal Server Error');
  });

  it('echoes incoming x-request-id when valid', async () => {
    const incoming = 'abcdefgh-incoming-id-1234';
    const res = await request(makeApp())
      .get('/throw/badrequest')
      .set('x-request-id', incoming);
    expect(res.headers['x-request-id']).toBe(incoming);
    expect(res.body.request_id).toBe(incoming);
  });

  it('notFoundHandler returns problem+json 404', async () => {
    const res = await request(makeApp()).get('/no/such/route');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(PROBLEM);
    assertProblemShape(res.body, 404, '/no/such/route');
  });
});
