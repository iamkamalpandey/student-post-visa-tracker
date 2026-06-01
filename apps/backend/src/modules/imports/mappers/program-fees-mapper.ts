// Maps a raw mapped row into a ProgramFee create input.
//
// Required:
//   - institution_legal_name + country_code (resolves Institution within tenant)
//   - program_name + program_level (resolves Program by (institution, name, level))
//   - intake_year + intake_month (+ optional campus_name) → ProgramIntake
//   - fee_type (FeeType enum)
//   - currency (ISO 4217, validated against Currency lookup)
//   - amount_minor OR amount_major (with currency, converted via Currency.minor_unit)
// Optional:
//   - audience (default INTERNATIONAL)
//   - per_period (default YEAR)
//   - is_estimated (default false)
//   - effective_from (ISO 8601 date)
//
// Dedup hint (used by the service): (program_intake_id, audience, fee_type, currency).

import type { PrismaClient } from '@prisma/client';
import {
  AcademicLevelEnum,
  FeeAudienceEnum,
  FeePeriodEnum,
  FeeTypeEnum,
} from '@spv/zod-schemas';
import type {
  AcademicLevel,
  FeeAudience,
  FeePeriod,
  FeeType,
} from '@spv/zod-schemas';
import { coerceEnum } from '../lib/enum-coercion.js';

export type Row = Record<string, unknown>;
export type MapError = { field: string; message: string };

export type ProgramFeeDraft = {
  program_intake_id: string;
  audience: FeeAudience;
  fee_type: FeeType;
  amount_minor: bigint;
  currency: string;
  per_period: FeePeriod;
  is_estimated: boolean;
  effective_from?: Date;
};

export type MapResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: MapError[] };

const FEE_AUDIENCES = FeeAudienceEnum.options;
const FEE_TYPES = FeeTypeEnum.options;
const FEE_PERIODS = FeePeriodEnum.options;
const ACADEMIC_LEVELS = AcademicLevelEnum.options;

const LEGACY_LEVEL_ALIAS: Record<string, AcademicLevel> = {
  SLC: 'UPPER_SECONDARY',
  SECONDARY: 'LOWER_SECONDARY',
  HIGHER_SECONDARY: 'UPPER_SECONDARY',
};

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

function normaliseIsoDate(raw: string): Date | null {
  const t = raw.trim();
  if (!t) return null;
  const datePart = t.split(/[Tt ]/, 1)[0]!;
  const m = datePart.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return null;
  const yyyy = m[1]!;
  const mm = m[2]!.padStart(2, '0');
  const dd = m[3]!.padStart(2, '0');
  const iso = `${yyyy}-${mm}-${dd}`;
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  if (d.toISOString().slice(0, 10) !== iso) return null;
  return d;
}

function majorToMinor(major: string, minorUnit: number): bigint | null {
  const t = major.trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(t)) return null;
  const neg = t.startsWith('-');
  const abs = neg ? t.slice(1) : t;
  const [intPart, fracPart = ''] = abs.split('.');
  if (fracPart.length > minorUnit) return null;
  const padded = (fracPart + '0'.repeat(minorUnit)).slice(0, minorUnit);
  const combined = `${intPart}${padded}`.replace(/^0+(?=\d)/, '');
  const value = BigInt(combined || '0');
  return neg ? -value : value;
}

export async function mapRow(
  row: Row,
  ctx: { tenantId: string; db: PrismaClient },
): Promise<MapResult<ProgramFeeDraft>> {
  const errors: MapError[] = [];

  // 1. Institution lookup.
  const legalName = pick(row, 'institution_legal_name');
  const countryRaw = pick(row, 'country_code');
  let institutionId: string | undefined;
  if (!legalName) errors.push({ field: 'institution_legal_name', message: 'required' });
  if (!countryRaw) errors.push({ field: 'country_code', message: 'required (ISO 3166-1 alpha-2)' });
  if (legalName && countryRaw) {
    const cc = countryRaw.toUpperCase();
    if (!/^[A-Z]{2}$/.test(cc)) {
      errors.push({ field: 'country_code', message: 'must be 2 uppercase letters' });
    } else {
      const inst = await ctx.db.institution.findFirst({
        where: {
          tenant_id: ctx.tenantId,
          legal_name: legalName,
          country_code: cc,
          deleted_at: null,
        },
        select: { id: true },
      });
      if (!inst) {
        errors.push({
          field: 'institution_legal_name',
          message: `no institution found for "${legalName}" in ${cc}`,
        });
      } else {
        institutionId = inst.id;
      }
    }
  }

  // 2. Program lookup.
  const programName = pick(row, 'program_name');
  const programLevelRaw = pick(row, 'program_level');
  let programId: string | undefined;
  let programLevel: AcademicLevel | undefined;
  if (!programName) errors.push({ field: 'program_name', message: 'required' });
  if (!programLevelRaw) {
    errors.push({ field: 'program_level', message: 'required' });
  } else {
    const up = programLevelRaw.toUpperCase().replace(/[\s-]/g, '_');
    const canonical = LEGACY_LEVEL_ALIAS[up] ?? up;
    try {
      programLevel = coerceEnum('program_level', canonical, AcademicLevelEnum);
    } catch {
      errors.push({ field: 'program_level', message: `one of ${ACADEMIC_LEVELS.join(', ')}` });
    }
  }
  if (institutionId && programName && programLevel) {
    const prog = await ctx.db.program.findFirst({
      where: {
        institution_id: institutionId,
        name: programName,
        level: programLevel,
        deleted_at: null,
      },
      select: { id: true },
    });
    if (!prog) {
      errors.push({
        field: 'program_name',
        message: `no program "${programName}" (${programLevel}) at this institution`,
      });
    } else {
      programId = prog.id;
    }
  }

  // 3. ProgramIntake lookup.
  const intakeYear = pickInt(row, 'intake_year');
  const intakeMonth = pickInt(row, 'intake_month');
  const campusName = pick(row, 'campus_name');
  let campusId: string | undefined;
  let programIntakeId: string | undefined;

  if (intakeYear === undefined) errors.push({ field: 'intake_year', message: 'required' });
  if (intakeMonth === undefined) {
    errors.push({ field: 'intake_month', message: 'required' });
  } else if (intakeMonth < 1 || intakeMonth > 12) {
    errors.push({ field: 'intake_month', message: 'must be 1-12' });
  }

  if (institutionId && campusName) {
    const campus = await ctx.db.campus.findFirst({
      where: { institution_id: institutionId, name: campusName },
      select: { id: true },
    });
    if (!campus) {
      errors.push({
        field: 'campus_name',
        message: `no campus "${campusName}" at this institution`,
      });
    } else {
      campusId = campus.id;
    }
  }
  if (
    programId &&
    intakeYear !== undefined &&
    intakeMonth !== undefined &&
    intakeMonth >= 1 &&
    intakeMonth <= 12
  ) {
    const intake = await ctx.db.programIntake.findFirst({
      where: {
        program_id: programId,
        intake_year: intakeYear,
        intake_month: intakeMonth,
        ...(campusId ? { campus_id: campusId } : {}),
      },
      select: { id: true },
    });
    if (!intake) {
      errors.push({
        field: 'intake_year',
        message: `no program intake for ${intakeYear}-${intakeMonth}${campusName ? ` at ${campusName}` : ''}`,
      });
    } else {
      programIntakeId = intake.id;
    }
  }

  // 4. Audience / fee_type / per_period defaults + validation.
  const audienceRaw = pick(row, 'audience');
  let audience: FeeAudience = 'INTERNATIONAL';
  if (audienceRaw) {
    const up = audienceRaw.toUpperCase().replace(/[\s-]/g, '_');
    try {
      audience = coerceEnum('audience', up, FeeAudienceEnum);
    } catch {
      errors.push({ field: 'audience', message: `one of ${FEE_AUDIENCES.join(', ')}` });
    }
  }

  const feeTypeRaw = pick(row, 'fee_type');
  let feeType: FeeType | undefined;
  if (!feeTypeRaw) {
    errors.push({ field: 'fee_type', message: 'required' });
  } else {
    const up = feeTypeRaw.toUpperCase().replace(/[\s-]/g, '_');
    try {
      feeType = coerceEnum('fee_type', up, FeeTypeEnum);
    } catch {
      errors.push({ field: 'fee_type', message: `one of ${FEE_TYPES.join(', ')}` });
    }
  }

  const perPeriodRaw = pick(row, 'per_period');
  let perPeriod: FeePeriod = 'YEAR';
  if (perPeriodRaw) {
    const up = perPeriodRaw.toUpperCase().replace(/[\s-]/g, '_');
    try {
      perPeriod = coerceEnum('per_period', up, FeePeriodEnum);
    } catch {
      errors.push({ field: 'per_period', message: `one of ${FEE_PERIODS.join(', ')}` });
    }
  }

  // 5. Currency + amount.
  const currencyRaw = pick(row, 'currency');
  let currency: string | undefined;
  let minorUnit = 2;
  if (!currencyRaw) {
    errors.push({ field: 'currency', message: 'required (ISO 4217)' });
  } else {
    const up = currencyRaw.toUpperCase();
    if (!/^[A-Z]{3}$/.test(up)) {
      errors.push({ field: 'currency', message: 'must be 3 uppercase letters (ISO 4217)' });
    } else {
      const cur = await ctx.db.currency.findUnique({ where: { code: up } });
      if (!cur) {
        errors.push({ field: 'currency', message: `unknown currency ${up}` });
      } else {
        currency = up;
        minorUnit = cur.minor_unit;
      }
    }
  }

  let amountMinor: bigint | undefined;
  const amountMinorRaw = pick(row, 'amount_minor');
  const amountMajorRaw = pick(row, 'amount_major');
  if (amountMinorRaw !== undefined) {
    if (!/^-?\d+$/.test(amountMinorRaw)) {
      errors.push({ field: 'amount_minor', message: 'must be an integer (minor units)' });
    } else {
      amountMinor = BigInt(amountMinorRaw);
    }
  } else if (amountMajorRaw !== undefined) {
    if (!currency) {
      errors.push({ field: 'amount_major', message: 'requires currency to convert' });
    } else {
      const v = majorToMinor(amountMajorRaw, minorUnit);
      if (v === null) {
        errors.push({ field: 'amount_major', message: 'invalid decimal amount' });
      } else {
        amountMinor = v;
      }
    }
  } else {
    errors.push({ field: 'amount_minor', message: 'required (or provide amount_major + currency)' });
  }

  const isEstimated = pickBool(row, 'is_estimated') ?? false;
  const effectiveFromRaw = pick(row, 'effective_from');
  let effectiveFrom: Date | undefined;
  if (effectiveFromRaw) {
    const d = normaliseIsoDate(effectiveFromRaw);
    if (!d) errors.push({ field: 'effective_from', message: 'invalid ISO 8601 date' });
    else effectiveFrom = d;
  }

  if (errors.length > 0) return { ok: false, errors };

  const draft: ProgramFeeDraft = {
    program_intake_id: programIntakeId!,
    audience,
    fee_type: feeType!,
    amount_minor: amountMinor!,
    currency: currency!,
    per_period: perPeriod,
    is_estimated: isEstimated,
  };
  if (effectiveFrom !== undefined) draft.effective_from = effectiveFrom;

  return { ok: true, value: draft };
}
