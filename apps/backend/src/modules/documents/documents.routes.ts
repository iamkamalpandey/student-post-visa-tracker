// Documents module — Express routers.
// ----------------------------------------------------------------------------
// Two routers are exported:
//   - studentDocumentsRouter : mounted under /api/v1/students/:studentId/documents
//   - documentsRouter        : mounted under /api/v1/documents (id-keyed actions)
//
// Multer is configured with memoryStorage and a 10 MiB cap (mirrors
// MAX_UPLOAD_BYTES in mime.ts). The fileFilter performs an *early* allow-list
// check against the header-supplied MIME type; the authoritative magic-byte
// check still happens inside the service.

import { Router } from 'express';
import multer, { type FileFilterCallback } from 'multer';
import {
  requireRole,
  requireStudentOwnership,
  requireStudentOwnershipViaChild,
} from '../../middlewares/auth.js';
import { uuidParam } from '../../middlewares/uuidParam.js';
import { ALLOWED_MIME, MAX_UPLOAD_BYTES } from './mime.js';
import {
  uploadHandler,
  listHandler,
  downloadUrlHandler,
  streamHandler,
  verifyHandler,
  deleteHandler,
} from './documents.controller.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb: FileFilterCallback) => {
    // Header is untrusted, but cheap; a wrong header here saves us reading
    // the body. The authoritative check lives in mime.detectMime().
    if (!ALLOWED_MIME.has(file.mimetype)) {
      return cb(new Error(`Unsupported MIME type: ${file.mimetype}`));
    }
    cb(null, true);
  },
});

// ---------------------------------------------------------------------------
// /api/v1/students/:studentId/documents
// ---------------------------------------------------------------------------
// authenticate + tenantContext are applied at the app-level mount.
export const studentDocumentsRouter: Router = Router({ mergeParams: true });

// SVT-AUDIT-SEC-2026-05 — ownership gate on per-student document list.
studentDocumentsRouter.get(
  '/',
  uuidParam('studentId'),
  requireStudentOwnership('studentId'),
  listHandler,
);
studentDocumentsRouter.post(
  '/',
  uuidParam('studentId'),
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: ownership-gated
  requireStudentOwnership('studentId'),
  upload.single('file'),
  uploadHandler,
);

// ---------------------------------------------------------------------------
// /api/v1/documents
// ---------------------------------------------------------------------------
export const documentsRouter: Router = Router();

// SVT-AUDIT-SEC-2026-05 — ownership gate on document download URL +
// stream. The nonce already binds the link to the requesting user, but
// without an ownership check a COUNSELLOR can request a download URL for
// any other counsellor's document (since nonce is generated server-side
// with that user's id). ADMIN bypasses.
documentsRouter.get(
  '/:id/download',
  uuidParam('id'),
  requireStudentOwnershipViaChild('document', 'id'),
  downloadUrlHandler,
);
documentsRouter.get(
  '/:id/stream',
  uuidParam('id'),
  requireStudentOwnershipViaChild('document', 'id'),
  streamHandler,
);
documentsRouter.patch(
  '/:id/verification',
  uuidParam('id'),
  requireRole('ADMIN', 'COUNSELLOR'),
  // SVT-RBAC-OWN-2026-05: ownership-gated (ADMIN still bypasses)
  requireStudentOwnershipViaChild('document', 'id'),
  verifyHandler,
);
documentsRouter.delete('/:id', uuidParam('id'), requireRole('ADMIN'), deleteHandler);
