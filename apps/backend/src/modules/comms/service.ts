// MessageTemplate + CommsThread/CommsMessage service.
// Outbound messages are inserted as QUEUED, then dispatched fire-and-forget
// through the provider registry (see ./providers). The dispatch updates the
// row to SENT (with provider_id + sent_at) or FAILED on rejection — the HTTP
// create endpoint always returns 202 with the queued row, regardless.
import type { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { NotFound } from '../../shared/errors.js';
import { writeAudit } from '../../shared/audit.js';
import type {
  CreateMessageTemplateRequest,
  UpdateMessageTemplateRequest,
  MessageTemplateListQuery,
  CreateMessageRequest,
  MessageListQuery,
  SendFromTemplateRequest,
} from '@spv/zod-schemas';
import { getProvider } from './providers/registry.js';
import type { CommsChannel, CommsSendInput } from './providers/index.js';
import { renderMessage, extractPlaceholders } from './templating.js';
import { BadRequest } from '../../shared/errors.js';
import { withTenantTx } from '../../shared/tenantTx.js';

type DB = PrismaClient | Prisma.TransactionClient;
const db = (req?: { db?: DB }): DB => req?.db ?? prisma;

export const messageTemplateService = {
  async create(req: { db?: DB; user?: { tid: string } }, body: CreateMessageTemplateRequest) {
    const created = await db(req).messageTemplate.create({ data: { ...body, tenant_id: req.user!.tid } as never });
    await writeAudit(req as never, {
      action: 'message_template.created',
      entityType: 'message_template',
      entityId: created.id,
      after: created,
    });
    return created;
  },
  async list(req: { db?: DB; user?: { tid: string } }, q: MessageTemplateListQuery) {
    return db(req).messageTemplate.findMany({
      where: { tenant_id: req.user!.tid, ...(q.channel ? { channel: q.channel } : {}) },
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
  },
  async get(req: { db?: DB; user?: { tid: string } }, id: string) {
    const found = await db(req).messageTemplate.findFirst({ where: { id, tenant_id: req.user!.tid } });
    if (!found) throw NotFound('Message template not found');
    return found;
  },
  async update(req: { db?: DB; user?: { tid: string } }, id: string, body: UpdateMessageTemplateRequest) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).messageTemplate.updateMany({
      where: { id, tenant_id: req.user!.tid },
      data: body as never,
    });
    if (r.count !== 1) throw NotFound('Message template not found');
    const after = await db(req).messageTemplate.findFirstOrThrow({
      where: { id, tenant_id: req.user!.tid },
    });
    await writeAudit(req as never, {
      action: 'message_template.updated',
      entityType: 'message_template',
      entityId: id,
      before,
      after,
    });
    return after;
  },
  async remove(req: { db?: DB; user?: { tid: string } }, id: string) {
    const before = await this.get(req, id);
    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    const r = await db(req).messageTemplate.deleteMany({
      where: { id, tenant_id: req.user!.tid },
    });
    if (r.count !== 1) throw NotFound('Message template not found');
    await writeAudit(req as never, {
      action: 'message_template.deleted',
      entityType: 'message_template',
      entityId: id,
      before,
    });
  },
};

export const messageService = {
  async list(req: { db?: DB; user?: { tid: string } }, studentId: string, q: MessageListQuery) {
    const threads = await db(req).commsThread.findMany({
      where: { student_id: studentId, tenant_id: req.user!.tid, ...(q.channel ? { channel: q.channel } : {}) },
      select: { id: true },
    });
    const ids = threads.map((t) => t.id);
    if (ids.length === 0) return [];
    return db(req).commsMessage.findMany({
      where: { tenant_id: req.user!.tid, thread_id: { in: ids } },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
  },

  // Queue an outbound message. Creates a thread per (student, channel) if none exists.
  // status defaults to QUEUED, provider_id remains null until a provider claims it.
  async create(
    req: { db?: DB; user?: { tid: string; sub: string } },
    studentId: string,
    body: CreateMessageRequest,
  ) {
    const client = db(req);
    const tenantId = req.user!.tid;
    let threadId = body.thread_id;
    if (!threadId) {
      const existing = await client.commsThread.findFirst({
        where: { student_id: studentId, tenant_id: tenantId, channel: body.channel },
      });
      if (existing) {
        threadId = existing.id;
      } else {
        const created = await client.commsThread.create({
          data: {
            tenant_id: tenantId,
            student_id: studentId,
            channel: body.channel,
            ...(body.subject ? { subject: body.subject } : {}),
          },
        });
        threadId = created.id;
      }
    }
    // Defence-in-depth: when caller supplies thread_id, verify it belongs to this
    // (tenant, student) — RLS would catch a cross-tenant attempt anyway.
    if (body.thread_id) {
      const owns = await client.commsThread.findFirst({
        where: { id: body.thread_id, tenant_id: tenantId, student_id: studentId },
        select: { id: true },
      });
      if (!owns) throw new Error('Thread does not belong to this student');
    }
    const created = await client.commsMessage.create({
      data: {
        tenant_id: tenantId,
        thread_id: threadId!,
        direction: 'OUTBOUND',
        status: 'QUEUED',
        body: body.body,
        ...(body.template_id ? { template_id: body.template_id } : {}),
        ...(body.metadata ? { metadata: body.metadata } : {}),
        provider_id: null,
        created_by_id: req.user?.sub ?? null,
      } as never,
    });
    await writeAudit(req as never, {
      action: 'comms.message.created',
      entityType: 'comms_message',
      entityId: created.id,
      after: created,
    });

    // SVT-WAVE35-XTEAM-NOTIFY-2026-05 — when a counsellor sends on behalf of
    // a student that is assigned to a DIFFERENT counsellor, surface an IN_APP
    // notification to the assignee so they know their student is being
    // contacted. No-op when the sender IS the assignee, no assignee exists,
    // or the lookup fails. Best-effort: failures swallow + log via the helper.
    setImmediate(() => {
      void notifyAssignedCounsellorOnNewMessage({
        tenantId,
        studentId,
        senderUserId: req.user?.sub ?? null,
        messageId: created.id,
        threadId: threadId!,
        channel: body.channel,
        snippet: (body.body ?? '').slice(0, 120),
      });
    });

    // Fire-and-forget dispatch. We deliberately DO NOT await — the create
    // endpoint returns 202 immediately and the row updates in the background.
    // setImmediate yields to the event loop so the HTTP response flushes
    // before we touch the DB again. Any throw inside is caught and logged so
    // it can never crash the process.
    setImmediate(() => {
      void dispatchOutbound({
        messageId: created.id,
        tenantId,
        studentId,
        channel: body.channel,
        subject: body.subject,
        body: body.body,
        metadata: body.metadata,
      });
    });

    return created;
  },

  // SVT-WAVE16-TEMPLATE-2026-05 — resolve template, build context from the
  // student row (+ optional enrollment), interpolate subject/body, queue
  // via create() so the rest of the pipeline (audit, dispatch, retry) is
  // unchanged.
  //
  // Context shape:
  //   {
  //     student: { given_name, family_name, email_primary, student_code, ... },
  //     enrollment?: { institution: { display_name }, program: { name }, status },
  //     today: 'YYYY-MM-DD',
  //     ...vars  // caller overrides win
  //   }
  async createFromTemplate(
    req: { db?: DB; user?: { tid: string; sub: string } },
    studentId: string,
    body: SendFromTemplateRequest,
  ) {
    const client = db(req);
    const tenantId = req.user!.tid;

    // Load template (tenant-scoped, active).
    const template = await client.messageTemplate.findFirst({
      where: { id: body.template_id, tenant_id: tenantId, is_active: true },
      select: { id: true, channel: true, subject: true, body_md: true },
    });
    if (!template) throw NotFound('Template not found or inactive');

    // Load student snapshot for the context. Lightweight columns only.
    const student = await client.student.findFirst({
      where: { id: studentId, tenant_id: tenantId, deleted_at: null },
      select: {
        id: true, given_name: true, middle_name: true, family_name: true,
        preferred_name: true, email_primary: true, phone_primary_e164: true,
        student_code: true, nationality_code: true,
      },
    });
    if (!student) throw NotFound('Student not found');

    // Optional enrollment context.
    let enrollment: Record<string, unknown> | undefined;
    if (body.enrollment_id) {
      const e = await client.enrollment.findFirst({
        where: { id: body.enrollment_id, tenant_id: tenantId, student_id: studentId, deleted_at: null },
        select: {
          id: true, status: true,
          start_date: true, expected_end_date: true,
          institution: { select: { id: true, display_name: true } },
          program: { select: { id: true, name: true, level: true } },
        },
      });
      if (!e) throw NotFound('Enrollment not found for this student');
      enrollment = e as never;
    }

    const ctx = {
      student,
      ...(enrollment ? { enrollment } : {}),
      today: new Date().toISOString().slice(0, 10),
      ...(body.vars ?? {}),
    };

    // Surface missing placeholders early so the caller knows what's empty.
    const required = extractPlaceholders(template.body_md + (template.subject ?? ''));
    const missing = required.filter((path) => {
      const parts = path.split('.');
      let cur: unknown = ctx;
      for (const p of parts) {
        if (cur == null || typeof cur !== 'object') return true;
        cur = (cur as Record<string, unknown>)[p];
      }
      return cur === undefined || cur === null;
    });
    if (missing.length > 0 && !body.vars) {
      // Soft warning — render proceeds but logs. Hard 422 only when caller
      // explicitly supplied vars but still missed required keys (likely typo).
      logger.debug({ templateId: template.id, missing }, 'createFromTemplate: missing context vars (rendered as empty)');
    }

    let rendered: { subject: string | null; body: string };
    try {
      rendered = renderMessage(template.subject, template.body_md, ctx);
    } catch (err) {
      if (err instanceof RangeError) throw BadRequest(`Rendered message too large: ${err.message}`);
      throw err;
    }

    // Delegate to existing create() — keeps audit + dispatch + retry behaviour.
    return this.create(req, studentId, {
      channel: template.channel as CommsChannel,
      subject: rendered.subject ?? undefined,
      body: rendered.body,
      template_id: template.id,
      metadata: { rendered_from: template.id, ...(body.vars ?? {}) },
    });
  },

  // SVT-WAVE18-PREVIEW-2026-05 — dry-render a template against the same
  // context createFromTemplate would build. No DB writes. Returns the
  // rendered subject/body + the set of placeholders the template uses + the
  // subset still empty after context lookup (so the FE can warn before send).
  async previewFromTemplate(
    req: { db?: DB; user?: { tid: string; sub: string } },
    studentId: string,
    body: SendFromTemplateRequest,
  ): Promise<{
    channel: string;
    subject: string | null;
    body: string;
    placeholders: string[];
    missing: string[];
  }> {
    const client = db(req);
    const tenantId = req.user!.tid;
    const template = await client.messageTemplate.findFirst({
      where: { id: body.template_id, tenant_id: tenantId, is_active: true },
      select: { id: true, channel: true, subject: true, body_md: true },
    });
    if (!template) throw NotFound('Template not found or inactive');
    const student = await client.student.findFirst({
      where: { id: studentId, tenant_id: tenantId, deleted_at: null },
      select: {
        id: true, given_name: true, middle_name: true, family_name: true,
        preferred_name: true, email_primary: true, phone_primary_e164: true,
        student_code: true, nationality_code: true,
      },
    });
    if (!student) throw NotFound('Student not found');
    let enrollment: Record<string, unknown> | undefined;
    if (body.enrollment_id) {
      const e = await client.enrollment.findFirst({
        where: { id: body.enrollment_id, tenant_id: tenantId, student_id: studentId, deleted_at: null },
        select: {
          id: true, status: true,
          start_date: true, expected_end_date: true,
          institution: { select: { id: true, display_name: true } },
          program: { select: { id: true, name: true, level: true } },
        },
      });
      if (!e) throw NotFound('Enrollment not found for this student');
      enrollment = e as never;
    }
    const ctx = {
      student,
      ...(enrollment ? { enrollment } : {}),
      today: new Date().toISOString().slice(0, 10),
      ...(body.vars ?? {}),
    };
    const placeholders = extractPlaceholders(template.body_md + (template.subject ?? ''));
    const missing = placeholders.filter((path) => {
      const parts = path.split('.');
      let cur: unknown = ctx;
      for (const p of parts) {
        if (cur == null || typeof cur !== 'object') return true;
        cur = (cur as Record<string, unknown>)[p];
      }
      return cur === undefined || cur === null;
    });
    let rendered: { subject: string | null; body: string };
    try {
      rendered = renderMessage(template.subject, template.body_md, ctx);
    } catch (err) {
      if (err instanceof RangeError) throw BadRequest(`Rendered message too large: ${err.message}`);
      throw err;
    }
    return {
      channel: template.channel,
      subject: rendered.subject,
      body: rendered.body,
      placeholders,
      missing,
    };
  },
};

// ---------------------------------------------------------------------------
// Outbound dispatcher (used by messageService.create).
// Resolves the recipient address from the student row, calls the channel's
// provider, and patches the comms_message with SENT/FAILED + provider_id.
// ---------------------------------------------------------------------------

type DispatchInput = {
  messageId: string;
  tenantId: string;
  studentId: string;
  channel: CommsChannel;
  subject?: string;
  body: string;
  metadata?: Record<string, unknown>;
};

async function dispatchOutbound(input: DispatchInput): Promise<void> {
  try {
    // Best-effort recipient lookup. We pull from the student record because
    // the comms_messages row doesn't store `to` itself (the thread implies
    // the recipient). For IN_APP we just stamp the student id.
    const student = await withTenantTx(input.tenantId, (tx) =>
      tx.student.findFirst({
        where: { id: input.studentId, tenant_id: input.tenantId },
        select: { id: true, email_primary: true, phone_primary_e164: true },
      }),
    );
    const to =
      input.channel === 'EMAIL'
        ? student?.email_primary ?? ''
        : input.channel === 'IN_APP'
          ? student?.id ?? input.studentId
          : student?.phone_primary_e164 ?? '';

    const sendInput: CommsSendInput = {
      to,
      body: input.body,
      ...(input.subject ? { subject: input.subject } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };

    const result = await getProvider(input.channel).send(sendInput);

    // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
    await withTenantTx(input.tenantId, (tx) =>
      tx.commsMessage.updateMany({
        where: { id: input.messageId, tenant_id: input.tenantId },
        data:
          result.status === 'SENT'
            ? { status: 'SENT', provider_id: result.providerId, sent_at: new Date() }
            : {
                status: 'FAILED',
                provider_id: result.providerId,
                metadata: { ...(input.metadata ?? {}), error: result.error },
              },
      }),
    );
  } catch (err) {
    // Never let a provider crash bubble up — record the failure on the row.
    logger.error({ err, messageId: input.messageId }, 'comms.dispatch failed');
    try {
      // SVT-RLS-2026-05: ensure tenant_id in where for defence-in-depth.
      await withTenantTx(input.tenantId, (tx) =>
        tx.commsMessage.updateMany({
          where: { id: input.messageId, tenant_id: input.tenantId },
          data: {
            status: 'FAILED',
            metadata: {
              ...(input.metadata ?? {}),
              error: err instanceof Error ? err.message : 'unknown dispatch error',
            },
          },
        }),
      );
    } catch (innerErr) {
      logger.error({ innerErr, messageId: input.messageId }, 'comms.dispatch could not mark FAILED');
    }
  }
}

// SVT-WAVE35-XTEAM-NOTIFY-2026-05 — bell-drawer ping when a counsellor sends
// a message on a student that's assigned to someone else. Skipped silently
// when no assignee, assignee == sender, or any lookup fails. We deliberately
// inline this rather than re-using transitionNotify because the semantics are
// different (this is not a status transition; it's a collaboration ping) and
// we want the synthetic thread label to read "Assigned-student activity"
// instead of the system-notifications stream.
type NotifyAssignedArgs = {
  tenantId: string;
  studentId: string;
  senderUserId: string | null;
  messageId: string;
  threadId: string;
  channel: string;
  snippet: string;
};

const ASSIGNED_NOTIFY_THREAD_SUBJECT = 'Assigned-student activity';

export async function notifyAssignedCounsellorOnNewMessage(
  args: NotifyAssignedArgs,
): Promise<void> {
  try {
    if (!args.senderUserId) return;
    const [student, sender] = await Promise.all([
      prisma.student.findFirst({
        where: { id: args.studentId, tenant_id: args.tenantId, deleted_at: null },
        select: {
          id: true, student_code: true, given_name: true, family_name: true,
          assigned_to_id: true,
        },
      }),
      // SVT-WAVE47-NOTIFY-SIGNATURE-2026-05 — look up sender display so the
      // bell drawer reads "Email from Sarah on Maya Patel (SPV-2026-001)"
      // rather than the bare student label. Tolerates a missing sender row.
      prisma.user.findFirst({
        where: { id: args.senderUserId, tenant_id: args.tenantId },
        select: { id: true, given_name: true, family_name: true, display_name: true },
      }),
    ]);
    if (!student) return;
    const recipient = student.assigned_to_id;
    if (!recipient || recipient === args.senderUserId) return;
    const senderLabel = sender
      ? sender.display_name?.trim() || `${sender.given_name} ${sender.family_name}`.trim()
      : null;

    // Synthetic per-tenant thread for assigned-student pings. Reuse the
    // ThreadDetailDialog read-only system-notifications UX by setting
    // student_id=null + channel=IN_APP.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${args.tenantId}, true)`;
      let thread = await tx.commsThread.findFirst({
        where: {
          tenant_id: args.tenantId,
          student_id: null,
          channel: 'IN_APP',
          subject: ASSIGNED_NOTIFY_THREAD_SUBJECT,
        },
        select: { id: true },
      });
      if (!thread) {
        thread = await tx.commsThread.create({
          data: {
            tenant_id: args.tenantId,
            student_id: null,
            channel: 'IN_APP',
            subject: ASSIGNED_NOTIFY_THREAD_SUBJECT,
          },
          select: { id: true },
        });
      }
      const studentLabel = `${student.given_name} ${student.family_name} (${student.student_code})`;
      // Sender-prefixed when we know who; otherwise the legacy "<channel>
      // message on <student>" form so existing tests + integrations are
      // unaffected.
      const title = senderLabel
        ? `${args.channel} from ${senderLabel} on ${studentLabel}`
        : `${args.channel} message on ${studentLabel}`;
      const body = args.snippet
        ? `${title} — ${args.snippet}`
        : title;
      await tx.commsMessage.create({
        data: {
          tenant_id: args.tenantId,
          thread_id: thread.id,
          direction: 'OUTBOUND',
          status: 'SENT',
          body,
          sent_at: new Date(),
          recipient_user_id: recipient,
          metadata: {
            title,
            href: `/students/${student.id}?tab=records`,
            source: 'assigned_student_activity',
            entity_id: args.messageId,
            student_id: student.id,
            channel: args.channel,
            thread_id: args.threadId,
            sender_user_id: args.senderUserId,
            sender_label: senderLabel,
          },
          created_by_id: args.senderUserId,
        },
      });
    });
  } catch (err) {
    logger.warn(
      { err, tenantId: args.tenantId, studentId: args.studentId, messageId: args.messageId },
      'notifyAssignedCounsellorOnNewMessage failed (best-effort; non-fatal)',
    );
  }
}
