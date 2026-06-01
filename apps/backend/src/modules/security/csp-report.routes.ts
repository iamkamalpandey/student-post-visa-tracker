// SVT-SEC-P2-FE3-2026-05 — Content-Security-Policy violation report sink.
//
// Browsers POST a JSON document to the URL named by the CSP `report-uri`
// directive whenever they block a resource. This endpoint:
//   * Is public — browsers don't send credentials with report-uri requests,
//     and gating on auth would silently drop every report.
//   * Is rate-limited (10/min/IP) — a runaway browser tab can fire dozens of
//     reports per page load; cap the surface so it can't be turned into a
//     log-volume DoS by a malicious page.
//   * Accepts both the legacy `application/csp-report` shape and the modern
//     `application/reports+json` shape (the Reports API delivery). Express's
//     JSON parser only handles `application/json` by default; we widen it
//     locally so we don't have to special-case the global parser.
//   * Logs a structured `csp_violation` event via pino so the existing
//     redaction/observability pipeline picks it up.
//   * Returns 204 (No Content) — browsers ignore the response body anyway.

import { Router, type Request, type Response } from 'express';
import express from 'express';
import rateLimit from 'express-rate-limit';

import { logger } from '../../config/logger.js';

// 10/min/IP — generous enough that a real page load with a handful of
// CSP-blocked legacy assets won't get throttled, strict enough that an
// attacker page firing thousands of violations to inflate logs is capped.
const cspReportLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // No body on 429 — browsers ignore it; the rate-limit header is enough.
  message: { type: 'about:blank', title: 'Too Many Requests', status: 429 },
});

// Parse the two report MIME types the browser can send. We do NOT use the
// global express.json() middleware here because reports use bespoke content-
// types that the global parser would drop on the floor.
const cspBodyParser = express.json({
  type: ['application/csp-report', 'application/reports+json', 'application/json'],
  limit: '32kb',
});

type LegacyCspReport = {
  'csp-report'?: Record<string, unknown>;
};

// The Reports API delivers an array of report envelopes.
type ReportsApiEnvelope = {
  type?: string;
  age?: number;
  url?: string;
  body?: Record<string, unknown>;
};

function pickReportFields(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return { shape: 'unknown' };

  // Legacy single-report shape: { "csp-report": { ... } }
  const legacy = (body as LegacyCspReport)['csp-report'];
  if (legacy && typeof legacy === 'object') {
    return {
      shape: 'legacy',
      blocked_uri: legacy['blocked-uri'] ?? legacy['blockedURL'] ?? null,
      violated_directive: legacy['violated-directive'] ?? legacy['effectiveDirective'] ?? null,
      document_uri: legacy['document-uri'] ?? legacy['documentURL'] ?? null,
      original_policy: legacy['original-policy'] ?? null,
      script_sample: legacy['script-sample'] ?? null,
      disposition: legacy['disposition'] ?? null,
      source_file: legacy['source-file'] ?? null,
      line_number: legacy['line-number'] ?? null,
    };
  }

  // Reports API shape: array of envelopes whose `body` is the actual CSP report.
  if (Array.isArray(body)) {
    const envelopes = body as ReportsApiEnvelope[];
    return {
      shape: 'reports_api',
      count: envelopes.length,
      // Summarise the first envelope for log scanability; the others are
      // typically duplicates within a single batch.
      first: envelopes[0]?.body ?? null,
    };
  }

  return { shape: 'unknown' };
}

export const cspReportRouter: Router = Router();

cspReportRouter.post(
  '/report',
  cspReportLimiter,
  cspBodyParser,
  (req: Request, res: Response) => {
    const summary = pickReportFields(req.body);
    logger.warn(
      {
        event: 'csp_violation',
        ip: req.ip,
        user_agent: req.get('user-agent') ?? null,
        ...summary,
      },
      'CSP violation report received',
    );
    res.status(204).end();
  },
);

// SVT-SEC-P2-FE4-2026-05 — paired sink for in-app error boundaries. Receives a
// tiny JSON envelope { name, digest } (no message, no stack — sanitisation
// happens on the client) and emits a structured pino event. Public + rate-
// limited for the same DoS reasons as the CSP sink above.
const errorReportLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { type: 'about:blank', title: 'Too Many Requests', status: 429 },
});

const errorBodyParser = express.json({ type: 'application/json', limit: '4kb' });

export const errorReportRouter: Router = Router();

errorReportRouter.post(
  '/error-report',
  errorReportLimiter,
  errorBodyParser,
  (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body['name'] === 'string' ? (body['name'] as string).slice(0, 200) : null;
    const digest = typeof body['digest'] === 'string' ? (body['digest'] as string).slice(0, 200) : null;
    const route = typeof body['route'] === 'string' ? (body['route'] as string).slice(0, 80) : null;
    logger.warn(
      {
        event: 'frontend_error_report',
        ip: req.ip,
        user_agent: req.get('user-agent') ?? null,
        error_name: name,
        error_digest: digest,
        boundary: route,
      },
      'Frontend error boundary reported',
    );
    res.status(204).end();
  },
);
