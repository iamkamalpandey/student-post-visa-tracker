import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { HttpError } from '../shared/errors.js';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';

// RFC 7807 Problem Details. Default content type: application/problem+json.
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  const requestId = req.requestId;

  if (err instanceof ZodError) {
    const errors = err.issues.map((i) => ({
      path: i.path.join('.') || '(root)',
      message: i.message,
      code: i.code,
    }));
    res
      .status(422)
      .type('application/problem+json')
      .json({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'Request payload failed validation',
        instance: req.originalUrl,
        errors,
        request_id: requestId,
      });
    return;
  }

  if (err instanceof HttpError) {
    res
      .status(err.status)
      .type('application/problem+json')
      .json({
        type: err.type,
        title: err.title,
        status: err.status,
        detail: err.detail,
        // SVT-SEC-MFA-STEPUP-2026-05 — surface short machine-readable code
        // alongside human detail so clients can branch (e.g. mfa_required →
        // open inline TOTP prompt and retry).
        ...(err.code ? { code: err.code } : {}),
        instance: req.originalUrl,
        errors: err.errors,
        request_id: requestId,
      });
    return;
  }

  const rawMessage = err instanceof Error ? err.message : 'Unexpected error';
  logger.error({ err, requestId, route: req.originalUrl }, 'Unhandled error');

  // Sanitised detail for 5xx responses. We MUST NOT echo raw error messages,
  // because Prisma (and other libs) embed absolute filesystem paths, query
  // text, and schema details into their messages. Leaking those:
  //   - exposes the deployment layout (Windows paths, install dirs)
  //   - hands attackers an oracle for table/column names
  //   - violates the brief's explicit "never include stack/file/Prisma error
  //     message in 5xx" requirement.
  // In dev we still want *some* hint, so we surface only the error name +
  // a short generic descriptor; full details go to the structured logger.
  let detail = 'An unexpected error occurred';
  if (!env.isProd && err instanceof Error) {
    const errName = err.constructor?.name || 'Error';
    // Allowlist a handful of safe error-class names. For anything Prisma-shaped
    // (PrismaClientKnownRequestError, PrismaClientValidationError, etc.) we
    // surface the class name only — never the message body which contains
    // file paths and SQL fragments.
    const isPrismaError = errName.startsWith('PrismaClient');
    if (isPrismaError) {
      detail = `Database error (${errName}); see server logs for request_id ${requestId}`;
    } else {
      // Strip anything that looks like a path or stack-frame fragment before
      // surfacing the message. Defence-in-depth — even non-Prisma libs can
      // include local paths in their messages.
      const safe = rawMessage
        .replace(/[A-Za-z]:[\\/][^\s'"]+/g, '<path>') // Windows absolute paths
        .replace(/\/(?:[^\s'"/]+\/){2,}[^\s'"/]+/g, '<path>') // POSIX absolute paths
        .slice(0, 200);
      detail = safe || 'An unexpected error occurred';
    }
  }

  res
    .status(500)
    .type('application/problem+json')
    .json({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      detail,
      instance: req.originalUrl,
      request_id: requestId,
    });
}

export function notFoundHandler(req: Request, res: Response): void {
  res
    .status(404)
    .type('application/problem+json')
    .json({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: `No route matched ${req.method} ${req.originalUrl}`,
      instance: req.originalUrl,
      request_id: req.requestId,
    });
}
