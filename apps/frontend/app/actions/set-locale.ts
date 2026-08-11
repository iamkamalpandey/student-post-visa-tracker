'use server';

import { cookies } from 'next/headers';

// SVT-I18N-2026-08 — must stay in step with i18n/request.ts. `ar`/`hi` were
// English copies and have been removed; anything not listed falls back to 'en'.
const SUPPORTED = new Set(['en', 'ne']);

export async function setLocale(locale: string) {
  const value = SUPPORTED.has(locale) ? locale : 'en';
  // Next 15: cookies() returns a Promise — must be awaited.
  const jar = await cookies();
  jar.set('spv-locale', value, {
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
    sameSite: 'lax',
  });
}
