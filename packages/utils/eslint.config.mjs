// SVT-CI-2026-08 — ESLint 9 flat config entry point.
// Replaces .eslintrc.cjs, which ESLint 9 no longer reads. The shared config is
// CommonJS; Node's interop hands the exported array back as the default.
import config from '@spv/eslint-config/node.js';

export default config;
