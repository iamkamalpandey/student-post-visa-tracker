// Maps a raw mapped row (header → value) into the validated Institution create input.
//
// Required: legal_name, display_name, type (InstitutionType enum), country_code
// (ISO 3166-1 alpha-2, validated against the `countries` lookup table).
// Optional: short_name, website, email, phone_e164, established_year, ranking_global,
// is_partner.
//
// Identifier columns (all optional): cricos, ukprn, opeid, dli, pic. Each non-empty
// value is emitted as an InstitutionIdentifier{ scheme: <upper-case column name>, value }.
//
// Dedup hint (used by the service layer): (tenant_id, legal_name, country_code).

import type { PrismaClient } from '@prisma/client';
import { InstitutionTypeEnum } from '@spv/zod-schemas';
import type { InstitutionType } from '@spv/zod-schemas';
import { coerceEnum } from '../lib/enum-coercion.js';

export type Row = Record<string, unknown>;
export type MapError = { field: string; message: string };

export type InstitutionDraft = {
  legal_name: string;
  display_name: string;
  short_name?: string;
  type: InstitutionType;
  country_code: string;
  website?: string;
  email?: string;
  phone_e164?: string;
  established_year?: number;
  ranking_global?: number;
  is_partner?: boolean;
  identifiers: Array<{ scheme: string; value: string }>;
};

export type MapResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: MapError[] };

const INSTITUTION_TYPES = InstitutionTypeEnum.options;

const IDENTIFIER_COLS = ['cricos', 'ukprn', 'opeid', 'dli', 'pic'] as const;

function pick(row: Row, key: string): string | undefined {
  const v = row[key];
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s.length === 0 ? undefined : s;
}

function pickInt(row: Row, key: string): number | undefined {
  const s = pick(row, key);
  if (s === undefined) return undefined;
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined;
  return n;
}

function pickBool(row: Row, key: string): boolean | undefined {
  const s = pick(row, key);
  if (s === undefined) return undefined;
  const v = s.toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(v)) return false;
  return undefined;
}

function normaliseE164(raw: string): string | null {
  let t = raw.trim().replace(/[\s\-().]/g, '');
  if (!t) return null;
  if (t.startsWith('00')) t = `+${t.slice(2)}`;
  if (!t.startsWith('+')) return null;
  if (!/^\+[1-9]\d{6,14}$/.test(t)) return null;
  return t;
}

export async function mapRow(
  row: Row,
  ctx: { tenantId: string; db: PrismaClient },
): Promise<MapResult<InstitutionDraft>> {
  void ctx.tenantId; // tenant_id is set by the service when persisting.
  const errors: MapError[] = [];

  const legalName = pick(row, 'legal_name');
  if (!legalName) errors.push({ field: 'legal_name', message: 'required' });

  const displayName = pick(row, 'display_name');
  if (!displayName) errors.push({ field: 'display_name', message: 'required' });

  const typeRaw = pick(row, 'type');
  let type: InstitutionType | undefined;
  if (!typeRaw) {
    errors.push({ field: 'type', message: 'required' });
  } else {
    const up = typeRaw.toUpperCase().replace(/[\s-]/g, '_');
    try {
      type = coerceEnum('type', up, InstitutionTypeEnum);
    } catch {
      errors.push({
        field: 'type',
        message: `one of ${INSTITUTION_TYPES.join(', ')}`,
      });
    }
  }

  const countryRaw = pick(row, 'country_code');
  let countryCode: string | undefined;
  if (!countryRaw) {
    errors.push({ field: 'country_code', message: 'required (ISO 3166-1 alpha-2)' });
  } else {
    const up = countryRaw.toUpperCase();
    if (!/^[A-Z]{2}$/.test(up)) {
      errors.push({ field: 'country_code', message: 'must be 2 uppercase letters' });
    } else {
      const exists = await ctx.db.country.findUnique({ where: { code_alpha2: up } });
      if (!exists) {
        errors.push({
          field: 'country_code',
          message: `unknown country code ${up} (not in countries lookup)`,
        });
      } else {
        countryCode = up;
      }
    }
  }

  const shortName = pick(row, 'short_name');
  const website = pick(row, 'website');
  const email = pick(row, 'email');
  const phoneRaw = pick(row, 'phone_e164');
  let phone: string | undefined;
  if (phoneRaw) {
    const n = normaliseE164(phoneRaw);
    if (!n) errors.push({ field: 'phone_e164', message: 'must be E.164 (e.g. +14155550123)' });
    else phone = n;
  }

  const establishedYear = pickInt(row, 'established_year');
  if (establishedYear !== undefined && (establishedYear < 1000 || establishedYear > 9999)) {
    errors.push({ field: 'established_year', message: 'must be a 4-digit year' });
  }
  const rankingGlobal = pickInt(row, 'ranking_global');
  if (rankingGlobal !== undefined && rankingGlobal < 1) {
    errors.push({ field: 'ranking_global', message: 'must be a positive integer' });
  }
  const isPartner = pickBool(row, 'is_partner');

  const identifiers: Array<{ scheme: string; value: string }> = [];
  for (const col of IDENTIFIER_COLS) {
    const v = pick(row, col);
    if (v) identifiers.push({ scheme: col.toUpperCase(), value: v });
  }

  if (errors.length > 0) return { ok: false, errors };

  const draft: InstitutionDraft = {
    legal_name: legalName!,
    display_name: displayName!,
    type: type!,
    country_code: countryCode!,
    identifiers,
  };
  if (shortName !== undefined) draft.short_name = shortName;
  if (website !== undefined) draft.website = website;
  if (email !== undefined) draft.email = email.toLowerCase();
  if (phone !== undefined) draft.phone_e164 = phone;
  if (establishedYear !== undefined) draft.established_year = establishedYear;
  if (rankingGlobal !== undefined) draft.ranking_global = rankingGlobal;
  if (isPartner !== undefined) draft.is_partner = isPartner;

  return { ok: true, value: draft };
}
