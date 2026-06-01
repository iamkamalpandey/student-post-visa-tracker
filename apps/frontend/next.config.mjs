import createNextIntlPlugin from 'next-intl/plugin';

// next-intl 4.x reads its server config from `./i18n/request.ts` by default.
// We use cookie-based locale (see ./i18n/request.ts) instead of the `[locale]`
// route segment to avoid restructuring all 22 pages.
const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

// rebuild ping 2026-05-15
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Standalone output is required by apps/frontend/Dockerfile, which copies
  // .next/standalone into the runtime image.
  output: 'standalone',
  transpilePackages: ['@spv/api-types', '@spv/zod-schemas', '@spv/utils'],
  experimental: {
    optimizePackageImports: ['@mui/material', '@mui/icons-material'],
  },
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
};

export default withNextIntl(nextConfig);
