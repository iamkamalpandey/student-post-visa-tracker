/**
 * Shared base ESLint config — FLAT CONFIG (ESLint 9).
 *
 * SVT-CI-2026-08 — migrated from the legacy eslintrc format.
 *
 * ESLint 9 looks for `eslint.config.*` and no longer reads `.eslintrc.*` unless
 * ESLINT_USE_FLAT_CONFIG=false. This package still exported an eslintrc object,
 * so `eslint src` failed repo-wide with "couldn't find an eslint.config file" —
 * which meant the Lint step of backend-ci could never pass, and nobody could
 * lint locally either. It was the last gate standing between CI and green.
 *
 * Exported as CommonJS on purpose: this package has no `"type": "module"`, and
 * consumers import it from an `eslint.config.mjs`, where Node's CJS interop
 * hands this array back as the default export.
 *
 * Rules are carried over verbatim from the eslintrc version so this migration
 * changes the tooling, not what the linter enforces. The one deliberate
 * omission is `eslint:recommended`: its flat-config equivalent lives in
 * `@eslint/js`, which is not a declared dependency here, and pnpm's strict
 * layout means requiring an undeclared package would resolve on some machines
 * and not others. Adding it is a follow-up, not a silent maybe.
 */

const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const prettier = require('eslint-config-prettier');

/** Paths no package should ever lint. In flat config, `ignores` is global. */
const ignores = ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/coverage/**'];

module.exports = [
  { ignores },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...(tsPlugin.configs.recommended?.rules ?? {}),
      ...prettier.rules,
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
    },
  },
];
