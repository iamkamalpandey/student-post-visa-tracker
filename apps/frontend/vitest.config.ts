// SVT-QA-2026-08 — frontend unit-test harness.
//
// Until now `pnpm --filter frontend test` was literally `echo no tests yet`,
// so the entire client half of the product had zero automated coverage: pure
// money/date/format helpers, the auth-state machine, and the guards that decide
// what a COUNSELLOR is allowed to see were all verified by eye only.
//
// Deliberately NOT wired to the Playwright e2e suite (`pnpm e2e`) — that needs
// a live DB + backend + seed and already `probeStack`-skips when the stack is
// down. This config is for fast, hermetic unit/component tests that run in CI
// on every push with no infrastructure.

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Mirror the `@/*` path alias from tsconfig so tests import modules the
      // same way application code does.
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    // e2e/ is Playwright's; it must never be picked up by vitest.
    exclude: ['e2e/**', 'node_modules/**', '.next/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Only measure what these tests actually target. Pages/layouts are
      // covered by the Playwright suite; counting them here would produce a
      // meaningless denominator that pressures people into writing shallow
      // render-smoke tests to move a number.
      include: ['lib/**/*.ts', 'features/**/*.ts'],
      exclude: ['**/*.d.ts', 'lib/api.ts'],
    },
  },
});
