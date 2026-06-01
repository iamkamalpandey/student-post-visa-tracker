import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const versionRouter: Router = Router();

let cached: { name: string; version: string; commit: string | null; node: string } | null = null;

function loadVersion() {
  if (cached) return cached;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.resolve(here, '../../../package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string; version?: string };
  cached = {
    name: pkg.name ?? 'spv-backend',
    version: pkg.version ?? '0.0.0',
    commit: process.env['GIT_COMMIT'] ?? null,
    node: process.version,
  };
  return cached;
}

versionRouter.get('/', (_req, res) => {
  res.json(loadVersion());
});
