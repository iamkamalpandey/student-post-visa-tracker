-- ============================================================================
-- Wave 51 — per-tenant default message-template channel.
--
-- Used by the FE CreateMessageTemplateDialog so the channel select pre-seeds
-- to the tenant's preferred outbound channel (EMAIL for most consultancies,
-- WHATSAPP for some). Defaults to EMAIL to preserve current behaviour. Type
-- is text + service-layer enum validation so we don't need a Postgres enum
-- coupled to the Prisma client.
-- ============================================================================

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS default_message_channel text NOT NULL DEFAULT 'EMAIL';
