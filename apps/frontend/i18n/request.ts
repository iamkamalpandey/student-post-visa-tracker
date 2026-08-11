import { cookies } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

// SVT-I18N-2026-08 — `ar` and `hi` are gone. Both message files were verbatim
// English copies carrying a `_translation_status` admitting it, so the product
// advertised four languages and shipped one. Nepali is the only second locale
// this market needs; it stays here because the translation work is scoped, but
// note ne.json is ALSO still English placeholders today — which is why no
// language switcher is mounted in the app shell yet. A toggle that reloads the
// page and changes no text reads as broken software, and machine-translating
// fee, visa and contractual wording for Nepali agents is not an acceptable
// shortcut on a money-handling product. Mount LocaleSwitcher in AppShell the
// moment ne.json holds real translations, and not before.
const SUPPORTED = ['en', 'ne'] as const;
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
