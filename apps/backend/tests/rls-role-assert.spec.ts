// SVT-SEC-RLS-ROLE-ASSERT-2026-06 — the boot guard that refuses to serve in
// production on a runtime DB role that bypasses RLS (superuser/BYPASSRLS),
// which would silently disable tenant isolation. Covers the non-exit branches
// (prod-exit needs a full prod env and is asserted by the fatal-log path).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
vi.stubEnv('NODE_ENV', 'test');
vi.stubEnv('CORS_ORIGIN', 'http://localhost:3000');
vi.stubEnv('DATABASE_URL', 'postgresql://x:x@localhost:5432/x');
vi.stubEnv('JWT_PRIVATE_KEY', privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
vi.stubEnv('JWT_PUBLIC_KEY', publicKey.export({ type: 'spki', format: 'pem' }) as string);
vi.stubEnv('JWT_KID', 'test-kid');
vi.stubEnv('JWT_ISSUER', 'spv-api-test');
vi.stubEnv('JWT_AUDIENCE', 'spv-app-test');
vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.com');
vi.stubEnv('SEED_ADMIN_PASSWORD', 'ChangeMeNow!2026');

const queryRawMock = vi.fn();
vi.mock('@prisma/client', () => ({
  PrismaClient: vi.fn(() => ({
    $on: vi.fn(),
    $queryRaw: queryRawMock,
    $disconnect: vi.fn(),
  })),
}));

const { assertRuntimeRoleRespectsRls } = await import('../src/config/db.js');

describe('assertRuntimeRoleRespectsRls', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    queryRawMock.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  it('passes silently for a de-privileged role (no exit)', async () => {
    queryRawMock.mockResolvedValue([{ rolname: 'spv_app', rolsuper: false, rolbypassrls: false }]);
    await expect(assertRuntimeRoleRespectsRls()).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('does NOT exit in non-production even on a superuser role (warns instead)', async () => {
    queryRawMock.mockResolvedValue([{ rolname: 'doadmin', rolsuper: true, rolbypassrls: false }]);
    await assertRuntimeRoleRespectsRls();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('does NOT exit for a BYPASSRLS role in non-production', async () => {
    queryRawMock.mockResolvedValue([{ rolname: 'ingest', rolsuper: false, rolbypassrls: true }]);
    await assertRuntimeRoleRespectsRls();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('skips gracefully when the DB is unreachable (no throw, no exit)', async () => {
    queryRawMock.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(assertRuntimeRoleRespectsRls()).resolves.toBeUndefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
