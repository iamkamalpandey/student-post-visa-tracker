import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.spec.ts', 'tests/**/*.test.ts'],
    reporters: ['default'],
    // SVT-TEST-RELIABILITY-2026-06 — explicit timeouts so a genuinely hung test
    // (real-timer/retry/network specs exist) FAILS LOUD instead of dangling the
    // whole run with no footer (the observed Windows stuck-worker hang). The
    // longest legitimate specs are the job-retry backoff (~6s) and the
    // source-scanning taxonomy test (~5s), so 20s leaves margin without hiding a
    // real hang. teardownTimeout caps the post-suite wait on slow worker exit.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    teardownTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/server.ts',
        'src/config/logger.ts',
        'src/**/index.ts',
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        statements: 70,
        branches: 60,
      },
    },
  },
});
