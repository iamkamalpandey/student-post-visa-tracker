'use client';

// SVT-SEC-P1-FE2-2026-05 — nonce-aware Emotion (MUI) cache provider.
//
// Why we wrap AppRouterCacheProvider:
//   The Next.js App Router helper accepts an `options.nonce` and forwards it to
//   `createCache` from @emotion/cache. createCache then stamps that nonce on
//   every <style> tag it injects at runtime (SSR + CSR), so the browser will
//   accept them under `style-src 'nonce-…'` even after `'unsafe-inline'` is
//   dropped from the CSP.
//
//   We isolate that wiring in a dedicated client component so RootLayout stays
//   declarative and so we have one place to revisit if MUI ever ships a path
//   that bypasses the cache (we'd add the nonce to the emergency `<style>` tag
//   here, not by widening the global CSP).
//
// The nonce is sourced from the `x-csp-nonce` header that middleware.ts stamps
// per request. RootLayout reads it via next/headers and passes it as a prop;
// keeping the read in a Server Component means this client boundary stays free
// of headers() and can hydrate cleanly.

import * as React from 'react';
import { AppRouterCacheProvider } from '@mui/material-nextjs/v14-appRouter';

type Props = {
  nonce: string | undefined;
  children: React.ReactNode;
};

export default function EmotionRegistry({ nonce, children }: Props) {
  // enableCssLayer: wrap MUI styles in `@layer mui` so app-level CSS overrides
  // win without specificity wars. Matches the previous RootLayout config.
  const options = React.useMemo(
    () => ({
      enableCssLayer: true,
      ...(nonce ? { nonce } : {}),
    }),
    [nonce],
  );

  return (
    <AppRouterCacheProvider options={options}>{children}</AppRouterCacheProvider>
  );
}
