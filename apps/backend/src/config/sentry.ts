// SVT-OBSERVABILITY-2026-05 — Sentry error tracking with PII scrubbing.
//
// Strategy:
//   - Dynamic import so the @sentry/node dep is optional. Production deploys
//     install it; dev/test runs without it pay zero penalty.
//   - SENTRY_DSN absent (or stub) = disabled — `init()` and `captureException`
//     become no-ops. Health checks + tests still pass.
//   - beforeSend recursively scrubs known PII keys + email/phone shapes from
//     extra/contexts/breadcrumbs to defend against future code paths that
//     attach raw req/resp objects to Sentry scope.
//   - tracesSampleRate is env-driven; default 5% in prod, 0% in dev/test.
//
// Wiring (in apps/backend/src/server.ts before app.listen()):
//
//   import { initSentry, sentryRequestHandler, sentryErrorHandler } from './config/sentry.js';
//   await initSentry();
//   app.use(sentryRequestHandler());  // BEFORE route handlers
//   ...
//   app.use(sentryErrorHandler());    // BEFORE the central errorHandler
//   app.use(errorHandler);

import { env } from './env.js';
import { logger } from './logger.js';

// Lazy-loaded Sentry types. We avoid a hard import so the dep stays optional.
type SentryScope = {
  setTag: (key: string, value: string | number | boolean) => void;
  setTags?: (tags: Record<string, string | number | boolean>) => void;
  setContext?: (name: string, ctx: Record<string, unknown> | null) => void;
  setExtra?: (key: string, value: unknown) => void;
  setUser?: (user: Record<string, unknown> | null) => void;
};

type SentryMod = {
  init: (opts: Record<string, unknown>) => void;
  Handlers?: { requestHandler?: () => unknown; errorHandler?: () => unknown };
  setupExpressErrorHandler?: (app: unknown) => void;
  expressIntegration?: () => unknown;
  captureException: (err: unknown, ctx?: Record<string, unknown>) => string;
  withScope?: (cb: (scope: SentryScope) => void) => void;
  // v8+ API
  startSpan?: <T>(
    ctx: { name: string; op?: string; attributes?: Record<string, unknown> },
    cb: (span: unknown) => T,
  ) => T;
  // v7 fallback
  startTransaction?: (ctx: { name: string; op?: string }) => { finish: () => void; setTag?: (k: string, v: string) => void };
};

let sentry: SentryMod | null = null;
let initialised = false;

const PII_KEYS = new Set([
  'password', 'token', 'authorization', 'set-cookie', 'cookie',
  'ssn', 'national_id', 'passport_number', 'visa_number', 'dob',
  'date_of_birth', 'mfa_secret', 'mfa_code', 'refresh_token',
  'access_token', 'sponsor_income', 'bank_account', 'iban', 'swift',
  'card_number', 'cvv', 'cvc', 'dek', 'kek',
]);

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_E164_RE = /\+[1-9]\d{1,14}/g;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function scrubString(s: string): string {
  return s
    .replace(EMAIL_RE, '[redacted-email]')
    .replace(PHONE_E164_RE, '[redacted-phone]');
}

/**
 * Recursive PII scrubber. Cycle-safe via WeakSet. Mutates a copy so the
 * original event isn't altered for other downstream consumers.
 */
export function scrubPii(input: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof input === 'string') return scrubString(input);
  if (Array.isArray(input)) {
    return input.map((v) => scrubPii(v, seen));
  }
  if (isObj(input)) {
    if (seen.has(input)) return '[circular]';
    seen.add(input);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      if (PII_KEYS.has(k.toLowerCase())) {
        out[k] = '[redacted]';
        continue;
      }
      if (k.toLowerCase().endsWith('_enc')) {
        // Encrypted ciphertext shouldn't leave the process either.
        out[k] = '[redacted-ciphertext]';
        continue;
      }
      out[k] = scrubPii(v, seen);
    }
    return out;
  }
  return input;
}

export async function initSentry(): Promise<void> {
  if (initialised) return;
  initialised = true;
  if (!env.SENTRY_DSN) {
    logger.warn('sentry: SENTRY_DSN unset — error tracking disabled');
    return;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore -- optional dep; resolved at runtime when installed
    const mod = (await import('@sentry/node')) as unknown as SentryMod;
    sentry = mod;
    sentry.init({
      dsn: env.SENTRY_DSN,
      environment: env.NODE_ENV,
      release: env.SENTRY_RELEASE ?? env.GIT_COMMIT ?? undefined,
      tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
      // Auto-scrub on every event. Sentry's `Anonymous` setting also helps
      // but doesn't catch our domain PII shapes.
      sendDefaultPii: false,
      beforeSend(event: Record<string, unknown>) {
        return scrubPii(event) as typeof event;
      },
      beforeBreadcrumb(crumb: Record<string, unknown>) {
        return scrubPii(crumb) as typeof crumb;
      },
    });
    logger.info({ release: env.SENTRY_RELEASE ?? env.GIT_COMMIT ?? 'unknown' }, 'sentry: initialised');
  } catch (err) {
    logger.warn({ err }, 'sentry: optional dep @sentry/node not installed — disabled');
    sentry = null;
  }
}

/** Express request-handler middleware (mount BEFORE routes). No-op when disabled. */
export function sentryRequestHandler() {
  return (_req: unknown, _res: unknown, next: () => void) => next();
  // When @sentry/node is installed and a v8+ surface is used, replace with:
  //   return sentry?.Handlers?.requestHandler?.() ?? ((_req, _res, next) => next());
  // (kept inert here because @sentry/node v8's `setupExpressErrorHandler` is the
  // canonical wire-up; the requestHandler shim is for v7 compatibility.)
}

/** Express error-handler middleware (mount BEFORE central errorHandler). */
// SVT-QA-2026-08 — previously called sentry.captureException(err) with no
// scope, so HTTP errors landed in Sentry with no tenant / user / request-id
// tags — impossible to correlate. Attach a per-invocation scope with the
// tenant id from the JWT, the user id from the JWT, and the request id from
// requestId middleware so incidents can be sliced by tenant + correlated to
// pino logs by request_id.
type MinReq = { user?: { tid?: string; sub?: string; role?: string }; requestId?: string; id?: string; method?: string; originalUrl?: string; url?: string };

export function sentryErrorHandler() {
  return (err: unknown, req: unknown, _res: unknown, next: (err: unknown) => void) => {
    const s = sentry;
    if (s) {
      try {
        const r = (req ?? {}) as MinReq;
        const tid = r.user?.tid;
        const sub = r.user?.sub;
        const role = r.user?.role;
        const reqId = r.requestId ?? r.id;
        if (s.withScope) {
          s.withScope((scope) => {
            if (tid) scope.setTag('tenant_id', tid);
            if (role) scope.setTag('role', role);
            if (reqId) scope.setTag('request_id', reqId);
            if (scope.setUser && (sub || tid)) scope.setUser({ id: sub, tenant_id: tid });
            if (scope.setContext) {
              scope.setContext('http', {
                method: r.method,
                url: r.originalUrl ?? r.url,
                request_id: reqId,
              });
            }
            s.captureException(err);
          });
        } else {
          s.captureException(err);
        }
      } catch { /* swallow — observability never breaks the host */ }
    }
    next(err);
  };
}

/** Explicit capture (for jobs / shared/ helpers). No-op when disabled. */
export function captureException(err: unknown, context?: Record<string, unknown>): void {
  if (!sentry) return;
  try {
    sentry.captureException(err, context ? { extra: scrubPii(context) as Record<string, unknown> } : undefined);
  } catch { /* swallow — observability never breaks the host */ }
}

// SVT-OBS-JOBS-2026-05 — background-job observability helpers. Cron + ad-hoc
// workers run without HTTP context, so the express request/error handlers
// never see their failures. These helpers attach `job` / `tenant_id` tags and
// optionally wrap the work in a span so p99 latency is trackable in Sentry
// Performance. All three are no-ops when Sentry is disabled.

export type JobCaptureTags = {
  job: string;
  tenant_id?: string | null;
  attempt?: number | null;
};

/**
 * Capture a thrown error from a background job with `job` + `tenant_id` tags
 * applied via an isolated scope. The scope does not leak across captures, so
 * tenant A's failure can never be attributed to tenant B.
 */
export function captureJobException(
  err: unknown,
  tags: JobCaptureTags,
  context?: Record<string, unknown>,
): void {
  if (!sentry) return;
  try {
    if (typeof sentry.withScope === 'function') {
      sentry.withScope((scope) => {
        scope.setTag('job', tags.job);
        if (tags.tenant_id) scope.setTag('tenant_id', tags.tenant_id);
        if (tags.attempt != null) scope.setTag('job.attempt', tags.attempt);
        if (context && scope.setContext) {
          scope.setContext('job', scrubPii(context) as Record<string, unknown>);
        }
        sentry!.captureException(err);
      });
      return;
    }
    // Fallback when withScope isn't exposed by the loaded module shape.
    sentry.captureException(err, {
      tags: tags as unknown as Record<string, unknown>,
      extra: context ? (scrubPii(context) as Record<string, unknown>) : undefined,
    });
  } catch { /* swallow */ }
}

/**
 * Run `fn` inside an isolated Sentry scope tagged with `tenant_id` (+ extra
 * tags). Used by per-tenant fan-out loops so a failure surfaces with the
 * right tenant attribution and no leakage into the next iteration. Sentry
 * disabled → the callback is invoked directly, no wrapper cost.
 */
export async function withTenantScope<T>(
  tenantId: string,
  jobName: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!sentry || typeof sentry.withScope !== 'function') {
    return fn();
  }
  // withScope is synchronous, so we capture the promise and await it outside.
  let p: Promise<T> | null = null;
  sentry.withScope((scope) => {
    scope.setTag('job', jobName);
    scope.setTag('tenant_id', tenantId);
    p = fn();
  });
  // `p` is set synchronously by the callback above (withScope invokes it
  // before returning), so this assertion is safe.
  return await (p as unknown as Promise<T>);
}

/**
 * Wrap `fn` in a Sentry span (v8 API) or transaction (v7 fallback) so the
 * job's duration is recorded in Sentry Performance. Disabled-Sentry path just
 * calls `fn` directly.
 */
export async function startJobSpan<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!sentry) return fn();
  // Pick a wrapper exactly once. We must NEVER catch-and-retry here:
  // re-invoking `fn` on a thrown-job path would double-execute the work and
  // corrupt downstream side effects (extra DB writes, duplicate sends, etc.).
  // If the span wrapper itself blows up at construction time, we fall back to
  // a bare `fn()` call — but only if `fn` hasn't started yet.
  if (typeof sentry.startSpan === 'function') {
    try {
      return await sentry.startSpan(
        { name: `job.${name}`, op: 'queue.task.cron' },
        () => fn(),
      );
    } catch (err) {
      // Sentry surfaced an error from `fn` (or rarely, from its own span
      // bookkeeping). Either way `fn` has already run — propagate so withRetry
      // can record the failure. Do NOT re-call `fn` here.
      throw err;
    }
  }
  if (typeof sentry.startTransaction === 'function') {
    let tx: { finish: () => void } | null = null;
    try {
      tx = sentry.startTransaction({ name: `job.${name}`, op: 'queue.task.cron' });
    } catch { /* swallow — fall through to bare fn */ }
    if (tx) {
      try {
        return await fn();
      } finally {
        try { tx.finish(); } catch { /* swallow */ }
      }
    }
  }
  return fn();
}

// Test hook — lets the jobs-sentry spec inject a mock Sentry module without
// requiring @sentry/node to be installed in the test environment.
export function _setSentryForTests(mod: SentryMod | null): void {
  sentry = mod;
  initialised = mod != null;
}
