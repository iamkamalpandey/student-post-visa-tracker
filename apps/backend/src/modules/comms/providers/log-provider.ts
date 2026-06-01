// Default no-op provider for local dev / tests. Writes the outbound payload
// to the pino logger and returns SENT with a synthetic provider_id. We use a
// single class instance per channel so the registry can hand them out cheaply.
//
// The provider deliberately does NOT throw on malformed input — it inspects
// `to` / `body` and returns `{ status: 'FAILED', error }` for the obvious bad
// shapes. That way the comms_message row reflects the failure rather than the
// HTTP create endpoint blowing up.

import { randomUUID } from 'node:crypto';
import { logger } from '../../../config/logger.js';
import type {
  CommsChannel,
  CommsProvider,
  CommsSendInput,
  CommsSendResult,
} from './index.js';

export class LogProvider implements CommsProvider {
  public readonly channel: CommsChannel;

  constructor(channel: CommsChannel) {
    this.channel = channel;
  }

  async send(msg: CommsSendInput): Promise<CommsSendResult> {
    const providerId = `log-${randomUUID()}`;

    // Validate the bare minimum so we never silently "send" garbage.
    if (!msg || typeof msg !== 'object') {
      return { providerId, status: 'FAILED', error: 'payload must be an object' };
    }
    if (typeof msg.to !== 'string' || msg.to.trim() === '') {
      return { providerId, status: 'FAILED', error: '"to" is required' };
    }
    if (typeof msg.body !== 'string' || msg.body.trim() === '') {
      return { providerId, status: 'FAILED', error: '"body" is required' };
    }

    logger.info(
      {
        provider: 'log',
        channel: this.channel,
        providerId,
        to: msg.to,
        subject: msg.subject,
        bodyPreview: msg.body.slice(0, 200),
        metadata: msg.metadata,
      },
      'comms.send (stub)',
    );

    return { providerId, status: 'SENT' };
  }
}
