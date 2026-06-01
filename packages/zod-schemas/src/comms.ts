import { z } from 'zod';
import { CountryAlpha2, PaginationQuery, Uuid } from './common.js';

export const CommsChannelEnum = z.enum(['EMAIL', 'SMS', 'WHATSAPP', 'IN_APP']);
export type CommsChannel = z.infer<typeof CommsChannelEnum>;

export const MessageDirectionEnum = z.enum(['INBOUND', 'OUTBOUND']);
export const MessageStatusEnum = z.enum(['QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED']);

export const CreateMessageTemplateRequest = z
  .object({
    key: z.string().min(2).max(80).regex(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/),
    channel: CommsChannelEnum,
    subject: z.string().max(200).optional(),
    body_md: z.string().min(1).max(20000),
    destination_country: CountryAlpha2.optional(),
    stage_id: Uuid.optional(),
    is_active: z.boolean().default(true),
  })
  .strict();
export type CreateMessageTemplateRequest = z.infer<typeof CreateMessageTemplateRequest>;

export const UpdateMessageTemplateRequest = CreateMessageTemplateRequest.partial().strict();
export type UpdateMessageTemplateRequest = z.infer<typeof UpdateMessageTemplateRequest>;

export const MessageTemplateListQuery = PaginationQuery.extend({
  channel: CommsChannelEnum.optional(),
}).strict();
export type MessageTemplateListQuery = z.infer<typeof MessageTemplateListQuery>;

export const CreateMessageRequest = z
  .object({
    channel: CommsChannelEnum,
    subject: z.string().max(200).optional(),
    body: z.string().min(1).max(20000),
    template_id: Uuid.optional(),
    thread_id: Uuid.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type CreateMessageRequest = z.infer<typeof CreateMessageRequest>;

export const MessageListQuery = PaginationQuery.extend({
  channel: CommsChannelEnum.optional(),
}).strict();
export type MessageListQuery = z.infer<typeof MessageListQuery>;

// SVT-WAVE16-TEMPLATE-2026-05 — send-from-template request. The server
// resolves the template by id, builds the context from the student row
// (+ optional enrollment), and interpolates the subject/body via the
// templating helper. Extra `vars` overrides anything in the auto-context.
export const SendFromTemplateRequest = z
  .object({
    template_id: Uuid,
    enrollment_id: Uuid.optional(),
    vars: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type SendFromTemplateRequest = z.infer<typeof SendFromTemplateRequest>;
