#!/usr/bin/env tsx
// SVT-WAVE-KMS-PROVIDER-2026-05 — KEK re-wrap launcher (shim).
//
// The actual implementation lives at apps/backend/scripts/rewrap-secrets.ts —
// it must be a backend-resident file so pnpm can resolve @prisma/client and
// the encryption helpers under apps/backend/src/. This file exists at the
// path the runbook (infra/docs/runbooks/kms-rotation.md) references so
// operators have a predictable entry point.
//
// What this file does:
//   - re-exec the real script under the backend workspace via pnpm tsx.
//   - forward every flag verbatim.
//
// Run directly with: tsx infra/scripts/rewrap-secrets.ts --dry-run

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const target = resolve(repoRoot, 'apps', 'backend', 'scripts', 'rewrap-secrets.ts');

const args = ['--filter', 'backend', 'tsx', target, ...process.argv.slice(2)];
const r = spawnSync('pnpm', args, { stdio: 'inherit', cwd: repoRoot, shell: process.platform === 'win32' });
process.exit(r.status ?? 1);
