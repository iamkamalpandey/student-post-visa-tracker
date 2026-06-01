// Maps a raw mapped row into a Program create input plus an optional ProgramIntake.
//
// Required: institution_legal_name, country_code (used to resolve institution within tenant),
// name, level (AcademicLevel enum), duration_months.
// Optional: code, short_name, field_of_study, isced_code, delivery_mode,
// language_of_instruction, credit_hours, description, url.
// Intake: if intake_year + intake_month + intake_label are all present, also emit a
// ProgramIntake row.
//
// Dedup hint (used by the service layer): (institution_id, name, level).

import type { PrismaClient } from '@prisma/client';
import { AcademicLevelEnum, DeliveryModeEnum } from '@spv/zod-schemas';
import type { AcademicLevel, DeliveryMode } from '@spv/zod-schemas';
import { coerceEnum } from '../lib/enum-coercion.js';

export type Row = Record<string, unknown>;
export type MapError = { field: string; message: string };

export type ProgramDraft = {
  institution_id: string;
  code?: string;
  name: string;
  short_name?: string;
  level: AcademicLevel;
  field_of_study?: string;
  isced_code?: string;
  delivery_mode?: DeliveryMode;
  language_of_instruction?: string;
  duration_months: number;
  credit_hours?: number;
  description?: string;
  url?: string;
  intake?: {
    intake_year: number;
    intake_month: number;
    intake_label: string;
  };
};

export type MapResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: MapError[] };

const ACADEMIC_LEVELS = AcademicLevelEnum.options;

// Backwards-compat: old CSV exports may carry SAARC labels.
const LEGACY_LEVEL_ALIAS: Record<string, AcademicLevel> = {
  SLC: 'UPPER_SECONDARY',
  SECONDARY: 'LOWER_SECONDARY',
  HIGHER_SECONDARY: 'UPPER_SECONDARY',
};

const DELIVERY_MODES = DeliveryModeEnum.options;

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

export async function mapRow(
  row: Row,
  ctx: { tenantId: string; db: PrismaClient },
): Promise<MapResult<ProgramDraft>> {
  const errors: MapError[] = [];

  // Resolve institution by (tenant_id, legal_name, country_code).
  const legalName = pick(row, 'institution_legal_name');
  const countryRaw = pick(row, 'country_code');
  let institutionId: string | undefined;

  if (!legalName) {
    errors.push({ field: 'institution_legal_name', message: 'required' });
  }
  if (!countryRaw) {
    errors.push({ field: 'country_code', message: 'required (ISO 3166-1 alpha-2)' });
  }

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

  const name = pick(row, 'name');
  if (!name) errors.push({ field: 'name', message: 'required' });

  const levelRaw = pick(row, 'level');
  let level: AcademicLevel | undefined;
  if (!levelRaw) {
    errors.push({ field: 'level', message: 'required' });
  } else {
    const raw = levelRaw.toUpperCase().replace(/[\s-]/g, '_');
    const canonical = LEGACY_LEVEL_ALIAS[raw] ?? raw;
    try {
      level = coerceEnum('level', canonical, AcademicLevelEnum);
    } catch {
      errors.push({ field: 'level', message: `one of ${ACADEMIC_LEVELS.join(', ')}` });
    }
  }

  const duration = pickInt(row, 'duration_months');
  if (duration === undefined) {
    errors.push({ field: 'duration_months', message: 'required (positive integer)' });
  } else if (duration < 1) {
    errors.push({ field: 'duration_months', message: 'must be a positive integer' });
  }

  const code = pick(row, 'code');
  const shortName = pick(row, 'short_name');
  const fieldOfStudy = pick(row, 'field_of_study');
  const iscedCode = pick(row, 'isced_code');
  if (iscedCode !== undefined && !/^\d{4}$/.test(iscedCode)) {
    errors.push({ field: 'isced_code', message: 'must be 4 digits' });
  }
  const deliveryRaw = pick(row, 'delivery_mode');
  let deliveryMode: DeliveryMode | undefined;
  if (deliveryRaw !== undefined) {
    const up = deliveryRaw.toUpperCase().replace(/[\s-]/g, '_');
    try {
      deliveryMode = coerceEnum('delivery_mode', up, DeliveryModeEnum);
    } catch {
      errors.push({ field: 'delivery_mode', message: `one of ${DELIVERY_MODES.join(', ')}` });
    }
  }
  const lang = pick(row, 'language_of_instruction');
  const creditHours = pickInt(row, 'credit_hours');
  if (creditHours !== undefined && creditHours < 0) {
    errors.push({ field: 'credit_hours', message: 'must be non-negative' });
  }
  const description = pick(row, 'description');
  const url = pick(row, 'url');

  // Optional intake.
  const intakeYear = pickInt(row, 'intake_year');
  const intakeMonth = pickInt(row, 'intake_month');
  const intakeLabel = pick(row, 'intake_label');
  let intake: ProgramDraft['intake'] | undefined;
  if (intakeYear !== undefined || intakeMonth !== undefined || intakeLabel !== undefined) {
    if (intakeYear === undefined) {
      errors.push({ field: 'intake_year', message: 'required when any intake_* column is set' });
    }
    if (intakeMonth === undefined) {
      errors.push({ field: 'intake_month', message: 'required when any intake_* column is set' });
    } else if (intakeMonth < 1 || intakeMonth > 12) {
      errors.push({ field: 'intake_month', message: 'must be 1-12' });
    }
    if (!intakeLabel) {
      errors.push({ field: 'intake_label', message: 'required when any intake_* column is set' });
    }
    if (
      intakeYear !== undefined &&
      intakeMonth !== undefined &&
      intakeMonth >= 1 &&
      intakeMonth <= 12 &&
      intakeLabel
    ) {
      intake = { intake_year: intakeYear, intake_month: intakeMonth, intake_label: intakeLabel };
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const draft: ProgramDraft = {
    institution_id: institutionId!,
    name: name!,
    level: level!,
    duration_months: duration!,
  };
  if (code !== undefined) draft.code = code;
  if (shortName !== undefined) draft.short_name = shortName;
  if (fieldOfStudy !== undefined) draft.field_of_study = fieldOfStudy;
  if (iscedCode !== undefined) draft.isced_code = iscedCode;
  if (deliveryMode !== undefined) draft.delivery_mode = deliveryMode;
  if (lang !== undefined) draft.language_of_instruction = lang;
  if (creditHours !== undefined) draft.credit_hours = creditHours;
  if (description !== undefined) draft.description = description;
  if (url !== undefined) draft.url = url;
  if (intake !== undefined) draft.intake = intake;

  return { ok: true, value: draft };
}
