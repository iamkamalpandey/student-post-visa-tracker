// HTTP controller for export endpoints. Validates the create payload, hands off to the
// service, and streams the produced file through a single-use signed URL.
//
// Auth posture:
//   - Every endpoint requires authenticate + tenantContext (mounted in app.ts).
//   - POST /exports — any role except VIEWER (counsellors and admins can export their own
//     working set; PII redaction is on by default).
//   - GET /exports/:job_id — owner or admin.
//   - GET /exports/:job_id/download — owner or admin AND a valid single-use nonce.
//   - POST /exports/:job_id/cancel — owner or admin (further enforced in the service).

import type { Request, Response, NextFunction } from 'express';
import { CreateExportRequest } from '@spv/zod-schemas';
import { BadRequest, Forbidden, NotFound, Unauthorized } from '../../shared/errors.js';
import {
  enqueueExport,
  signedDownload,
  getJob,
  cancelJob,
  consumeNonce,
  streamFor,
} from './exports.service.js';

function ctxFrom(req: Request) {
  if (!req.user) throw Unauthorized();
  return {
    tenantId: req.user.tid,
    userId: req.user.sub,
    role: req.user.role,
    ip: req.ip ?? null,
    ua: req.header('user-agent') ?? null,
    requestId: (req as { requestId?: string }).requestId ?? null,
  };
}

export async function postExport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ctx = ctxFrom(req);
    if (ctx.role === 'VIEWER') throw Forbidden('Viewer role cannot create exports');
    const parsed = CreateExportRequest.safeParse(req.body);
    if (!parsed.success) {
      throw BadRequest('Invalid export payload');
    }
    // Defensive: only ADMIN may turn redaction off (full PII export).
    if (parsed.data.redact_pii === false && ctx.role !== 'ADMIN') {
      throw Forbidden('Only ADMIN may request full-PII (non-redacted) exports');
    }
    const job = await enqueueExport(ctx, parsed.data);
    res.status(202).json({
      id: job.id,
      status: job.status,
    });
  } catch (err) {
    next(err);
  }
}

export async function getExportJob(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ctx = ctxFrom(req);
    const job = await getJob(ctx, String(req.params['job_id']));
    if (job.status === 'COMPLETED') {
      const dl = await signedDownload(ctx, job.id);
      res.json({
        id: job.id,
        status: job.status,
        sha256: job.sha256,
        download_url: dl.url,
        expires_at: dl.expires_at,
        row_total: job.row_total,
      });
      return;
    }
    res.json({ id: job.id, status: job.status });
  } catch (err) {
    next(err);
  }
}

export async function getDownload(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // SVT-RLS-2026-05: prevent shared/proxy caches from retaining sensitive bytes.
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    const ctx = ctxFrom(req);
    const jobId = String(req.params['job_id']);
    const nonce = String(req.query['nonce'] ?? '');
    if (!nonce) throw BadRequest('Missing nonce');
    // SEC-burst: bind nonce to the issuing user so a leaked URL can't be
    // replayed by a different user in the same tenant.
    const ok = consumeNonce(nonce, jobId, ctx.userId ?? null);
    if (!ok.ok) throw NotFound('Invalid or expired download URL');
    if (ok.tenantId !== ctx.tenantId) throw Forbidden();
    const { job, buf } = await streamFor(ctx.tenantId, jobId);
    res.setHeader('Content-Type', contentType(job.format));
    res.setHeader('Content-Disposition', `attachment; filename="${job.resource}-${jobId}.${job.format}"`);
    if (job.sha256) res.setHeader('X-Content-SHA256', job.sha256);
    res.send(buf);
  } catch (err) {
    next(err);
  }
}

export async function postCancelExport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ctx = ctxFrom(req);
    const job = await cancelJob(ctx, String(req.params['job_id']));
    res.json(job);
  } catch (err) {
    next(err);
  }
}

function contentType(fmt: string): string {
  switch (fmt) {
    case 'csv': return 'text/csv; charset=utf-8';
    case 'json': return 'application/json';
    case 'jsonl': return 'application/x-ndjson';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    default: return 'application/octet-stream';
  }
}
