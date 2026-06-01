'use server';

import { cookies } from 'next/headers';

const SUPPORTED = new Set(['en', 'ar', 'ne']);

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
