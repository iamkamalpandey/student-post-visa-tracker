// Maps a raw mapped row (header → value) into the validated `students.service.create`
// input shape. Returns a Result-style discriminated union so the caller can collect
// per-row errors without throwing.
//
// Coercion rules
// --------------
//   - `date_of_birth` must be ISO 8601 calendar date (YYYY-MM-DD). We normalise common
//     spreadsheet variants: leading whitespace, lowercase 't' separator, missing leading zero.
//   - `nationality_code` is upper-cased; we only accept ISO 3166-1 alpha-2.
//   - `phone_primary_e164` / `_secondary_e164` are normalised to E.164: leading `00` becomes
//     `+`, embedded spaces / dashes / parentheses are stripped. We do NOT guess country
//     codes — a number must already start with `+` or `00` after normalisation.
//   - `name_in_passport` must be non-empty after trim.
//
// Anything outside this allow-list is left to the Zod schema in
// @spv/zod-schemas → CreateStudentRequest, which is the authoritative contract.

import {
  CreateStudentRequest,
  type CreateStudentRequest as CreateStudentRequestType,
} from '@spv/zod-schemas';

export type MapError = { field: string; message: string };
export type MapResult =
  | { ok: true; value: CreateStudentRequestType; external_id?: string }
  | { ok: false; errors: MapError[] };

/**
 * Loose ISO 8601 date acceptor. Accepts:
 *   - 2025-01-31
 *   - 2025-1-31  (we left-pad)
 *   - 2025/01/31 (we slash-swap)
 *   - 2025-01-31T00:00:00Z (we drop the time)
 *
 * Rejects everything else.
 */
function normaliseIsoDate(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  // Strip a time portion if present.
  const datePart = t.split(/[Tt ]/, 1)[0]!;
  const m = datePart.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const yyyy = y!;
  const mm = mo!.padStart(2, '0');
  const dd = d!.padStart(2, '0');
  // Leniently validate calendar date via Date so 2025-02-30 is rejected.
  const iso = `${yyyy}-${mm}-${dd}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Round-trip check rejects out-of-range months / days.
  const rt = parsed.toISOString().slice(0, 10);
  if (rt !== iso) return null;
  return iso;
}

/**
 * E.164 normalisation that does NOT guess a country code. The phone must already be in
 * international form (leading `+` or leading `00`).
 */
function normaliseE164(raw: string): string | null {
  let t = raw.trim().replace(/[\s\-().]/g, '');
  if (!t) return null;
  if (t.startsWith('00')) t = `+${t.slice(2)}`;
  if (!t.startsWith('+')) return null;
  if (!/^\+[1-9]\d{6,14}$/.test(t)) return null;
  return t;
}

function pick(row: Record<string, unknown>, key: string): string | undefined {
  const v = row[key];
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s.length === 0 ? undefined : s;
}

/**
 * Map a mapped row (i.e. keys are already canonical thanks to the import mapping json)
 * into the create-student input. The optional second parameter exposes the row's external_id
 * so the caller can dedupe via ExternalId.
 */
export function mapStudentRow(row: Record<string, unknown>): MapResult {
  const errors: MapError[] = [];
  const draft: Record<string, unknown> = {};

  // Required identity fields.
  const givenName = pick(row, 'given_name');
  if (!givenName) errors.push({ field: 'given_name', message: 'required' });
  else draft['given_name'] = givenName;

  const familyName = pick(row, 'family_name');
  if (!familyName) errors.push({ field: 'family_name', message: 'required' });
  else draft['family_name'] = familyName;

  const namePassport = pick(row, 'name_in_passport');
  if (!namePassport) errors.push({ field: 'name_in_passport', message: 'required' });
  else draft['name_in_passport'] = namePassport;

  // Date of birth (ISO 8601, YYYY-MM-DD).
  const dob = pick(row, 'date_of_birth');
  if (!dob) {
    errors.push({ field: 'date_of_birth', message: 'required (ISO 8601 YYYY-MM-DD)' });
  } else {
    const iso = normaliseIsoDate(dob);
    if (!iso) errors.push({ field: 'date_of_birth', message: 'invalid ISO 8601 date' });
    else draft['date_of_birth'] = iso;
  }

  // Nationality (ISO 3166-1 alpha-2, upper-cased).
  const nat = pick(row, 'nationality_code');
  if (!nat) {
    errors.push({ field: 'nationality_code', message: 'required (ISO 3166-1 alpha-2)' });
  } else {
    const up = nat.toUpperCase();
    if (!/^[A-Z]{2}$/.test(up)) {
      errors.push({ field: 'nationality_code', message: 'must be 2 uppercase letters' });
    } else {
      draft['nationality_code'] = up;
    }
  }

  // Gender (default NOT_KNOWN). Accepts case-insensitive enum value.
  const gender = pick(row, 'gender');
  if (gender) {
    const up = gender.toUpperCase().replace(/[\s-]/g, '_');
    const allowed = ['NOT_KNOWN', 'MALE', 'FEMALE', 'NOT_APPLICABLE'];
    if (!allowed.includes(up)) {
      errors.push({ field: 'gender', message: `one of ${allowed.join(', ')}` });
    } else {
      draft['gender'] = up;
    }
  } else {
    draft['gender'] = 'NOT_KNOWN';
  }

  // Optional identity fields.
  const middle = pick(row, 'middle_name');
  if (middle) draft['middle_name'] = middle;
  const preferred = pick(row, 'preferred_name');
  if (preferred) draft['preferred_name'] = preferred;

  // Language code defaults to 'en' to match the Student model default.
  const lang = pick(row, 'primary_language');
  draft['primary_language'] = lang ?? 'en';

  // Optional contact fields.
  const emailPrimary = pick(row, 'email_primary');
  if (emailPrimary) draft['email_primary'] = emailPrimary.toLowerCase();
  const emailSecondary = pick(row, 'email_secondary');
  if (emailSecondary) draft['email_secondary'] = emailSecondary.toLowerCase();

  const phonePrimary = pick(row, 'phone_primary_e164');
  if (phonePrimary) {
    const n = normaliseE164(phonePrimary);
    if (!n) errors.push({ field: 'phone_primary_e164', message: 'must be E.164 (e.g. +14155550123)' });
    else draft['phone_primary_e164'] = n;
  }
  const phoneSecondary = pick(row, 'phone_secondary_e164');
  if (phoneSecondary) {
    const n = normaliseE164(phoneSecondary);
    if (!n) errors.push({ field: 'phone_secondary_e164', message: 'must be E.164' });
    else draft['phone_secondary_e164'] = n;
  }

  // Hand to the authoritative Zod schema for the final validation pass.
  if (errors.length > 0) return { ok: false, errors };

  const parsed = CreateStudentRequest.safeParse(draft);
  if (!parsed.success) {
    const zerr = parsed.error.issues.map((i) => ({
      field: i.path.join('.') || '(root)',
      message: i.message,
    }));
    return { ok: false, errors: zerr };
  }

  const externalId = pick(row, 'external_id');
  return externalId
    ? { ok: true, value: parsed.data, external_id: externalId }
    : { ok: true, value: parsed.data };
}
