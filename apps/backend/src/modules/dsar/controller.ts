import type { Request, Response, NextFunction } from 'express';
import { runIdempotent } from '../../shared/idempotencyHandler.js';
import { readIfMatch } from '../../shared/ifMatch.js';
import { writeAudit } from '../../shared/audit.js';
import { Forbidden, NotFound } from '../../shared/errors.js';
import { getStorage } from '../documents/storage.js';
import { dsarService as svc, signExportDownload, _consumeExportNonce } from './service.js';
import { withTenantTx } from '../../shared/tenantTx.js';

export const dsarController = {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      await runIdempotent(req, res, { scope: 'dsar.create' }, () =>
        svc.create(req, req.body),
      );
    } catch (e) { next(e); }
  },
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const rows = await svc.list(req, req.query as never);
      res.json({ data: rows, page: { total: Array.isArray(rows) ? rows.length : 0 } });
    } catch (e) { next(e); }
  },
  async get(req: Request, res: Response, next: NextFunction) {
    try { res.json(await svc.get(req, req.params['id']!)); } catch (e) { next(e); }
  },
  async update(req: Request, res: Response, next: NextFunction) {
    try {
      // SVT-IF-MATCH-2026-05 — DSARRequest has no `version` column; accept
      // If-Match header for API parity but treat it as a no-op (parser still
      // validates syntax → 412 on malformed values per RFC 7232 §3.1).
      const expected = readIfMatch(req);
      res.json(await svc.update(req, req.params['id']!, req.body, { expected }));
    } catch (e) { next(e); }
  },
  // SVT-WAVE37-DSAR-DASH-2026-05
  async dashboardSummary(req: Request, res: Response, next: NextFunction) {
    try {
      const data = await svc.dashboardSummary(req);
      res.json({ data });
    } catch (e) { next(e); }
  },

  // SVT-WAVE-PRIV-C1-2026-05 — mint a fresh signed download URL for the
  // ACCESS/PORTABILITY export bundle. The DSAR must be COMPLETED and
  // already have a stamped `export_storage_key`. Returns the URL + TTL so
  // the FE can render it as a clickable button. Audited.
  async exportLink(req: Request, res: Response, next: NextFunction) {
    try {
      const id = req.params['id']!;
      const tenantId = req.user!.tid;
      // SVT-SEC-2026-08 (T0-7) — dsar_requests is RLS-scoped; the singleton has
      // no tenant GUC, so this returned null under the production role and every
      // completed DSAR export answered 404.
      const row = req.db
        ? await req.db.dSARRequest.findFirst({
            where: { id, tenant_id: tenantId },
            select: { id: true, status: true, type: true, export_storage_key: true },
          })
        : await withTenantTx(tenantId, (tx) => tx.dSARRequest.findFirst({
            where: { id, tenant_id: tenantId },
            select: { id: true, status: true, type: true, export_storage_key: true },
          }));
      if (!row) throw NotFound('DSAR request not found');
      if (row.status !== 'COMPLETED') throw Forbidden('Export only available once DSAR is COMPLETED');
      if (!(row.type === 'ACCESS' || row.type === 'PORTABILITY')) {
        throw Forbidden('Export only available for ACCESS / PORTABILITY requests');
      }
      if (!row.export_storage_key) throw NotFound('Export bundle not generated yet');
      const link = signExportDownload(id, tenantId, row.export_storage_key);
      await writeAudit(req, {
        action: 'dsar.export.link_issued',
        entityType: 'dsar_request',
        entityId: id,
        after: { expires_at: link.expiresAt.toISOString() },
      });
      res.json({ data: link });
    } catch (e) { next(e); }
  },

  // SVT-WAVE-PRIV-C1-2026-05 — stream the export bundle. Single-use nonce
  // (TTL 24h) validates the request. We require the caller is still an
  // authenticated tenant member so a leaked nonce alone can't drain the
  // bundle to an outsider.
  async exportDownload(req: Request, res: Response, next: NextFunction) {
    try {
      const id = req.params['id']!;
      const token = (req.query['token'] as string | undefined) ?? '';
      if (!token) throw Forbidden('Missing download token');
      const entry = _consumeExportNonce(token);
      if (!entry || entry.dsarId !== id || entry.tenantId !== req.user!.tid) {
        throw Forbidden('Invalid or expired download token');
      }
      const buffer = await getStorage().get(entry.storageKey);
      await writeAudit(req, {
        action: 'dsar.export.downloaded',
        entityType: 'dsar_request',
        entityId: id,
        after: { storage_key: entry.storageKey, size_bytes: buffer.length },
      });
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="dsar-export-${id}.json"`);
      res.send(buffer);
    } catch (e) { next(e); }
  },
};
