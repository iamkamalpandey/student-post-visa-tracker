/**
 * Node-flavoured flat config (backend + the shared packages).
 *
 * SVT-CI-2026-08 — the eslintrc version spread `env: { node: true }` over the
 * base object. Flat config has no `env`; ambient globals come from
 * `languageOptions.globals` instead. Rather than take a dependency on the
 * `globals` package just to name them, we declare the handful the codebase
 * actually uses. Anything missing shows up as `no-undef`, which is a visible
 * failure rather than a silent behaviour change.
 */

const base = require('./index.js');

const nodeGlobals = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  fetch: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  queueMicrotask: 'readonly',
  structuredClone: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  module: 'writable',
  require: 'readonly',
  exports: 'writable',
  global: 'readonly',
};

module.exports = base.map((entry) =>
  entry.languageOptions
    ? {
        ...entry,
        languageOptions: {
          ...entry.languageOptions,
          globals: { ...nodeGlobals, ...(entry.languageOptions.globals ?? {}) },
        },
      }
    : entry,
);
