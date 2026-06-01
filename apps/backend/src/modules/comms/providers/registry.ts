// Provider registry — single chokepoint the service uses to obtain a sender
// for a given channel. EMAIL switches between LogProvider (dev/test) and
// ResendProvider (prod) via env.EMAIL_PROVIDER. Other channels still resolve
// to LogProvider until adapters land.
//
// SVT-WAVE7-EMAIL-2026-05: ResendProvider shipped. SMS/WHATSAPP/IN_APP adapter
// work is queued for a later wave; the registry stays the only place to swap.

import { env } from '../../../config/env.js';
import { LogProvider } from './log-provider.js';
import { ResendProvider } from './resend-provider.js';
import type { CommsChannel, CommsProvider } from './index.js';

function buildEmailProvider(): CommsProvider {
  if (env.EMAIL_PROVIDER === 'resend') {
    // Validated by env.ts superRefine — RESEND_API_KEY must be present.
    return new ResendProvider(env.RESEND_API_KEY!, env.EMAIL_FROM);
  }
  return new LogProvider('EMAIL');
}

const providers: Record<CommsChannel, CommsProvider> = {
  EMAIL: buildEmailProvider(),
  SMS: new LogProvider('SMS'),
  WHATSAPP: new LogProvider('WHATSAPP'),
  IN_APP: new LogProvider('IN_APP'),
};

export function getProvider(channel: CommsChannel): CommsProvider {
  return providers[channel];
}
