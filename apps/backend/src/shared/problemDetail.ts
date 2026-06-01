// RFC 7807 (Problem Details for HTTP APIs) helper.
//
// The error middleware already builds a problem object directly from HttpError. This helper
// is for *services* that want a structured error to attach to the HttpError before throwing
// (e.g. validation pipelines that aggregate field errors), or for non-throwing flows that
// need to embed a problem into a larger response (batch endpoints, dry-run results).
//
// Spec: https://datatracker.ietf.org/doc/html/rfc7807

import type { ProblemDetail } from '@spv/zod-schemas';
import type { HttpError } from './errors.js';

// Re-export the canonical RFC 7807 type so existing imports of
// `ProblemDetail` from this module continue to resolve.
export type { ProblemDetail };

// RFC 7807 permits arbitrary extension members on a problem object. The
// canonical zod-derived type is intentionally strict, so we widen it here
// for the writable bag used inside `toProblemDetail`.
type WritableProblemDetail = ProblemDetail & { [extension: string]: unknown };

export function toProblemDetail(
  err: Pick<HttpError, 'status' | 'type' | 'title' | 'detail' | 'errors'>,
  opts: { instance?: string; requestId?: string; extensions?: Record<string, unknown> } = {},
): ProblemDetail {
  const problem: WritableProblemDetail = {
    type: err.type || 'about:blank',
    title: err.title,
    status: err.status,
  };
  if (err.detail !== undefined) problem.detail = err.detail;
  if (err.errors !== undefined) problem.errors = err.errors;
  if (opts.instance !== undefined) problem.instance = opts.instance;
  if (opts.requestId !== undefined) problem.request_id = opts.requestId;
  if (opts.extensions) {
    for (const [k, v] of Object.entries(opts.extensions)) {
      // Don't let extensions overwrite the canonical fields.
      if (!(k in problem)) problem[k] = v;
    }
  }
  return problem;
}

/** Serialise a problem detail with the required content type. */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
