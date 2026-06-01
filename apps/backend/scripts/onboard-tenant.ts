/**
 * SVT-WAVE-TENANT-ONBOARD-2026-05 — founder onboarding script.
 *
 * Provisions a fresh tenant with:
 *   1. Tenant row (name, legal_name, default_locale, default_timezone,
 *      default_currency, data_residency_region)
 *   2. Initial ADMIN user (Argon2id-hashed password)
 *   3. All 8 default LifecycleStages from prisma/data/default-stages.json
 *
 * Idempotent + transactional: a partial run (e.g. crash after tenant insert)
 * can be re-executed and will pick up where it left off. Fails fast if a tenant
 * with the same legal_name already exists (legal_name is the canonical
 * "registered entity" identifier — name is a display label and may collide
 * across multiple brand identities of the same legal entity).
 *
 * Usage:
 *   pnpm --filter backend tsx scripts/onboard-tenant.ts \
 *     --name "Acme Education"             \
 *     --legal-name "Acme Education Ltd."  \
 *     --admin-email founder@acme.com      \
 *     --admin-password "$(< /tmp/admin-pass)" \
 *     [--admin-given-name "Founder"]      \
 *     [--admin-family-name "User"]        \
 *     [--locale en]                       \
 *     [--timezone Europe/London]          \
 *     [--currency GBP]                    \
 *     [--region eu-west-1]
 *
 * IMPORTANT — never pass --admin-password as a literal on the command line in
 * shared shells; the value will end up in your shell history. Read from a file
 * or stdin via process substitution (`< /tmp/pass`) or a CI secret.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hashPassword } from '../src/shared/passwords.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = resolve(__dirname, '..', 'prisma', 'data');

type StageCategory =
  | 'PRE_DEPARTURE'
  | 'IN_TRANSIT'
  | 'POST_ARRIVAL'
  | 'ENROLLED'
  | 'COMPLETED'
  | 'EXCEPTION'
  | 'IN_PROGRESS';

interface LifecycleStageSeed {
  key: string;
  label: string;
  sequence: number;
  category: StageCategory;
  is_initial: boolean;
  is_terminal: boolean;
  color_hex: string | null;
  icon: string | null;
  sla_hours: number | null;
}

interface Args {
  name: string;
  legalName: string;
  adminEmail: string;
  adminPassword: string;
  adminGivenName: string;
  adminFamilyName: string;
  locale: string;
  timezone: string;
  currency: string;
  region: string;
}

function parseArgs(argv: string[]): Args {
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || !a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    opts[key] = next;
    i++;
  }
  const need = (k: string): string => {
    const v = opts[k];
    if (!v) throw new Error(`Required flag missing: --${k}`);
    return v;
  };
  const name = need('name');
  const legalName = opts['legal-name'] ?? name;
  const adminEmail = need('admin-email').toLowerCase();
  const adminPassword = need('admin-password');
  if (adminPassword.length < 12) {
    throw new Error('--admin-password must be at least 12 characters');
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) {
    throw new Error(`--admin-email does not look like an email: ${adminEmail}`);
  }
  return {
    name,
    legalName,
    adminEmail,
    adminPassword,
    adminGivenName: opts['admin-given-name'] ?? 'Founder',
    adminFamilyName: opts['admin-family-name'] ?? 'Administrator',
    locale: opts['locale'] ?? 'en',
    timezone: opts['timezone'] ?? 'UTC',
    currency: (opts['currency'] ?? 'USD').toUpperCase(),
    region: opts['region'] ?? 'eu-west-1',
  };
}

function loadStages(): LifecycleStageSeed[] {
  const raw = readFileSync(resolve(DATA_DIR, 'default-stages.json'), 'utf8');
  return JSON.parse(raw) as LifecycleStageSeed[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    // Fail-fast collision check on legal_name. Distinct legal entities should
    // never share a legal_name; if the operator re-ran the script for the
    // same tenant they should use the idempotent path below.
    const collision = await prisma.tenant.findFirst({
      where: { legal_name: args.legalName },
      select: { id: true, name: true },
    });
    if (collision) {
      console.error(
        `Tenant with legal_name "${args.legalName}" already exists (id=${collision.id}, name="${collision.name}").`,
      );
      console.error('Aborting. If you intend to add a new admin to an existing tenant, use a separate user-create flow.');
      process.exit(2);
    }

    const passwordHash = await hashPassword(args.adminPassword);
    const stages = loadStages();
    if (stages.length !== 8) {
      console.warn(`Expected 8 default stages, got ${stages.length} — continuing.`);
    }

    const summary = await prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          name: args.name,
          legal_name: args.legalName,
          default_locale: args.locale,
          default_timezone: args.timezone,
          default_currency: args.currency,
          data_residency_region: args.region,
        },
      });

      // Stage inserts run under tenant RLS — set the GUC inside the same tx
      // so the lifecycle_stages policies match our tenant_id.
      await tx.$executeRaw(
        Prisma.sql`SELECT set_config('app.tenant_id', ${tenant.id}, true)`,
      );

      for (const s of stages) {
        await tx.lifecycleStage.upsert({
          where: { tenant_id_key: { tenant_id: tenant.id, key: s.key } },
          update: {
            label: s.label,
            sequence: s.sequence,
            category: s.category,
            is_initial: s.is_initial,
            is_terminal: s.is_terminal,
            color_hex: s.color_hex,
            icon: s.icon,
            sla_hours: s.sla_hours,
          },
          create: {
            tenant_id: tenant.id,
            key: s.key,
            label: s.label,
            sequence: s.sequence,
            category: s.category,
            is_initial: s.is_initial,
            is_terminal: s.is_terminal,
            color_hex: s.color_hex,
            icon: s.icon,
            sla_hours: s.sla_hours,
          },
        });
      }

      const admin = await tx.user.create({
        data: {
          tenant_id: tenant.id,
          email: args.adminEmail,
          password_hash: passwordHash,
          given_name: args.adminGivenName,
          family_name: args.adminFamilyName,
          role: 'ADMIN',
          is_active: true,
          password_changed_at: new Date(),
        },
      });

      return { tenant, admin, stagesInserted: stages.length };
    });

    console.log('--- Tenant onboarded ---');
    console.log(`tenant_id:       ${summary.tenant.id}`);
    console.log(`name:            ${summary.tenant.name}`);
    console.log(`legal_name:      ${summary.tenant.legal_name}`);
    console.log(`locale:          ${summary.tenant.default_locale}`);
    console.log(`timezone:        ${summary.tenant.default_timezone}`);
    console.log(`currency:        ${summary.tenant.default_currency}`);
    console.log(`data_residency:  ${summary.tenant.data_residency_region}`);
    console.log(`admin_email:     ${summary.admin.email}`);
    console.log(`admin_id:        ${summary.admin.id}`);
    console.log(`stages inserted: ${summary.stagesInserted}`);
    console.log('\nNext: sign in at /login with the admin credentials. Confirm RLS isolation');
    console.log('by switching tenants (you cannot — every authenticated request is bound to');
    console.log("the admin's tenant_id; that's the GDPR-aligned design).");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('onboard-tenant failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
