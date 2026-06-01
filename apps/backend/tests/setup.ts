// Vitest global setup. Loads dotenv from .env.test (preferred) or .env as a fallback.
// Runs before any test module is imported, so env-dependent imports (e.g. config/env.ts)
// see the right values.
import '../src/shared/bigint-serializer.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';

const envTest = resolve(process.cwd(), '.env.test');
const envDefault = resolve(process.cwd(), '.env');

if (existsSync(envTest)) {
  dotenv.config({ path: envTest });
} else if (existsSync(envDefault)) {
  dotenv.config({ path: envDefault });
}
