// HTTP layer for the Documents module.
// ----------------------------------------------------------------------------
// Controllers stay thin: they unwrap the request, call the service, and shape
// the response. Validation runs as middleware (validate() + zod) where the
// payload is JSON; multipart uploads use multer + a manual JSON.parse for the
// metadata field, which we then run through UploadDocumentMetadata.

import type { Request, Response, NextFunction } from 'express';
import type { PrismaClient } from '@prisma/client';
import type { z } from 'zod';
import { UploadDocumentMetadata, VerifyDocumentRequest } from '@spv/zod-schemas';
import { BadRequest, Unauthorized } from '../../shared/errors.js';
import { prisma } from '../../config/db.js';
import * as svc from './documents.service.js';

function requireUser(req: Request) {
  if (!req.user) throw Unauthorized();
  return req.user;
}

// Prefer the RLS-scoped tx attached by tenantContext middleware (req.db).
// Fall back to the singleton for code paths that bypass HTTP (background jobs,
// tests). Mirrors apps/backend/src/modules/students/students.types.ts:dbFor.
function dbFor(req: Request): PrismaClient {
  return ((req.db as unknown as PrismaClient) ?? prisma);
}

function ctxFromReq(req: Request): svc.ServiceContext {
  return {
    db: dbFor(req),
    user: requireUser(req),
    ip: req.ip ?? null,
    ua: req.header('user-agent') ?? null,
    requestId: req.requestId ?? null,
  };
}

// POST /students/:studentId/documents
// multipart/form-data:
//   file:     the binary
//   metadata: a JSON string conforming to UploadDocumentMetadata
export async function uploadHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const ctx = ctxFromReq(req);
    const studentId = req.params['studentId'];
    if (!studentId) throw BadRequest('Missing studentId');

    // Multer (memoryStorage) populates req.file with { buffer, mimetype, originalname, size }.
    const file = (req as Request & {
      file?: { buffer: Buffer; mimetype: string; originalname: string; size: number };
    }).file;
    if (!file) throw BadRequest('Missing file part');

    const rawMeta = (req.body && typeof req.body === 'object') ? req.body['metadata'] : undefined;
    if (typeof rawMeta !== 'string' || rawMeta.length === 0) {
      throw BadRequest('Missing metadata field');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(rawMeta); }
    catch { throw BadRequest('metadata is not valid JSON'); }
    const meta = UploadDocumentMetadata.parse(parsed);

    const created = await svc.createDocument(ctx, {
      studentId,
      documentTypeId: meta.document_type_id,
      fileName: file.originalname,
      mimeHint: file.mimetype,
      buffer: file.buffer,
      ...(meta.issued_on !== undefined ? { issuedOn: meta.issued_on } : {}),
      ...(meta.expires_on !== undefined ? { expiresOn: meta.expires_on } : {}),
    });
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
}

// GET /students/:studentId/documents
export async function listHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const ctx = ctxFromReq(req);
    const studentId = req.params['studentId'];
    if (!studentId) throw BadRequest('Missing studentId');
    const limit = req.query['limit'] ? Number(req.query['limit']) : undefined;
    const cursor = typeof req.query['cursor'] === 'string' ? req.query['cursor'] : undefined;
    const result = await svc.listForStudent(
      ctx,
      studentId,
      {
        ...(limit !== undefined ? { limit } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      },
    );
    res.json({ items: result.items, next_cursor: result.nextCursor });
  } catch (err) {
    next(err);
  }
}

// GET /documents/:id/download — returns a signed URL JSON envelope.
export async function downloadUrlHandler(req: Request, res: Response, next: NextFunction) {
  try {
    // SVT-RLS-2026-05: prevent shared/proxy caches from retaining sensitive bytes.
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    const ctx = ctxFromReq(req);
    const id = req.params['id'];
    if (!id) throw BadRequest('Missing id');
    const result = await svc.signedDownload(ctx, id);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

// GET /documents/:id/stream?nonce=...
export async function streamHandler(req: Request, res: Response, next: NextFunction) {
  try {
    // SVT-RLS-2026-05: prevent shared/proxy caches from retaining sensitive bytes.
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    const ctx = ctxFromReq(req);
    const id = req.params['id'];
    if (!id) throw BadRequest('Missing id');
    const nonce = typeof req.query['nonce'] === 'string' ? req.query['nonce'] : '';
    if (!nonce) throw BadRequest('Missing nonce');
    const out = await svc.streamDownload(ctx, id, nonce);
    res
      .status(200)
      .setHeader('Content-Type', out.mime)
      .setHeader(
        'Content-Disposition',
        // Use RFC 5987 encoding so non-ASCII filenames travel correctly.
        `attachment; filename*=UTF-8''${encodeURIComponent(out.fileName)}`,
      )
      .setHeader('X-Content-Sha256', out.sha256)
      .setHeader('X-Content-Type-Options', 'nosniff')
      .send(out.buffer);
  } catch (err) {
    next(err);
  }
}

// PATCH /documents/:id/verification
export async function verifyHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const ctx = ctxFromReq(req);
    const id = req.params['id'];
    if (!id) throw BadRequest('Missing id');
    // Body already validated by validate(VerifyDocumentRequest) middleware in
    // documents.routes.ts — no inline parse needed.
    const body = req.body as z.infer<typeof VerifyDocumentRequest>;
    const updated = await svc.verify(ctx, id, body);
    res.json(updated);
  } catch (err) {
    next(err);
  }
}

// DELETE /documents/:id
export async function deleteHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const ctx = ctxFromReq(req);
    const id = req.params['id'];
    if (!id) throw BadRequest('Missing id');
    const updated = await svc.softDelete(ctx, id);
    res.status(200).json({ id: updated.id, deleted_at: updated.deleted_at });
  } catch (err) {
    next(err);
  }
}
