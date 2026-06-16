import createNextIntlPlugin from 'next-intl/plugin';

// next-intl 4.x reads its server config from `./i18n/request.ts` by default.
// We use cookie-based locale (see ./i18n/request.ts) instead of the `[locale]`
// route segment to avoid restructuring all 22 pages.
const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

// rebuild ping 2026-05-15
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Standalone output is required by apps/frontend/Dockerfile (copies
  // .next/standalone into the runtime image). Gated behind NEXT_OUTPUT so a
  // local `next build` works on Windows — standalone's symlink step throws
  // EPERM there. The Dockerfile sets NEXT_OUTPUT=standalone for the image build.
  output: process.env.NEXT_OUTPUT === 'standalone' ? 'standalone' : undefined,
  transpilePackages: ['@spv/api-types', '@spv/zod-schemas', '@spv/utils'],
  experimental: {
    optimizePackageImports: ['@mui/material', '@mui/icons-material'],
  },
  poweredByHeader: false,
  productionBrowserSourceMaps: false,
};

export default withNextIntl(nextConfig);
