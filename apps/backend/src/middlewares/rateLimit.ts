import rateLimit, { type Options } from 'express-rate-limit';
import type { Request } from 'express';
import { env } from '../config/env.js';

// SVT-WAVE-RATE-LIMIT-USER-2026-05 — per-user key generator used by
// expensive surfaces (exports, imports, dsar). Falls back to IP pre-auth so
// the limiter still works for unauthenticated probes. Multi-user offices
// behind one NAT egress no longer share a per-IP budget.
const perUserKey = (req: Request): string => {
  const sub = (req as { user?: { sub?: string } }).user?.sub;
  return sub ?? req.ip ?? 'unknown';
};

// Common JSON Problem Details payload for the per-user limiters below.
const tooManyBody = (detail: string): Options['message'] => ({
  type: 'about:blank',
  title: 'Too Many Requests',
  status: 429,
  detail,
});

// Per-IP global limiter. In prod swap the default memory store for a Redis-backed store
// (rate-limit-redis) so multiple instances share the counter.
export const globalLimiter = rateLimit({
  windowMs: 60_000,
  limit: env.RATE_LIMIT_GLOBAL_PER_MINUTE,
  standardHeaders: 'draft-7', // RFC 9239 RateLimit-* headers
  legacyHeaders: false,
});

export const authLimiter = rateLimit({
  windowMs: 60_000,
  limit: env.RATE_LIMIT_AUTH_PER_MINUTE,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    type: 'about:blank',
    title: 'Too Many Requests',
    status: 429,
    detail: 'Authentication rate limit exceeded; try again later.',
  },
});

// SVT-SEC-REFRESH-LIMITER-2026-06 — `/auth/refresh` must NOT share the 5/min
// login brute-force budget (authLimiter). Two reasons:
//   1. The refresh token is a 256-bit cryptographically-random value protected
//      by single-use rotation + reuse-detection + idle timeout — it is not
//      brute-forceable, so the only thing a tight limit buys is a DoS cap.
//   2. The SPA performs a silent `/auth/refresh` on EVERY full page load
//      (bootstrap) plus on access-token expiry. At 5/min/IP a handful of hard
//      refreshes — or several users behind one office NAT (very common in the
//      education sector) — exhaust the budget and get a 429, which the client
//      treats as "refresh failed" and bounces the user to /login. That is a
//      spurious logout, not a security event.
// 60/min/IP is generous enough that normal multi-tab / multi-user / reload
// behaviour never trips it, while still capping a runaway refresh loop.
export const refreshLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: tooManyBody('Refresh rate limit exceeded; try again later.'),
});

// SVT-WAVE60-RATE-LIMIT-2026-05 — audit chain verify is a full-table scan
// over audit_logs; an admin script hammering it could starve the DB. 5/min
// is plenty for human-triggered "check now"; alerting cron tasks run nightly.
export const auditVerifyLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    type: 'about:blank',
    title: 'Too Many Requests',
    status: 429,
    detail: 'Audit verify rate limit exceeded (5/min); try again later.',
  },
});

// Heavy admin reports (dashboard summaries, exports, etc.) — generous but
// capped so a misbehaving FE polling loop can't saturate the API.
export const heavyReadLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    type: 'about:blank',
    title: 'Too Many Requests',
    status: 429,
    detail: 'Report rate limit exceeded; try again later.',
  },
});

// SVT-SEC-AUDIT-2026-05 — per-IP cap on inbox mutations. Every authenticated
// user has an inbox so we deliberately do NOT role-gate `/inbox/*`; the
// trade-off is that `POST /messages/read-all` is cheap to spam (one UPDATE
// per call). 20/minute matches the human "I clicked Mark All Read a few
// times" UX while crushing any bot loop. Mounted per-route so the read GETs
// stay on the global limiter.
export const inboxMutationLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    type: 'about:blank',
    title: 'Too Many Requests',
    status: 429,
    detail: 'Inbox mutation rate limit exceeded (20/min); try again later.',
  },
});

// SVT-OBSERVABILITY-2026-05 — per-tenant limiter. Mount AFTER `authenticate`
// so req.user.tid is populated. Without this, a single noisy tenant behind a
// corporate NAT can consume the entire per-IP budget for every other tenant
// sharing the same public IP (very common in education sector with school
// network egress).
export const tenantLimiter = rateLimit({
  windowMs: 60_000,
  // 4x the per-IP global limit because tenants legitimately have multiple
  // simultaneous users; if a single tenant exceeds this, throttling is right.
  limit: Math.max(env.RATE_LIMIT_GLOBAL_PER_MINUTE * 4, 2400),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => {
    const tid = (req as { user?: { tid?: string } }).user?.tid;
    // Fall back to IP when missing (pre-auth, should never happen post-mount).
    return tid ?? req.ip ?? 'unknown';
  },
  message: {
    type: 'about:blank',
    title: 'Too Many Requests',
    status: 429,
    detail: 'Tenant rate limit exceeded; try again later.',
  },
});

// SVT-WAVE-RATE-LIMIT-EXPORTS-2026-05 — per-user cap on the bulk-export
// download surface. Downloads are heavy I/O (multi-MB CSV/JSONL) so 10/min
// is plenty for a human clicking "Download" + the occasional retry. Keyed
// per user (req.user.sub) so a multi-user office behind one IP isn't
// throttled as a group.
export const exportDownloadLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: perUserKey,
  message: tooManyBody('Export rate limit exceeded (10/min); try again later.'),
});

// SVT-WAVE-RATE-LIMIT-IMPORTS-2026-05 — per-user cap on bulk-import upload.
// 50MB uploads + parsing are expensive; 10/min matches the human "stage a
// few CSVs then apply" workflow while crushing a runaway script.
export const importsLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: perUserKey,
  message: tooManyBody('Import upload rate limit exceeded (10/min); try again later.'),
});

// SVT-WAVE-RATE-LIMIT-DSAR-2026-05 — DSAR mutation cap. 20/min/IP — DSAR
// intake is a regulator-clock event so we keep the budget moderate but
// non-zero; an operator legitimately filing several requests in a sitting
// must not be blocked.
export const dsarLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: tooManyBody('DSAR rate limit exceeded (20/min); try again later.'),
});
