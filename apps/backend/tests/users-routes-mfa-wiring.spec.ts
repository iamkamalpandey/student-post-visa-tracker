// SVT-SEC-2026-08 — every mutating route on the users router must carry the
// MFA step-up gate, asserted against the REAL source file.
//
// Why a source-level test rather than a behavioural one:
//
// tests/users-admin-mfa-routes.spec.ts exercises the gate through supertest,
// but it cannot mount the real router — `usersRouter.use(authenticate,
// tenantContext)` would demand a real JWT — so it re-declares the routes in a
// local express app and asserts a COPY of the wiring. That copy is a faithful
// mirror today, and nothing keeps it faithful tomorrow: delete `requireMfa`
// from the production router and every one of those tests still passes.
//
// That is exactly how the create-route hole survived. `POST /users` was exempt
// on the reasoning that it "doesn't mutate existing accounts" — true, and beside
// the point, because `role` is client-supplied and RoleEnum includes ADMIN. A
// stolen admin token that could not patch, delete, reset or revoke anything
// could still mint a fresh ADMIN with a chosen password and no MFA, then log in
// as it. Persistence beats any single mutation the gate was guarding.
//
// So this test reads the router source and checks the wiring directly. It
// cannot be satisfied by a mirror drifting out of sync.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROUTES = resolve(__dirname, '..', 'src', 'modules', 'users', 'users.routes.ts');

/**
 * Split the file into one chunk per `usersRouter.<verb>(...)` registration.
 * Brace/paren matching would be overkill — each registration ends at the next
 * `usersRouter.` or EOF, which is unambiguous in this file's style.
 */
function routeRegistrations(src: string): Array<{ verb: string; path: string; body: string }> {
  const out: Array<{ verb: string; path: string; body: string }> = [];
  const re = /usersRouter\.(get|post|patch|put|delete)\(\s*(['"`])([^'"`]*)\2/g;
  const starts: Array<{ verb: string; path: string; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    starts.push({ verb: m[1]!, path: m[3]!, index: m.index });
  }
  for (let i = 0; i < starts.length; i += 1) {
    const s = starts[i]!;
    const end = i + 1 < starts.length ? starts[i + 1]!.index : src.length;
    out.push({ verb: s.verb, path: s.path, body: src.slice(s.index, end) });
  }
  return out;
}

const src = readFileSync(ROUTES, 'utf8');
const registrations = routeRegistrations(src);

describe('users router — MFA step-up wiring', () => {
  it('finds the route registrations at all (guards the parser itself)', () => {
    // If this drops to zero the rest of the file would pass vacuously.
    expect(registrations.length).toBeGreaterThanOrEqual(6);
    expect(registrations.some((r) => r.verb === 'post' && r.path === '/')).toBe(true);
  });

  it('gates EVERY mutating route with requireMfa({ enrollmentRequired: true })', () => {
    const mutating = registrations.filter((r) => r.verb !== 'get');
    const ungated = mutating
      .filter((r) => !/requireMfa\(\s*\{[^}]*enrollmentRequired:\s*true/.test(r.body))
      .map((r) => `${r.verb.toUpperCase()} ${r.path}`);
    expect(ungated).toEqual([]);
  });

  it('gates user CREATE specifically — the exemption that let a stolen token mint an ADMIN', () => {
    const create = registrations.find((r) => r.verb === 'post' && r.path === '/');
    expect(create).toBeTruthy();
    expect(create!.body).toMatch(/requireMfa\(\s*\{[^}]*enrollmentRequired:\s*true/);
  });

  it('still requires the ADMIN role on every mutating route', () => {
    const mutating = registrations.filter((r) => r.verb !== 'get');
    const unroled = mutating
      .filter((r) => !/requireRole\(\s*'ADMIN'\s*\)/.test(r.body))
      .map((r) => `${r.verb.toUpperCase()} ${r.path}`);
    expect(unroled).toEqual([]);
  });

  it('leaves the read routes ungated, so the gate is not just "everything"', () => {
    // A test that passed because EVERY route were gated would not prove the
    // rule is being applied deliberately. Reads legitimately stay open.
    const reads = registrations.filter((r) => r.verb === 'get');
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) {
      expect(r.body).not.toMatch(/requireMfa/);
    }
  });
});
