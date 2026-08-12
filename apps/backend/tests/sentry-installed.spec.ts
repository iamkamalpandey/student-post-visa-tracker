// SVT-OBS-2026-08 — error tracking must actually be installed.
//
// config/sentry.ts imports @sentry/node DYNAMICALLY and swallows the failure:
//
//   catch (err) { logger.warn('sentry: optional dep @sentry/node not installed — disabled'); }
//
// That is the right behaviour for a dev box and a catastrophe in production,
// because the failure mode is a single WARN line at boot and then silence. The
// package was absent from pnpm-lock.yaml entirely, so every deployment ran with
// no error tracking at all while the code read as fully instrumented — nothing
// pointed at 500s, failed payment writes, or crashed cron jobs.
//
// This test fails the build if the dependency is ever dropped again, and if the
// upstream API surface config/sentry.ts relies on stops existing.

import { describe, it, expect } from 'vitest';

// SVT-OBS-2026-08 — the import lives at MODULE scope on purpose.
//
// It was originally `await import('@sentry/node')` inside each test. Sentry v10
// auto-instruments Node's http/https stack on load, which costs ~1s, and four
// tests each entering that path made the file intermittently blow the 20s test
// timeout under full-suite parallelism. It passed alone and failed in the suite
// — a flaky test, which is worse than no test, because it teaches everyone to
// ignore a red run.
//
// Hoisting it means the load happens once during collection, and each test then
// asserts against an already-resolved module.
const sentry = (await import('@sentry/node')) as unknown as Record<string, unknown>;
const pkg = (await import('../package.json', { with: { type: 'json' } })).default as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe('@sentry/node is a real installed dependency', () => {
  it('resolves at runtime — the "optional dep not installed" path is dead', () => {
    expect(sentry).toBeTruthy();
  });

  it('is declared in package.json dependencies, not devDependencies', () => {
    expect(pkg.dependencies?.['@sentry/node']).toBeTruthy();
    expect(pkg.devDependencies?.['@sentry/node']).toBeUndefined();
  });

  it('exposes every API config/sentry.ts calls', () => {
    // Used unconditionally in initSentry / sentryErrorHandler / captureException.
    expect(typeof sentry.init).toBe('function');
    expect(typeof sentry.captureException).toBe('function');
    // Optional-chained in sentryErrorHandler, but its absence would silently
    // drop the tenant/user/request-id tagging that makes an incident traceable.
    expect(typeof sentry.withScope).toBe('function');
  });

  it('scope objects expose the tagging methods incidents are sliced by', () => {
    let seen: string[] = [];
    // withScope works without init(); the scope is a real object either way.
    (sentry.withScope as (cb: (s: Record<string, unknown>) => void) => void)((scope) => {
      seen = ['setTag', 'setUser', 'setContext'].filter(
        (m) => typeof scope[m] === 'function',
      );
    });
    expect(seen).toEqual(['setTag', 'setUser', 'setContext']);
  });
});
