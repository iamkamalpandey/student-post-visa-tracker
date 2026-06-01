import type { Metadata, Viewport } from 'next';
import { Inter } from 'next/font/google';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { headers } from 'next/headers';
import Providers from './providers';
import CookieBanner from '@/components/CookieBanner';
import EmotionRegistry from '@/components/EmotionRegistry';
import './globals.css';

// Roboto Flex is a variable font; Inter is a clean, well-supported fallback
// that ships through next/font for offline-friendly self-hosting.
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-sans',
  weight: ['300', '400', '500', '600', '700'],
});

const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || 'Student Post-Visa Tracker';

export const metadata: Metadata = {
  title: {
    default: APP_NAME,
    template: `%s · ${APP_NAME}`,
  },
  description:
    'Counsellor-grade workspace for tracking international students through every post-visa stage.',
  applicationName: APP_NAME,
  formatDetection: { telephone: false },
  icons: {
    icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 5,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FBFCFE' },
    { media: '(prefers-color-scheme: dark)', color: '#101316' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Resolved by ./i18n/request.ts from the `spv-locale` cookie (default: 'en').
  const locale = await getLocale();
  const messages = await getMessages();
  const dir = locale === 'ar' ? 'rtl' : 'ltr';

  // SVT-SEC-P1-FE2-2026-05 — read the per-request CSP nonce stamped by
  // middleware.ts (header: x-csp-nonce) and hand it to EmotionRegistry so
  // emotion's runtime <style> tags carry the nonce attribute. Browsers accept
  // them under `style-src 'nonce-…'`, which lets us drop `'unsafe-inline'`
  // from style-src entirely. headers() may throw in static rendering — fall
  // back to undefined (CSP simply won't allow inline styles in that case).
  let nonce: string | undefined;
  try {
    // Next 15: headers() returns a Promise — must be awaited.
    const h = await headers();
    nonce = h.get('x-csp-nonce') ?? undefined;
  } catch {
    nonce = undefined;
  }

  return (
    <html lang={locale} dir={dir} suppressHydrationWarning className={inter.variable}>
      <body suppressHydrationWarning>
        <a href="#main-content" className="skip-link">Skip to content</a>
        <EmotionRegistry nonce={nonce}>
          <NextIntlClientProvider locale={locale} messages={messages}>
            <Providers>
              {children}
              {/* SVT-WAVE-PRIV-C7-2026-05 — GDPR / UK PECR cookie banner. The
                  component reads localStorage on mount and hides itself when
                  the user has already chosen; SSR returns null so there's no
                  hydration flash on repeat visits. */}
              <CookieBanner />
            </Providers>
          </NextIntlClientProvider>
        </EmotionRegistry>
      </body>
    </html>
  );
}
