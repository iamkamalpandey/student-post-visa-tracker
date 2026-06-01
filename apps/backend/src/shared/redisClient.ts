// SVT-SEC-MFA-REPLAY-REDIS-2026-05 — shared Redis client surface.
//
// Status: the repo requires REDIS_URL in env (config/env.ts) but has not yet
// wired a concrete Redis client — every cross-replica feature so far is
// either DB-backed (idempotency_records via Postgres) or in-process. This
// module is the lazy entry-point so that the first consumer that genuinely
// needs Redis (right now: the MFA step-up anti-replay cache) can opt in
// without dragging the rest of the codebase into a synchronous Redis dep.
//
// Design notes:
//   - Dynamic `import('redis')` so a missing optional dep doesn't crash boot
//     or break tests. Operators who set REDIS_URL must `pnpm add redis` on
//     the backend workspace; until they do we return null and callers fall
//     back to their in-process implementation. The boot-time warning in
//     server.ts makes the gap loud.
//   - Duck-typed `RedisLikeClient` lets the middleware unit-test against a
//     hand-rolled mock (vi.fn-shaped) without pulling the redis types.
//   - Single shared connection per process; the module-level promise cache
//     guarantees we never open a second TCP connection to Redis even under
//     parallel first-use racing.

import { logger } from '../config/logger.js';

/**
 * Minimal surface of a Redis client we depend on. Matches the shape of both
 * `node-redis` v4+ and `ioredis` for `SET key value NX EX seconds`. The
 * return value is the human OK string ('OK') on first-write success or null
 * on NX miss (key already exists). Anything else is treated as a failure
 * and the caller MUST fail-open to avoid bricking step-up MFA when Redis
 * is momentarily unavailable.
 */
export type RedisLikeClient = {
  set(
    key: string,
    value: string,
    options: { NX: true; EX: number },
  ): Promise<string | null>;
};

let cached: Promise<RedisLikeClient | null> | null = null;

/**
 * Returns a shared Redis client when REDIS_URL is set AND the optional
 * `redis` package is installed. Otherwise returns null and the caller
 * should fall back to its in-process implementation.
 *
 * Never throws — connection errors are logged and surfaced as `null`.
 */
export function getRedisClient(): Promise<RedisLikeClient | null> {
  if (cached) return cached;
  cached = (async (): Promise<RedisLikeClient | null> => {
    const url = process.env.REDIS_URL;
    if (!url) return null;
    try {
      // The `redis` package is an OPTIONAL dependency: if a deployment has
      // set REDIS_URL but not installed the client, we degrade rather than
      // crash. The server.ts boot warning surfaces the misconfiguration.
      //
      // The module specifier is held in a variable so TypeScript does not try
      // to resolve `redis` at compile time (it's not in package.json — opting
      // in is `pnpm --filter backend add redis`). The Function indirection
      // also keeps esbuild / tsc from statically tracing the dependency.
      const moduleName = 'redis';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-implied-eval
      const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<any>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod: any = await dynamicImport(moduleName).catch(() => null);
      if (!mod || typeof mod.createClient !== 'function') {
        logger.warn(
          'REDIS_URL is set but the `redis` package is not installed; cross-replica features will degrade. Run `pnpm --filter backend add redis`.',
        );
        return null;
      }
      const client = mod.createClient({ url });
      client.on?.('error', (err: unknown) => {
        logger.error({ err }, 'redis client error');
      });
      await client.connect();
      logger.info('redis client connected');
      return client as RedisLikeClient;
    } catch (err) {
      logger.error({ err }, 'failed to connect to redis; falling back to in-process stores');
      return null;
    }
  })();
  return cached;
}

/** Test-only reset hook so specs can re-inject a mock client between cases. */
export function __resetRedisClientForTests(): void {
  cached = null;
}
