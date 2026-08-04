// Maps a raw mapped row into an Enrollment upsert input.
//
// Required:
//   - student_code (resolves to Student.id within tenant)
//   - institution_legal_name + country_code (resolves Institution within tenant)
//   - program_name + program_level (resolves Program by (institution, name, level))
// Optional intake resolution: intake_year + intake_month + (campus_name) → ProgramIntake.
// Optional: enrollment_no, status (default OFFERED), tuition_total_major +
// tuition_currency (converted to BigInt minor units via Currency.minor_unit),
// scholarship_major / scholarship_minor, agent_commission_major /
// agent_commission_minor, start_date, expected_end_date.
//
// Dedup hint (used by the service): (student_id, institution_id, program_id) — upsert.

import type { PrismaClient } from '@prisma/client';
import { AcademicLevelEnum, EnrollmentStatusEnum } from '@spv/zod-schemas';
import type { AcademicLevel, EnrollmentStatus } from '@spv/zod-schemas';
import { coerceEnum } from '../lib/enum-coercion.js';

export type Row = Record<string, unknown>;
export type MapError = { field: string; message: string };

export type EnrollmentDraft = {
  student_id: string;
  institution_id: string;
  program_id: string;
  program_intake_id?: string;
  campus_id?: string;
  enrollment_no?: string;
  status: EnrollmentStatus;
  tuition_total_minor?: bigint;
  tuition_currency?: string;
  scholarship_minor?: bigint;
  agent_commission_minor?: bigint;
  start_date?: Date;
  expected_end_date?: Date;
};

export type MapResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: MapError[] };

const ENROLLMENT_STATUSES = EnrollmentStatusEnum.options;
const ACADEMIC_LEVELS = AcademicLevelEnum.options;

// Backwards-compat mapping for legacy SAARC labels in old CSVs.
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

/** Convert a major-unit decimal string (e.g. "1234.56") to minor-unit BigInt. */
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

async function resolveMoney(
  row: Row,
  majorKey: string,
  minorKey: string,
  currency: string | undefined,
  ctx: { db: PrismaClient },
  errors: MapError[],
): Promise<bigint | undefined> {
  const minorRaw = pick(row, minorKey);
  if (minorRaw !== undefined) {
    // SVT-FIN-2026-08 — the regex here used to be /^-?\d+$/, accepting a
    // leading minus. The importer writes straight to Prisma without re-running
    // the API schema (which does enforce .nonnegative()), so a CSV row carrying
    // tuition_total_minor = -100000000 was written verbatim — and an ACCEPTED
    // enrollment then auto-created a commission claim of -10000000, which
    // summary() summed into outstanding_total_minor as a fabricated credit
    // netting against real receivables. Tuition is never negative; a refund or
    // discount is modelled as an adjustment, not as negative tuition.
    if (!/^\d+$/.test(minorRaw)) {
      errors.push({
        field: minorKey,
        message: 'must be a non-negative integer (minor units)',
      });
      return undefined;
    }
    return BigInt(minorRaw);
  }
  const majorRaw = pick(row, majorKey);
  if (majorRaw === undefined) return undefined;
  if (!currency) {
    errors.push({
      field: majorKey,
      message: `requires tuition_currency to convert to minor units`,
    });
    return undefined;
  }
  const cur = await ctx.db.currency.findUnique({ where: { code: currency } });
  if (!cur) {
    errors.push({ field: 'tuition_currency', message: `unknown currency ${currency}` });
    return undefined;
  }
  const v = majorToMinor(majorRaw, cur.minor_unit);
  if (v === null) {
    errors.push({ field: majorKey, message: 'invalid decimal amount' });
    return undefined;
  }
  // SVT-FIN-2026-08 — same rule as the minor-unit branch above: tuition is
  // never negative, and this path also bypasses the API schema's .nonnegative().
  if (v < 0n) {
    errors.push({ field: majorKey, message: 'must be a non-negative amount' });
    return undefined;
  }
  return v;
}

export async function mapRow(
  row: Row,
  ctx: { tenantId: string; db: PrismaClient },
): Promise<MapResult<EnrollmentDraft>> {
  const errors: MapError[] = [];

  // 1. Student lookup by student_code.
  const studentCode = pick(row, 'student_code');
  let studentId: string | undefined;
  if (!studentCode) {
    errors.push({ field: 'student_code', message: 'required' });
  } else {
    const student = await ctx.db.student.findFirst({
      where: { tenant_id: ctx.tenantId, student_code: studentCode, deleted_at: null },
      select: { id: true },
    });
    if (!student) {
      errors.push({ field: 'student_code', message: `no student with code ${studentCode}` });
    } else {
      studentId = student.id;
    }
  }

  // 2. Institution lookup.
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

  // 3. Program lookup.
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

  // 4. Optional ProgramIntake lookup.
  const intakeYear = pickInt(row, 'intake_year');
  const intakeMonth = pickInt(row, 'intake_month');
  const campusName = pick(row, 'campus_name');
  let programIntakeId: string | undefined;
  let campusId: string | undefined;
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
  if (programId && intakeYear !== undefined && intakeMonth !== undefined) {
    if (intakeMonth < 1 || intakeMonth > 12) {
      errors.push({ field: 'intake_month', message: 'must be 1-12' });
    } else {
      const intake = await ctx.db.programIntake.findFirst({
        where: {
          program_id: programId,
          intake_year: intakeYear,
          intake_month: intakeMonth,
          ...(campusId ? { campus_id: campusId } : {}),
        },
        select: { id: true, campus_id: true },
      });
      if (!intake) {
        errors.push({
          field: 'intake_year',
          message: `no program intake for ${intakeYear}-${intakeMonth}${campusName ? ` at ${campusName}` : ''}`,
        });
      } else {
        programIntakeId = intake.id;
        if (!campusId && intake.campus_id) campusId = intake.campus_id;
      }
    }
  } else if (intakeYear !== undefined || intakeMonth !== undefined) {
    if (intakeYear === undefined) {
      errors.push({ field: 'intake_year', message: 'required when intake_month is set' });
    }
    if (intakeMonth === undefined) {
      errors.push({ field: 'intake_month', message: 'required when intake_year is set' });
    }
  }

  // 5. Status default.
  const statusRaw = pick(row, 'status');
  let status: EnrollmentStatus = 'OFFERED';
  if (statusRaw) {
    const up = statusRaw.toUpperCase().replace(/[\s-]/g, '_');
    try {
      status = coerceEnum('status', up, EnrollmentStatusEnum);
    } catch {
      errors.push({ field: 'status', message: `one of ${ENROLLMENT_STATUSES.join(', ')}` });
    }
  }

  // 6. Money fields.
  const currencyRaw = pick(row, 'tuition_currency');
  let currency: string | undefined;
  if (currencyRaw) {
    const up = currencyRaw.toUpperCase();
    if (!/^[A-Z]{3}$/.test(up)) {
      errors.push({ field: 'tuition_currency', message: 'must be 3 uppercase letters (ISO 4217)' });
    } else {
      const exists = await ctx.db.currency.findUnique({ where: { code: up } });
      if (!exists) {
        errors.push({ field: 'tuition_currency', message: `unknown currency ${up}` });
      } else {
        currency = up;
      }
    }
  }
  const tuitionMinor = await resolveMoney(
    row,
    'tuition_total_major',
    'tuition_total_minor',
    currency,
    ctx,
    errors,
  );
  const scholarshipMinor = await resolveMoney(
    row,
    'scholarship_major',
    'scholarship_minor',
    currency,
    ctx,
    errors,
  );
  const agentCommissionMinor = await resolveMoney(
    row,
    'agent_commission_major',
    'agent_commission_minor',
    currency,
    ctx,
    errors,
  );

  // 7. Dates.
  const startRaw = pick(row, 'start_date');
  let startDate: Date | undefined;
  if (startRaw) {
    const d = normaliseIsoDate(startRaw);
    if (!d) errors.push({ field: 'start_date', message: 'invalid ISO 8601 date' });
    else startDate = d;
  }
  const endRaw = pick(row, 'expected_end_date');
  let expectedEndDate: Date | undefined;
  if (endRaw) {
    const d = normaliseIsoDate(endRaw);
    if (!d) errors.push({ field: 'expected_end_date', message: 'invalid ISO 8601 date' });
    else expectedEndDate = d;
  }

  const enrollmentNo = pick(row, 'enrollment_no');

  if (errors.length > 0) return { ok: false, errors };

  const draft: EnrollmentDraft = {
    student_id: studentId!,
    institution_id: institutionId!,
    program_id: programId!,
    status,
  };
  if (programIntakeId !== undefined) draft.program_intake_id = programIntakeId;
  if (campusId !== undefined) draft.campus_id = campusId;
  if (enrollmentNo !== undefined) draft.enrollment_no = enrollmentNo;
  if (tuitionMinor !== undefined) draft.tuition_total_minor = tuitionMinor;
  if (currency !== undefined) draft.tuition_currency = currency;
  if (scholarshipMinor !== undefined) draft.scholarship_minor = scholarshipMinor;
  if (agentCommissionMinor !== undefined) draft.agent_commission_minor = agentCommissionMinor;
  if (startDate !== undefined) draft.start_date = startDate;
  if (expectedEndDate !== undefined) draft.expected_end_date = expectedEndDate;

  return { ok: true, value: draft };
}
