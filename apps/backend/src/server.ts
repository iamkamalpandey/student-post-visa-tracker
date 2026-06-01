import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { disconnectDb } from './config/db.js';
import { startScheduler } from './jobs/scheduler.js';
import { initSentry, captureException } from './config/sentry.js';

// SVT-OBSERVABILITY-2026-05 — initialise Sentry as early as possible so
// import-time errors still surface. No-op when SENTRY_DSN is unset.
void initSentry();

// SVT-SEC-MFA-REPLAY-REDIS-2026-05 — multi-replica safety assertion.
//
// The MFA step-up middleware (middlewares/requireMfa.ts) keeps an anti-replay
// cache. When REDIS_URL is unset it falls back to an in-process Map; with >1
// backend replica behind a load balancer the same TOTP can then be replayed
// on a sibling replica. We log a loud WARN at boot in production unless the
// operator has explicitly acknowledged single-replica via env. We do NOT
// crash — single-replica is a perfectly valid topology (e.g. early-stage
// deployments, dev/sandbox tenants) and a hard exit would brick those.
if (env.NODE_ENV === 'production'
    && !process.env.REDIS_URL
    && process.env.SPV_ALLOW_SINGLE_REPLICA !== 'true') {
  logger.warn(
    'MFA replay cache is in-process — only safe for single-replica deployments. '
    + 'Set SPV_ALLOW_SINGLE_REPLICA=true to acknowledge, or set REDIS_URL for multi-replica.',
  );
}

// P1-WB6 (2026-05) — RESEND_WEBHOOK_SECRET is required in EVERY non-test
// environment (dev VM / staging / prod). The previous "warn + 503 per
// request" path meant an accidentally-exposed dev box would happily accept
// unauthenticated webhook bodies and the operator wouldn't notice until
// the first inbound delivery. Boot-time fail-fast (exit 1) is cheaper to
// detect — the orchestrator crash-loops the pod with a clear log line.
if (env.NODE_ENV !== 'test' && !process.env['RESEND_WEBHOOK_SECRET']) {
  logger.fatal(
    { nodeEnv: env.NODE_ENV },
    'RESEND_WEBHOOK_SECRET is required in this environment. ' +
    'Generate one in the Resend dashboard and set the env before booting.',
  );
  process.exit(1);
}

const app = createApp();

const server = app.listen(env.PORT, env.HOST, () => {
  logger.info({ port: env.PORT, host: env.HOST, env: env.NODE_ENV }, 'Backend listening');
  // Background workers (reminder dispatch + scan) only run outside tests so
  // the test suite stays deterministic and doesn't poll Postgres on a timer.
  if (env.NODE_ENV !== 'test') {
    schedulerHandle = startScheduler();
  }
});

// SVT-OBSERVABILITY-2026-06 — listen('error') handler. Without it, a bind
// failure (EADDRINUSE when the port is taken, EACCES on a privileged port)
// emits an 'error' event with no listener, which Node escalates to an
// unhandled exception and a noisy stack trace — confusing in an orchestrator's
// crash loop. Log a single structured fatal line with the offending host/port
// and exit non-zero so k8s / Fly.io / systemd restart cleanly.
server.on('error', (err: NodeJS.ErrnoException) => {
  try {
    captureException(err, { source: 'server.listen' });
  } catch { /* noop */ }
  logger.fatal(
    { err: { name: err.name, message: err.message, code: err.code }, port: env.PORT, host: env.HOST },
    err.code === 'EADDRINUSE'
      ? `Port ${env.PORT} is already in use — another process is bound to ${env.HOST}:${env.PORT}.`
      : 'HTTP server failed to start',
  );
  process.exit(1);
});

// SVT-OBSERVABILITY-2026-05 — Slowloris + RST-storm hardening.
//   keepAliveTimeout must be LESS THAN any fronting proxy's keepalive (most
//   prod proxies default to 60s); headersTimeout MUST be > keepAliveTimeout
//   so the socket can be retired cleanly. requestTimeout caps total request
//   wall-clock to defend against pathologically slow uploads.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 30_000;

let schedulerHandle: { stop: () => void } | undefined;

async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down');
  try {
    schedulerHandle?.stop();
  } catch (err) {
    logger.warn({ err }, 'scheduler stop threw during shutdown');
  }
  server.close(async () => {
    try {
      await disconnectDb();
    } catch (err) {
      logger.error({ err }, 'disconnectDb threw during shutdown');
    }
    process.exit(0);
  });
  // Close idle keep-alive sockets so server.close() resolves quickly even
  // when clients hold the connection open.
  try { (server as unknown as { closeIdleConnections?: () => void }).closeIdleConnections?.(); } catch { /* noop */ }
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// SVT-OBSERVABILITY-2026-05 — last-line-of-defence handlers. Without these
// an unhandled rejection in any async handler silently degrades the process
// (and in future Node versions crashes silently). Log structured and exit
// so the orchestrator (k8s / Fly.io / systemd) restarts cleanly.
process.on('uncaughtException', (err: Error) => {
  try {
    captureException(err, { source: 'uncaughtException' });
  } catch { /* noop */ }
  try {
    logger.fatal({ err: { name: err.name, message: err.message, stack: err.stack } }, 'uncaughtException — exiting');
  } catch { /* logger blew up; nothing more we can do */ }
  process.exit(1);
});
process.on('unhandledRejection', (reason: unknown) => {
  try {
    captureException(reason, { source: 'unhandledRejection' });
  } catch { /* noop */ }
  try {
    const r = reason as { name?: string; message?: string; stack?: string } | undefined;
    logger.fatal(
      { err: { name: r?.name, message: r?.message, stack: r?.stack } },
      'unhandledRejection — exiting',
    );
  } catch { /* noop */ }
  process.exit(1);
});
