// RFC 7807 Problem Details + an HttpError class the error middleware understands.

export class HttpError extends Error {
  status: number;
  type: string;
  title: string;
  detail?: string;
  // Machine-readable short code (e.g. 'mfa_required'). Optional; surfaced as
  // `code` on the JSON Problem Detail so the FE can branch without parsing
  // free-text `detail`. Keep short snake_case.
  code?: string;
  errors?: Array<{ path: string; message: string; code?: string }>;

  constructor(opts: {
    status: number;
    title: string;
    type?: string;
    detail?: string;
    code?: string;
    errors?: HttpError['errors'];
  }) {
    super(opts.detail ?? opts.title);
    this.status = opts.status;
    this.type = opts.type ?? 'about:blank';
    this.title = opts.title;
    if (opts.detail !== undefined) this.detail = opts.detail;
    if (opts.code !== undefined) this.code = opts.code;
    if (opts.errors !== undefined) this.errors = opts.errors;
  }
}

export const BadRequest = (detail?: string, errors?: HttpError['errors']) =>
  new HttpError({ status: 400, title: 'Bad Request', detail, errors });

export const Unauthorized = (detail = 'Authentication required', code?: string) =>
  new HttpError({ status: 401, title: 'Unauthorized', detail, code });

export const Forbidden = (detail = 'Access denied') =>
  new HttpError({ status: 403, title: 'Forbidden', detail });

export const NotFound = (detail = 'Resource not found') =>
  new HttpError({ status: 404, title: 'Not Found', detail });

export const Conflict = (detail = 'Conflict') =>
  new HttpError({ status: 409, title: 'Conflict', detail });

export const PreconditionFailed = (detail = 'If-Match precondition failed') =>
  new HttpError({ status: 412, title: 'Precondition Failed', detail });

// 413 Payload Too Large — used by the export pipeline pre-flight to reject
// jobs whose estimated byte budget would OOM the buffer-mode writer. v1.1
// will swap this for a true streaming put (storage.put(Readable)) at which
// point the cap can be lifted; see exports.service.ts runExport().
export const PayloadTooLarge = (detail = 'Payload too large', code?: string) =>
  new HttpError({ status: 413, title: 'Payload Too Large', detail, code });

export const UnprocessableEntity = (detail?: string, errors?: HttpError['errors']) =>
  new HttpError({ status: 422, title: 'Unprocessable Entity', detail, errors });

export const TooMany = (detail = 'Too many requests') =>
  new HttpError({ status: 429, title: 'Too Many Requests', detail });

export const InternalError = (detail = 'Internal server error') =>
  new HttpError({ status: 500, title: 'Internal Server Error', detail });

export const ServiceUnavailable = (detail = 'Service temporarily unavailable') =>
  new HttpError({ status: 503, title: 'Service Unavailable', detail });
