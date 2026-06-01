/**
 * Prisma seed script — idempotent.
 *
 * Seeds:
 *  - Reference tables (countries, currencies, ISCED-F fields, airline IATA, airport IATA, visa categories)
 *  - Per-tenant lookup tables (document_types, relationship_types)
 *  - Default tenant (from env.SEED_TENANT_NAME)
 *  - Default lifecycle stages for the default tenant
 *  - Default ADMIN user (from SEED_ADMIN_* env vars), Argon2-hashed password
 *
 * Usage:
 *   pnpm --filter backend prisma:seed
 *   # or
 *   tsx prisma/seed.ts
 */

import { PrismaClient, Prisma } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { env } from '../src/config/env.js';
import { hashPassword } from '../src/shared/passwords.js';

// Resolve data directory relative to this file (prisma/seed.ts → prisma/data).
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = resolve(__dirname, 'data');

function loadJson<T>(name: string): T {
  const path = resolve(DATA_DIR, name);
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as T;
}

interface CountrySeed {
  code_alpha2: string;
  code_alpha3: string;
  numeric_code: string;
  name: string;
  dial_code: string;
}

interface CurrencySeed {
  code: string;
  name: string;
  minor_unit: number;
  symbol: string | null;
}

interface IscedSeed {
  code: string;
  label: string;
}

interface AirlineSeed {
  iata: string;
  name: string;
}

interface AirportSeed {
  iata: string;
  name: string;
  city: string;
  country_code: string;
}

interface VisaCategorySeed {
  country_code: string;
  code: string;
  name: string;
  description?: string;
  is_student: boolean;
}

interface DocumentTypeSeed {
  key: string;
  label: string;
  is_required: boolean;
  has_expiry: boolean;
  retention_days: number | null;
}

interface RelationshipTypeSeed {
  key: string;
  label: string;
  is_guardian: boolean;
  is_emergency: boolean;
  is_sponsor: boolean;
}

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

const prisma = new PrismaClient();

async function seedCountries(): Promise<number> {
  const countries = loadJson<CountrySeed[]>('iso-countries.json');
  for (const c of countries) {
    await prisma.country.upsert({
      where: { code_alpha2: c.code_alpha2 },
      update: {
        code_alpha3: c.code_alpha3,
        numeric_code: c.numeric_code,
        name: c.name,
        dial_code: c.dial_code,
      },
      create: {
        code_alpha2: c.code_alpha2,
        code_alpha3: c.code_alpha3,
        numeric_code: c.numeric_code,
        name: c.name,
        dial_code: c.dial_code,
      },
    });
  }
  return countries.length;
}

// SVT-LOOKUP-FILTERS-2026-05: ISO codes that have been withdrawn (historical
// currencies + the precious-metal funds codes) — we still seed them so any
// historical FK rows continue to resolve, but mark them inactive so they
// don't appear in the picker.
const DEPRECATED_CURRENCY_CODES: ReadonlySet<string> = new Set([
  'ZRZ', // Zaire
  'ROL', // Romanian leu (pre-2005)
  'TRL', // Turkish lira (pre-2005)
  'XEU', // ECU (predecessor of EUR)
  'EEK', // Estonian kroon
  'LVL', // Latvian lats
  'LTL', // Lithuanian litas
  'MTL', // Maltese lira
  'SIT', // Slovenian tolar
  'SKK', // Slovak koruna
  'CYP', // Cypriot pound
  'XAG', // Silver (one troy ounce)
  'XAU', // Gold (one troy ounce)
  'XPD', // Palladium
  'XPT', // Platinum
]);

async function seedCurrencies(): Promise<number> {
  const currencies = loadJson<CurrencySeed[]>('iso-currencies.json');
  for (const cur of currencies) {
    const isActive = !DEPRECATED_CURRENCY_CODES.has(cur.code);
    await prisma.currency.upsert({
      where: { code: cur.code },
      update: {
        name: cur.name,
        minor_unit: cur.minor_unit,
        symbol: cur.symbol,
        is_active: isActive,
      },
      create: {
        code: cur.code,
        name: cur.name,
        minor_unit: cur.minor_unit,
        symbol: cur.symbol,
        is_active: isActive,
      },
    });
  }
  return currencies.length;
}

async function seedIscedFields(): Promise<number> {
  const fields = loadJson<IscedSeed[]>('isced-f.json');
  for (const f of fields) {
    await prisma.iscedField.upsert({
      where: { code: f.code },
      update: { label: f.label },
      create: { code: f.code, label: f.label },
    });
  }
  return fields.length;
}

async function seedAirlines(): Promise<number> {
  const airlines = loadJson<AirlineSeed[]>('airlines-iata.json');
  for (const a of airlines) {
    await prisma.airlineIATA.upsert({
      where: { iata: a.iata },
      update: { name: a.name },
      create: { iata: a.iata, name: a.name },
    });
  }
  return airlines.length;
}

async function seedAirports(): Promise<number> {
  const airports = loadJson<AirportSeed[]>('airports-iata.json');
  for (const a of airports) {
    await prisma.airportIATA.upsert({
      where: { iata: a.iata },
      update: { name: a.name, city: a.city, country_code: a.country_code },
      create: { iata: a.iata, name: a.name, city: a.city, country_code: a.country_code },
    });
  }
  return airports.length;
}

async function seedVisaCategories(): Promise<number> {
  const cats = loadJson<VisaCategorySeed[]>('visa-categories.json');
  for (const v of cats) {
    await prisma.visaCategory.upsert({
      where: {
        country_code_code: { country_code: v.country_code, code: v.code },
      },
      update: {
        name: v.name,
        description: v.description ?? null,
        is_student: v.is_student,
      },
      create: {
        country_code: v.country_code,
        code: v.code,
        name: v.name,
        description: v.description ?? null,
        is_student: v.is_student,
      },
    });
  }
  return cats.length;
}

async function ensureTenant(): Promise<string> {
  const name = env.SEED_TENANT_NAME;
  let tenant = await prisma.tenant.findFirst({ where: { name } });
  if (!tenant) {
    tenant = await prisma.tenant.create({
      data: {
        name,
        legal_name: name,
        default_locale: 'en',
        default_timezone: 'UTC',
        default_currency: 'USD',
      },
    });
    console.log(`  + Created tenant "${name}" (${tenant.id})`);
  } else {
    console.log(`  = Tenant "${name}" already exists (${tenant.id})`);
  }
  return tenant.id;
}

async function seedDocumentTypes(tenantId: string): Promise<number> {
  const types = loadJson<DocumentTypeSeed[]>('document-types.json');
  // document_types enforces RLS; set the per-request GUC inside a transaction so
  // the policies match the tenant we're inserting under. Mirrors the pattern
  // tenantContext middleware uses at request time.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
    );
    for (const t of types) {
      await tx.documentType.upsert({
        where: { tenant_id_key: { tenant_id: tenantId, key: t.key } },
        update: {
          label: t.label,
          is_required: t.is_required,
          has_expiry: t.has_expiry,
          retention_days: t.retention_days,
        },
        create: {
          tenant_id: tenantId,
          key: t.key,
          label: t.label,
          is_required: t.is_required,
          has_expiry: t.has_expiry,
          retention_days: t.retention_days,
        },
      });
    }
  });
  return types.length;
}

async function seedRelationshipTypes(tenantId: string): Promise<number> {
  const rels = loadJson<RelationshipTypeSeed[]>('relationship-types.json');
  // relationship_types enforces RLS; set the per-request GUC inside a transaction
  // so the policies match the tenant we're inserting under.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
    );
    for (const r of rels) {
      await tx.relationshipType.upsert({
        where: { tenant_id_key: { tenant_id: tenantId, key: r.key } },
        update: {
          label: r.label,
          is_guardian: r.is_guardian,
          is_emergency: r.is_emergency,
          is_sponsor: r.is_sponsor,
        },
        create: {
          tenant_id: tenantId,
          key: r.key,
          label: r.label,
          is_guardian: r.is_guardian,
          is_emergency: r.is_emergency,
          is_sponsor: r.is_sponsor,
        },
      });
    }
  });
  return rels.length;
}

async function seedDefaultStages(tenantId: string): Promise<number> {
  const stages = loadJson<LifecycleStageSeed[]>('default-stages.json');
  // lifecycle_stages enforces RLS; set the per-request GUC inside a transaction
  // so the policies match the tenant we're inserting under.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
    );
    for (const s of stages) {
      const data: Prisma.LifecycleStageUncheckedCreateInput = {
        tenant_id: tenantId,
        key: s.key,
        label: s.label,
        sequence: s.sequence,
        category: s.category,
        is_initial: s.is_initial,
        is_terminal: s.is_terminal,
        color_hex: s.color_hex,
        icon: s.icon,
        sla_hours: s.sla_hours,
      };
      await tx.lifecycleStage.upsert({
        where: { tenant_id_key: { tenant_id: tenantId, key: s.key } },
        update: {
          label: data.label,
          sequence: data.sequence,
          category: data.category,
          is_initial: data.is_initial,
          is_terminal: data.is_terminal,
          color_hex: data.color_hex,
          icon: data.icon,
          sla_hours: data.sla_hours,
        },
        create: data,
      });
    }
  });
  return stages.length;
}

// Canonical post-visa categories per destination country. These rows are
// `is_generic = false` because they're real, citable visa categories — not the
// placeholder generic that visa-types CRUD uses as a tenant default.
//
// Idempotent: upsert keyed by the (tenant_id, country_code, name) unique index.
// Existing rows are left untouched (no description/short_name overwrite) so an
// admin who has tweaked one in the UI doesn't lose their edits.
const COMMON_VISA_TYPES: Array<{ country_code: string; name: string }> = [
  // United States
  { country_code: 'US', name: 'F-1 Student' },
  { country_code: 'US', name: 'J-1 Exchange Visitor' },
  { country_code: 'US', name: 'M-1 Vocational' },
  // United Kingdom
  { country_code: 'GB', name: 'Student Route (Tier 4)' },
  { country_code: 'GB', name: 'Child Student' },
  { country_code: 'GB', name: 'Graduate Route' },
  // Australia
  { country_code: 'AU', name: 'Student (subclass 500)' },
  { country_code: 'AU', name: 'Student Guardian (subclass 590)' },
  { country_code: 'AU', name: 'Temporary Graduate (subclass 485)' },
  // Canada
  { country_code: 'CA', name: 'Study Permit' },
  { country_code: 'CA', name: 'Post-Graduation Work Permit (PGWP)' },
  // New Zealand
  { country_code: 'NZ', name: 'Fee Paying Student' },
  { country_code: 'NZ', name: 'Foreign Government Supported Student' },
  // Ireland
  { country_code: 'IE', name: 'Stamp 2' },
  { country_code: 'IE', name: 'Third Level Graduate Scheme' },
];

async function seedCommonVisaTypesForTenant(
  tenantId: string,
): Promise<{ inserted: number; perCountry: Record<string, number> }> {
  let inserted = 0;
  const perCountry: Record<string, number> = {};
  // visa_types enforces RLS; set the per-request GUC inside a transaction so
  // the policies match the tenant we're inserting under. Mirrors the pattern
  // tenantContext middleware uses at request time.
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`,
    );
    for (const v of COMMON_VISA_TYPES) {
      const before = await tx.visaType.findFirst({
        where: { tenant_id: tenantId, country_code: v.country_code, name: v.name },
        select: { id: true },
      });
      await tx.visaType.upsert({
        where: {
          tenant_id_country_code_name: {
            tenant_id: tenantId,
            country_code: v.country_code,
            name: v.name,
          },
        },
        update: { is_active: true },
        create: {
          tenant_id: tenantId,
          country_code: v.country_code,
          name: v.name,
          is_active: true,
          is_generic: false,
        },
      });
      if (!before) {
        inserted += 1;
        perCountry[v.country_code] = (perCountry[v.country_code] ?? 0) + 1;
      }
    }
  });
  return { inserted, perCountry };
}

async function ensureAdminUser(tenantId: string): Promise<boolean> {
  const email = env.SEED_ADMIN_EMAIL.toLowerCase();
  const existing = await prisma.user.findUnique({
    where: { tenant_id_email: { tenant_id: tenantId, email } },
  });
  if (existing) {
    console.log(`  = Admin user ${email} already exists (skipped)`);
    return false;
  }
  const password_hash = await hashPassword(env.SEED_ADMIN_PASSWORD);
  await prisma.user.create({
    data: {
      tenant_id: tenantId,
      email,
      password_hash,
      given_name: env.SEED_ADMIN_GIVEN_NAME,
      family_name: env.SEED_ADMIN_FAMILY_NAME,
      role: 'ADMIN',
      is_active: true,
      password_changed_at: new Date(),
    },
  });
  console.log(`  + Created admin user ${email}`);
  return true;
}

async function main(): Promise<void> {
  console.log('Seeding reference data...');
  const countries = await seedCountries();
  console.log(`  countries:        ${countries}`);
  const currencies = await seedCurrencies();
  console.log(`  currencies:       ${currencies}`);
  const isced = await seedIscedFields();
  console.log(`  isced fields:     ${isced}`);
  const airlines = await seedAirlines();
  console.log(`  airlines:         ${airlines}`);
  const airports = await seedAirports();
  console.log(`  airports:         ${airports}`);
  const visaCats = await seedVisaCategories();
  console.log(`  visa categories:  ${visaCats}`);

  console.log('\nSeeding default tenant...');
  const tenantId = await ensureTenant();

  // Per-tenant lookups + stages: each writes to an RLS-protected table, so the
  // seed functions wrap their inserts in a transaction that calls
  // `set_config('app.tenant_id', ...)` first. See seedDocumentTypes etc.
  console.log('\nSeeding tenant-scoped lookups...');
  const docTypes = await seedDocumentTypes(tenantId);
  console.log(`  document types:   ${docTypes}`);
  const relTypes = await seedRelationshipTypes(tenantId);
  console.log(`  relationship:     ${relTypes}`);

  console.log('\nSeeding default lifecycle stages...');
  const stages = await seedDefaultStages(tenantId);
  console.log(`  stages:           ${stages}`);

  console.log('\nSeeding admin user...');
  const adminCreated = await ensureAdminUser(tenantId);

  // Per-tenant common visa types. Loops every existing tenant (not just the
  // default) so multi-tenant deployments get the canonical catalogue too.
  console.log('\nSeeding common visa types per tenant...');
  const allTenants = await prisma.tenant.findMany({ select: { id: true, name: true } });
  let visaTypesNew = 0;
  const visaTypesPerCountry: Record<string, number> = {};
  for (const t of allTenants) {
    const r = await seedCommonVisaTypesForTenant(t.id);
    visaTypesNew += r.inserted;
    for (const [k, v] of Object.entries(r.perCountry)) {
      visaTypesPerCountry[k] = (visaTypesPerCountry[k] ?? 0) + v;
    }
    console.log(`  + tenant "${t.name}": +${r.inserted} new`);
  }

  console.log('\n--- Seed summary ---');
  console.log(`tenant:            ${env.SEED_TENANT_NAME} (${tenantId})`);
  console.log(`countries:         ${countries}`);
  console.log(`currencies:        ${currencies}`);
  console.log(`isced fields:      ${isced}`);
  console.log(`airlines:          ${airlines}`);
  console.log(`airports:          ${airports}`);
  console.log(`visa categories:   ${visaCats}`);
  console.log(`document types:    ${docTypes}`);
  console.log(`relationship types:${relTypes}`);
  console.log(`lifecycle stages:  ${stages}`);
  console.log(`admin user:        ${adminCreated ? 'created' : 'already existed'}`);
  console.log(`common visa types: ${visaTypesNew} new across ${allTenants.length} tenant(s)`);
  for (const [code, count] of Object.entries(visaTypesPerCountry)) {
    console.log(`  ${code}: ${count}`);
  }
  console.log('Done.');
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
