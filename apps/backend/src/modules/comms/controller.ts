import type { Request, Response, NextFunction } from 'express';
import type { Prisma } from '@prisma/client';
import { runIdempotent } from '../../shared/idempotencyHandler.js';
import { Unauthorized } from '../../shared/errors.js';
import { prisma } from '../../config/db.js';
import { writeAudit } from '../../shared/audit.js';
import { messageTemplateService, messageService } from './service.js';

export const messageTemplateController = {
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      await runIdempotent(req, res, { scope: 'message-templates.create' }, () =>
        messageTemplateService.create(req, req.body),
      );
    } catch (e) { next(e); }
  },
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const rows = await messageTemplateService.list(req, req.query as never);
      res.json({ data: rows, page: { total: Array.isArray(rows) ? rows.length : 0 } });
    } catch (e) { next(e); }
  },
  async get(req: Request, res: Response, next: NextFunction) {
    try { res.json(await messageTemplateService.get(req, req.params['id']!)); } catch (e) { next(e); }
  },
  async update(req: Request, res: Response, next: NextFunction) {
    try { res.json(await messageTemplateService.update(req, req.params['id']!, req.body)); } catch (e) { next(e); }
  },
  async remove(req: Request, res: Response, next: NextFunction) {
    try { await messageTemplateService.remove(req, req.params['id']!); res.status(204).end(); } catch (e) { next(e); }
  },
};

export const messageController = {
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const rows = await messageService.list(req, req.params['studentId']!, req.query as never);
      res.json({ data: rows, page: { total: Array.isArray(rows) ? rows.length : 0 } });
    } catch (e) { next(e); }
  },
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      // Send is async (queued) → 202 Accepted on first run; replays from cache.
      await runIdempotent(
        req,
        res,
        { scope: 'messages.send', status: 202 },
        () => messageService.create(req, req.params['studentId']!, req.body),
      );
    } catch (e) { next(e); }
  },
  // SVT-WAVE16-TEMPLATE-2026-05 — send via MessageTemplate id.
  async createFromTemplate(req: Request, res: Response, next: NextFunction) {
    try {
      await runIdempotent(
        req,
        res,
        { scope: 'messages.send-from-template', status: 202 },
        () => messageService.createFromTemplate(req as never, req.params['studentId']!, req.body),
      );
    } catch (e) { next(e); }
  },
  // SVT-WAVE18-PREVIEW-2026-05 — dry-render. No DB write, no idempotency
  // (preview is GET-ish in spirit; POST chosen so JSON body of context vars
  // works without URL-length limits).
  async previewFromTemplate(req: Request, res: Response, next: NextFunction) {
    try {
      const result = await messageService.previewFromTemplate(req as never, req.params['studentId']!, req.body);
      res.json(result);
    } catch (e) { next(e); }
  },
};

// SVT-WAVE19-THREADS-2026-05 — per-tenant thread browser.
// GET /api/v1/comms/threads?channel=...&student_id=...&limit=...
// Returns threads with embedded last-message preview + unread count for the
// authenticated user. Powers the /inbox threads tab + student-detail messages
// section. Tenant-scoped + uses req.db so RLS applies.
export const commsThreadsController = {
  // GET /api/v1/comms/threads/:id — full thread + ordered messages. Auto
  // marks recipient_user_id=me + read_at IS NULL messages as read on open
  // (returns the previously-unread count so the bell badge can decrement).
  async get(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw Unauthorized();
      const tenantId = req.user.tid;
      const userId = req.user.sub;
      const id = req.params['id']!;
      const db = req.db ?? prisma;

      const thread = await db.commsThread.findFirst({
        where: { id, tenant_id: tenantId },
        select: {
          id: true, tenant_id: true, student_id: true, channel: true,
          subject: true, created_at: true,
          student: { select: { id: true, given_name: true, family_name: true, student_code: true, assigned_to_id: true } },
        },
      });
      if (!thread) {
        res.status(404).json({ type: 'about:blank', status: 404, title: 'Not Found' });
        return;
      }
      // SVT-SEC-2026-05 — ownership gate. Previously any tenant user could
      // read any thread + its messages by URL-bashing. ADMIN bypasses.
      if (req.user.role !== 'ADMIN' && thread.student) {
        if (thread.student.assigned_to_id !== userId) {
          res.status(403).json({
            type: 'about:blank',
            status: 403,
            title: 'Forbidden',
            detail: 'Not authorised for this thread',
          });
          return;
        }
      }

      const messages = await db.commsMessage.findMany({
        where: { tenant_id: tenantId, thread_id: id },
        orderBy: { created_at: 'asc' },
        select: {
          id: true, subject: true, body: true, direction: true, status: true,
          sent_at: true, delivered_at: true, read_at: true, created_at: true,
          recipient_user_id: true, provider_id: true, attempts: true, metadata: true,
        },
      });

      // Mark-read-on-open: only the messages addressed to ME stay flipped.
      const r = await db.commsMessage.updateMany({
        where: {
          tenant_id: tenantId, thread_id: id,
          recipient_user_id: userId, read_at: null,
        },
        data: { read_at: new Date() },
      });
      const newly_read = r.count;

      res.json({ data: { thread, messages, newly_read } });
    } catch (e) { next(e); }
  },

  async list(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw Unauthorized();
      const tenantId = req.user.tid;
      const userId = req.user.sub;
      const db = req.db ?? prisma;
      const channel = req.query['channel'] ? String(req.query['channel']) : null;
      const studentIdQ = req.query['student_id'] ? String(req.query['student_id']) : null;
      const q = req.query['q'] ? String(req.query['q']).trim() : null;
      const limit = Math.min(parseInt(String(req.query['limit'] ?? '50'), 10) || 50, 200);

      const where: Record<string, unknown> = { tenant_id: tenantId };
      if (channel) where['channel'] = channel;
      if (studentIdQ) where['student_id'] = studentIdQ;
      // SVT-AUDIT-SEC-2026-06 (backlog rank 4) — ownership scope. The single-
      // thread get() above gates on student.assigned_to_id; the LIST must too,
      // or any COUNSELLOR can enumerate every thread tenant-wide (subjects,
      // student names, and the last-message body) for students assigned to
      // other counsellors. Non-admins see only threads for their assigned
      // students, plus student-less tenant threads (which get() also leaves
      // ungated). An explicit ?student_id the caller doesn't own falls outside
      // this scope and yields nothing. Composed via AND so it coexists with the
      // q-search OR below (Prisma allows only one top-level OR).
      const and: Record<string, unknown>[] = [];
      if (req.user.role !== 'ADMIN') {
        and.push({ OR: [{ student: { is: { assigned_to_id: userId } } }, { student_id: null }] });
      }
      // SVT-WAVE29-THREAD-SEARCH-2026-05 — substring match against thread
      // subject OR student given/family/student_code. Case-insensitive. Bounded
      // by `take` so the cost stays O(limit). Matches against last-message
      // body happen client-side because Prisma can't OR-join the related table
      // without a separate query.
      if (q) {
        and.push({ OR: [
          { subject: { contains: q, mode: 'insensitive' } },
          { student: { is: { given_name: { contains: q, mode: 'insensitive' } } } },
          { student: { is: { family_name: { contains: q, mode: 'insensitive' } } } },
          { student: { is: { student_code: { contains: q, mode: 'insensitive' } } } },
        ] });
      }
      if (and.length) where['AND'] = and;

      const threads = await db.commsThread.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: limit,
        select: {
          id: true, tenant_id: true, student_id: true, channel: true,
          subject: true, created_at: true,
          student: { select: { id: true, given_name: true, family_name: true, student_code: true } },
        },
      });
      if (threads.length === 0) {
        res.json({ data: [], page: { total: 0 } });
        return;
      }

      const ids = threads.map((t) => t.id);
      // Per-thread last message via groupBy (cheap; status irrelevant).
      const lastByThread = await db.commsMessage.findMany({
        where: { tenant_id: tenantId, thread_id: { in: ids } },
        orderBy: { created_at: 'desc' },
        select: { id: true, thread_id: true, subject: true, body: true, created_at: true, status: true, direction: true },
      });
      const lastMap = new Map<string, typeof lastByThread[number]>();
      for (const m of lastByThread) {
        if (!lastMap.has(m.thread_id)) lastMap.set(m.thread_id, m);
      }
      // Unread for current user (recipient_user_id, read_at IS NULL).
      const unreadByThread = await db.commsMessage.groupBy({
        by: ['thread_id'],
        where: {
          tenant_id: tenantId, thread_id: { in: ids },
          recipient_user_id: userId, read_at: null,
        },
        _count: { _all: true },
      });
      const unreadMap = new Map<string, number>(
        unreadByThread.map((r) => [r.thread_id, r._count._all]),
      );

      const data = threads.map((t) => ({
        ...t,
        last_message: lastMap.get(t.id) ?? null,
        unread_count: unreadMap.get(t.id) ?? 0,
      }));
      res.json({ data, page: { total: data.length } });
    } catch (e) { next(e); }
  },
};

// SVT-WAVE7-INBOX-2026-05 — per-user inbox surface for IN_APP messages routed
// to the authenticated user (transition notifications from super-agent FSM,
// commission claim FSM, enrollment FSM, etc.). Distinct from /students/:id/
// messages which is a per-student thread view; the bell UI uses /inbox.
export const inboxController = {
  // GET /api/v1/inbox/messages?unread=true&limit=20
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw Unauthorized();
      const tenantId = req.user.tid;
      const userId = req.user.sub;
      const unreadOnly = String(req.query['unread'] ?? '').toLowerCase() === 'true';
      const limit = Math.min(parseInt(String(req.query['limit'] ?? '20'), 10) || 20, 100);
      const rows = await (req.db ?? prisma).commsMessage.findMany({
        where: {
          tenant_id: tenantId,
          recipient_user_id: userId,
          direction: 'OUTBOUND',
          ...(unreadOnly ? { read_at: null } : {}),
        },
        orderBy: { sent_at: 'desc' },
        take: limit,
        select: {
          id: true, body: true, sent_at: true, read_at: true, metadata: true, status: true,
        },
      });
      // Unread count is the bell badge — single round-trip.
      const unreadCount = await (req.db ?? prisma).commsMessage.count({
        where: {
          tenant_id: tenantId,
          recipient_user_id: userId,
          direction: 'OUTBOUND',
          read_at: null,
        },
      });
      res.json({ data: rows, page: { total: rows.length }, unread_count: unreadCount });
    } catch (e) { next(e); }
  },

  // POST /api/v1/inbox/messages/:id/read — idempotent. Returns 204.
  async markRead(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw Unauthorized();
      const tenantId = req.user.tid;
      const userId = req.user.sub;
      const id = req.params['id']!;
      // Tenant + recipient match in WHERE so users can only mark their own rows.
      const r = await (req.db ?? prisma).commsMessage.updateMany({
        where: { id, tenant_id: tenantId, recipient_user_id: userId, read_at: null },
        data: { read_at: new Date() },
      });
      if (r.count === 1) {
        await writeAudit({
          tenantId, actorId: userId,
          action: 'comms.message.read',
          entityType: 'comms_message', entityId: id,
        });
      }
      res.status(204).end();
    } catch (e) { next(e); }
  },

  // POST /api/v1/inbox/messages/read-all — bulk mark-read.
  async markAllRead(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw Unauthorized();
      const tenantId = req.user.tid;
      const userId = req.user.sub;
      const r = await (req.db ?? prisma).commsMessage.updateMany({
        where: { tenant_id: tenantId, recipient_user_id: userId, read_at: null },
        data: { read_at: new Date() },
      });
      if (r.count > 0) {
        await writeAudit({
          tenantId, actorId: userId,
          action: 'comms.message.read_bulk',
          entityType: 'comms_message',
          after: { count: r.count },
        });
      }
      res.json({ updated: r.count });
    } catch (e) { next(e); }
  },
};

// SVT-WAVE9-OUTBOX-HEALTH-2026-05 — admin tooling for the comms outbox.
// Surfaces QUEUED / FAILED / terminal counts so the dashboard widget can
// alert when delivery health degrades. Admin-only at the route layer.
export const outboxAdminController = {
  // GET /api/v1/admin/comms/outbox/messages?status=QUEUED|FAILED|SENT|TERMINAL&limit=50&cursor=<id>
  //
  // TERMINAL is a virtual status: FAILED with (attempts>=3 OR next_retry_at IS NULL).
  // Defaults to QUEUED when no status passed. Limit clamped to 200.
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw Unauthorized();
      const tenantId = req.user.tid;
      const db = req.db ?? prisma;
      const statusQ = String(req.query['status'] ?? 'QUEUED').toUpperCase();
      const limit = Math.min(parseInt(String(req.query['limit'] ?? '50'), 10) || 50, 200);
      const cursor = req.query['cursor'] ? String(req.query['cursor']) : null;

      // Translate the virtual TERMINAL bucket into the actual where clause.
      let where: Record<string, unknown> = { tenant_id: tenantId };
      if (statusQ === 'TERMINAL') {
        where = {
          tenant_id: tenantId,
          status: 'FAILED',
          OR: [{ attempts: { gte: 3 } }, { next_retry_at: null }],
        };
      } else if (statusQ === 'FAILED') {
        // Non-terminal FAILED — still retryable.
        where = {
          tenant_id: tenantId,
          status: 'FAILED',
          attempts: { lt: 3 },
          next_retry_at: { not: null },
        };
      } else if (['QUEUED', 'SENT', 'DELIVERED', 'READ'].includes(statusQ)) {
        where = { tenant_id: tenantId, status: statusQ };
      }

      const rows = await db.commsMessage.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true, subject: true, body: true, status: true, attempts: true,
          sent_at: true, created_at: true, last_attempt_at: true, next_retry_at: true,
          recipient_user_id: true, provider_id: true, metadata: true,
        },
      });
      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;
      res.json({
        data,
        page: { has_more: hasMore, next_cursor: hasMore ? data[data.length - 1]!.id : null },
      });
    } catch (e) { next(e); }
  },

  // GET /api/v1/admin/comms/outbox/trend?days=7 — daily SENT/FAILED counts
  // for the dashboard chart. Bounded to last 30 days.
  async trend(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw Unauthorized();
      const tenantId = req.user.tid;
      const days = Math.min(parseInt(String(req.query['days'] ?? '7'), 10) || 7, 30);
      const since = new Date(Date.now() - days * 24 * 60 * 60_000);
      since.setUTCHours(0, 0, 0, 0);
      // Aggregate per UTC day per status. Use $queryRaw on req.db (tenant-
      // scoped) so the RLS policy `tenant_id = app_current_tenant()` returns
      // the right rows. tenant_id WHERE clause kept as defence-in-depth.
      const db = req.db ?? prisma;
      const rows = await db.$queryRaw<Array<{ day: Date; status: string; count: bigint }>>`
        SELECT date_trunc('day', COALESCE(sent_at, last_attempt_at, created_at)) AS day,
               status,
               COUNT(*)::bigint AS count
          FROM comms_messages
         WHERE tenant_id = ${tenantId}::uuid
           AND COALESCE(sent_at, last_attempt_at, created_at) >= ${since}
        GROUP BY 1, 2
        ORDER BY 1 ASC
      `;
      const data = rows.map((r) => ({
        day: r.day.toISOString().slice(0, 10),
        status: r.status,
        count: Number(r.count),
      }));
      res.json({ data, page: { total: data.length } });
    } catch (e) { next(e); }
  },

  // SVT-WAVE15-METRICS-2026-05 — dispatcher run history. Surfaces the last N
  // JobRun rows for the comms.dispatcher job so ops can spot stuck runs or a
  // growing rows_failed series. Limit clamped to 100.
  async metrics(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw Unauthorized();
      const limit = Math.min(parseInt(String(req.query['limit'] ?? '20'), 10) || 20, 100);
      const rows = await prisma.jobRun.findMany({
        where: { job_name: { in: ['comms.dispatcher', 'comms.cleanup', 'comms.digest', 'reminder.dispatcher', 'reminder.scanner'] } },
        orderBy: { started_at: 'desc' },
        take: limit,
        select: {
          id: true, job_name: true, started_at: true, finished_at: true,
          status: true, rows_processed: true, rows_failed: true,
          error_message: true, metadata: true,
        },
      });
      res.json({ data: rows, page: { total: rows.length } });
    } catch (e) { next(e); }
  },

  // GET /api/v1/admin/comms/outbox/health
  async health(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw Unauthorized();
      const tenantId = req.user.tid;
      const db = req.db ?? prisma;
      const now = new Date();
      // Concurrent counts: queued, retry-pending FAILED, terminal FAILED.
      const [queued, retrying, terminal, sent24h] = await Promise.all([
        db.commsMessage.count({
          where: { tenant_id: tenantId, status: 'QUEUED' },
        }),
        db.commsMessage.count({
          where: {
            tenant_id: tenantId, status: 'FAILED',
            attempts: { lt: 3 }, next_retry_at: { lte: now },
          },
        }),
        db.commsMessage.count({
          where: {
            tenant_id: tenantId, status: 'FAILED',
            OR: [{ attempts: { gte: 3 } }, { next_retry_at: null }],
          },
        }),
        db.commsMessage.count({
          where: {
            tenant_id: tenantId, status: 'SENT',
            sent_at: { gte: new Date(now.getTime() - 24 * 60 * 60_000) },
          },
        }),
      ]);
      res.json({
        data: { queued, retrying, terminal_failed: terminal, sent_last_24h: sent24h },
      });
    } catch (e) { next(e); }
  },

  // POST /api/v1/admin/comms/outbox/:id/requeue — flips a terminal FAILED row
  // back to QUEUED so the next dispatcher pass tries again. Resets attempts +
  // clears next_retry_at + last_error.
  async requeue(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw Unauthorized();
      const tenantId = req.user.tid;
      const id = req.params['id']!;
      const db = req.db ?? prisma;
      // Read the existing metadata so we preserve everything except last_error.
      const existing = await db.commsMessage.findFirst({
        where: { id, tenant_id: tenantId },
        select: { metadata: true },
      });
      const meta = existing?.metadata as Record<string, unknown> | null;
      const cleaned = meta ? { ...meta } : {};
      delete (cleaned as Record<string, unknown>)['last_error'];
      const r = await db.commsMessage.updateMany({
        where: { id, tenant_id: tenantId, status: 'FAILED' },
        data: {
          status: 'QUEUED',
          attempts: 0,
          next_retry_at: null,
          metadata: cleaned as Prisma.InputJsonValue,
        },
      });
      if (r.count === 0) {
        res.status(404).json({ type: 'about:blank', status: 404, title: 'Not Found' });
        return;
      }
      await writeAudit({
        tenantId, actorId: req.user.sub,
        action: 'comms.outbox.requeued',
        entityType: 'comms_message',
        entityId: id,
      });
      res.status(202).json({ requeued: id });
    } catch (e) { next(e); }
  },

  // POST /api/v1/admin/comms/outbox/requeue-all?scope=terminal|retrying|failed
  //
  // Bulk-requeue surface for ops. Scope:
  //   * terminal  — FAILED with attempts>=MAX or next_retry_at IS NULL (default)
  //   * retrying  — FAILED with attempts<MAX (currently waiting on backoff)
  //   * failed    — every FAILED row regardless of state
  // Returns the count flipped to QUEUED. Single audit row covers the bulk op.
  async requeueAll(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw Unauthorized();
      const tenantId = req.user.tid;
      const db = req.db ?? prisma;
      const scope = String(req.query['scope'] ?? 'terminal').toLowerCase();

      let where: Record<string, unknown> = { tenant_id: tenantId, status: 'FAILED' };
      if (scope === 'terminal') {
        where = {
          tenant_id: tenantId,
          status: 'FAILED',
          OR: [{ attempts: { gte: 3 } }, { next_retry_at: null }],
        };
      } else if (scope === 'retrying') {
        where = {
          tenant_id: tenantId,
          status: 'FAILED',
          attempts: { lt: 3 },
          next_retry_at: { not: null },
        };
      } else if (scope !== 'failed') {
        res.status(400).json({
          type: 'about:blank', status: 400, title: 'Bad Request',
          detail: 'scope must be one of: terminal | retrying | failed',
        });
        return;
      }

      const r = await db.commsMessage.updateMany({
        where,
        data: { status: 'QUEUED', attempts: 0, next_retry_at: null },
      });

      if (r.count > 0) {
        await writeAudit({
          tenantId, actorId: req.user.sub,
          action: 'comms.outbox.requeued_bulk',
          entityType: 'comms_message',
          after: { scope, count: r.count },
        });
      }
      res.json({ requeued: r.count, scope });
    } catch (e) { next(e); }
  },
};
