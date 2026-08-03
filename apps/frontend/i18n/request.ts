import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

const SUPPORTED = ['en', 'ar', 'hi', 'ne'] as const;
type Locale = (typeof SUPPORTED)[number];

function isLocale(value: string | undefined): value is Locale {
  return !!value && (SUPPORTED as readonly string[]).includes(value);
}

// Cookie-based locale detection. We deliberately avoid the `[locale]` route
// segment because the SVT frontend has 22 pages and restructuring all of them
// is too invasive for v1. The cookie is set by the server action in
// `app/actions/set-locale.ts` from the LocaleSwitcher.
export default getRequestConfig(async () => {
  // Next 15: cookies() returns a Promise — must be awaited.
  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get('spv-locale')?.value;
  const locale: Locale = isLocale(cookieLocale) ? cookieLocale : 'en';

  let messages: Record<string, unknown>;
  switch (locale) {
    case 'ar':
      messages = (await import('../messages/ar.json')).default;
      break;
    case 'hi':
      messages = (await import('../messages/hi.json')).default;
      break;
    case 'ne':
      messages = (await import('../messages/ne.json')).default;
      break;
    case 'en':
    default:
      messages = (await import('../messages/en.json')).default;
      break;
  }

  return { locale, messages };
});
