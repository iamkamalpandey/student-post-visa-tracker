// HTTP controller for the bulk-import endpoints. Glue between Express request shape and the
// service layer; all heavy lifting (parsing / mapping / chunked apply) lives in
// imports.service.ts.

import type { Request, Response, NextFunction } from 'express';
import { ApplyImportRequest, ImportResource } from '@spv/zod-schemas';
import { BadRequest, Forbidden, NotFound, Unauthorized } from '../../shared/errors.js';
import {
  startImport,
  getStatus,
  getReport,
  apply,
  cancel,
  getResult,
  getErrors,
} from './imports.service.js';

function ctxFrom(req: Request) {
  if (!req.user) throw Unauthorized();
  return {
    tenantId: req.user.tid,
    userId: req.user.sub,
    // SVT-SEC-2026-05 — role plumbed for cross-user import access gating.
    role: req.user.role as 'ADMIN' | 'COUNSELLOR' | 'VIEWER' | undefined,
    ip: req.ip ?? null,
    ua: req.header('user-agent') ?? null,
    requestId: (req as { requestId?: string }).requestId ?? null,
  };
}

function parseResource(value: unknown): ReturnType<typeof ImportResource.parse> {
  const parsed = ImportResource.safeParse(value);
  if (!parsed.success) throw BadRequest('Unknown resource');
  return parsed.data;
}

// GET /imports/:resource/schema
// Hand-built JSON Schema (Draft 2020-12 minimal subset) for each importer.
export function getSchema(req: Request, res: Response, next: NextFunction): void {
  try {
    const resource = parseResource(req.params['resource']);
    const schema = SCHEMAS[resource];
    if (!schema) {
      res.status(501).json({
        type: 'about:blank',
        title: 'Not Implemented',
        status: 501,
        detail: `Schema for resource ${resource} not yet available`,
      });
      return;
    }
    res.json(schema);
  } catch (err) {
    next(err);
  }
}

const SCHEMAS: Record<string, Record<string, unknown> | undefined> = {
  students: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'StudentImportRow',
    type: 'object',
    required: ['given_name', 'family_name', 'name_in_passport', 'date_of_birth', 'nationality_code'],
    properties: {
      external_id: { type: 'string', description: 'Optional client-supplied ID for idempotent merging.' },
      given_name: { type: 'string', minLength: 1, maxLength: 120 },
      middle_name: { type: 'string', minLength: 1, maxLength: 120 },
      family_name: { type: 'string', minLength: 1, maxLength: 120 },
      preferred_name: { type: 'string', minLength: 1, maxLength: 120 },
      name_in_passport: { type: 'string', minLength: 1, maxLength: 200 },
      date_of_birth: { type: 'string', format: 'date', description: 'ISO 8601 (YYYY-MM-DD).' },
      gender: { type: 'string', enum: ['NOT_KNOWN', 'MALE', 'FEMALE', 'NOT_APPLICABLE'] },
      nationality_code: { type: 'string', pattern: '^[A-Z]{2}$', description: 'ISO 3166-1 alpha-2.' },
      primary_language: { type: 'string', minLength: 2, maxLength: 2 },
      email_primary: { type: 'string', format: 'email' },
      email_secondary: { type: 'string', format: 'email' },
      phone_primary_e164: { type: 'string', pattern: '^\\+[1-9]\\d{6,14}$' },
      phone_secondary_e164: { type: 'string', pattern: '^\\+[1-9]\\d{6,14}$' },
    },
    additionalProperties: false,
  },
  institutions: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'InstitutionImportRow',
    type: 'object',
    required: ['legal_name', 'display_name', 'type', 'country_code'],
    properties: {
      legal_name: { type: 'string', minLength: 1, maxLength: 300 },
      display_name: { type: 'string', minLength: 1, maxLength: 300 },
      short_name: { type: 'string', maxLength: 60 },
      type: {
        type: 'string',
        enum: [
          'UNIVERSITY',
          'COLLEGE',
          'COMMUNITY_COLLEGE',
          'POLYTECHNIC',
          'LANGUAGE_SCHOOL',
          'PATHWAY_PROVIDER',
          'VOCATIONAL',
          'HIGH_SCHOOL',
          'OTHER',
        ],
      },
      country_code: { type: 'string', pattern: '^[A-Z]{2}$', description: 'ISO 3166-1 alpha-2.' },
      website: { type: 'string', format: 'uri' },
      email: { type: 'string', format: 'email' },
      phone_e164: { type: 'string', pattern: '^\\+[1-9]\\d{6,14}$' },
      established_year: { type: 'integer', minimum: 1000, maximum: 9999 },
      ranking_global: { type: 'integer', minimum: 1 },
      is_partner: { type: 'boolean' },
      cricos: { type: 'string', description: 'Australian CRICOS code.' },
      ukprn: { type: 'string', description: 'UK Provider Reference Number.' },
      opeid: { type: 'string', description: 'US Office of Postsecondary Education ID.' },
      dli: { type: 'string', description: 'Canadian Designated Learning Institution number.' },
      pic: { type: 'string', description: 'EU Participant Identification Code.' },
    },
    additionalProperties: false,
  },
  programs: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'ProgramImportRow',
    type: 'object',
    required: [
      'institution_legal_name',
      'country_code',
      'name',
      'level',
      'duration_months',
    ],
    properties: {
      institution_legal_name: { type: 'string', minLength: 1, maxLength: 300 },
      country_code: { type: 'string', pattern: '^[A-Z]{2}$' },
      code: { type: 'string', maxLength: 60 },
      name: { type: 'string', minLength: 1, maxLength: 300 },
      short_name: { type: 'string', maxLength: 60 },
      level: {
        type: 'string',
        enum: [
          'PRIMARY',
          'LOWER_SECONDARY',
          'UPPER_SECONDARY',
          'POST_SECONDARY_NON_TERTIARY',
          'FOUNDATION',
          'ASSOCIATE',
          'DIPLOMA',
          'ADVANCED_DIPLOMA',
          'BACHELORS',
          'GRADUATE_CERTIFICATE',
          'GRADUATE_DIPLOMA',
          'POSTGRADUATE_CERTIFICATE',
          'POSTGRADUATE_DIPLOMA',
          'MASTERS',
          'MPHIL',
          'DOCTORATE',
          'PROFESSIONAL',
          'CERTIFICATE',
          'OTHER',
        ],
      },
      field_of_study: { type: 'string', maxLength: 200 },
      isced_code: { type: 'string', pattern: '^\\d{4}$' },
      delivery_mode: {
        type: 'string',
        enum: ['IN_PERSON', 'ONLINE', 'HYBRID', 'DISTANCE'],
      },
      language_of_instruction: { type: 'string', minLength: 2, maxLength: 8 },
      duration_months: { type: 'integer', minimum: 1 },
      credit_hours: { type: 'integer', minimum: 0 },
      description: { type: 'string' },
      url: { type: 'string', format: 'uri' },
      intake_year: { type: 'integer', minimum: 1900, maximum: 2999 },
      intake_month: { type: 'integer', minimum: 1, maximum: 12 },
      intake_label: { type: 'string', maxLength: 60 },
    },
    additionalProperties: false,
  },
  enrollments: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'EnrollmentImportRow',
    type: 'object',
    required: [
      'student_code',
      'institution_legal_name',
      'country_code',
      'program_name',
      'program_level',
    ],
    properties: {
      student_code: { type: 'string', minLength: 1, maxLength: 60 },
      institution_legal_name: { type: 'string', minLength: 1, maxLength: 300 },
      country_code: { type: 'string', pattern: '^[A-Z]{2}$' },
      program_name: { type: 'string', minLength: 1, maxLength: 300 },
      program_level: {
        type: 'string',
        enum: [
          'PRIMARY',
          'LOWER_SECONDARY',
          'UPPER_SECONDARY',
          'POST_SECONDARY_NON_TERTIARY',
          'FOUNDATION',
          'ASSOCIATE',
          'DIPLOMA',
          'ADVANCED_DIPLOMA',
          'BACHELORS',
          'GRADUATE_CERTIFICATE',
          'GRADUATE_DIPLOMA',
          'POSTGRADUATE_CERTIFICATE',
          'POSTGRADUATE_DIPLOMA',
          'MASTERS',
          'MPHIL',
          'DOCTORATE',
          'PROFESSIONAL',
          'CERTIFICATE',
          'OTHER',
        ],
      },
      intake_year: { type: 'integer', minimum: 1900, maximum: 2999 },
      intake_month: { type: 'integer', minimum: 1, maximum: 12 },
      campus_name: { type: 'string', maxLength: 200 },
      enrollment_no: { type: 'string', maxLength: 60 },
      status: {
        type: 'string',
        enum: ['OFFERED', 'ACCEPTED', 'ENROLLED', 'DEFERRED', 'WITHDRAWN', 'COMPLETED', 'CANCELLED'],
      },
      tuition_total_minor: { type: 'integer' },
      tuition_total_major: { type: 'string', pattern: '^-?\\d+(\\.\\d+)?$' },
      tuition_currency: { type: 'string', pattern: '^[A-Z]{3}$' },
      scholarship_minor: { type: 'integer' },
      scholarship_major: { type: 'string', pattern: '^-?\\d+(\\.\\d+)?$' },
      agent_commission_minor: { type: 'integer' },
      agent_commission_major: { type: 'string', pattern: '^-?\\d+(\\.\\d+)?$' },
      start_date: { type: 'string', format: 'date' },
      expected_end_date: { type: 'string', format: 'date' },
    },
    additionalProperties: false,
  },
  program_fees: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    title: 'ProgramFeeImportRow',
    type: 'object',
    required: [
      'institution_legal_name',
      'country_code',
      'program_name',
      'program_level',
      'intake_year',
      'intake_month',
      'fee_type',
      'currency',
    ],
    properties: {
      institution_legal_name: { type: 'string', minLength: 1, maxLength: 300 },
      country_code: { type: 'string', pattern: '^[A-Z]{2}$' },
      program_name: { type: 'string', minLength: 1, maxLength: 300 },
      program_level: {
        type: 'string',
        enum: [
          'PRIMARY',
          'LOWER_SECONDARY',
          'UPPER_SECONDARY',
          'POST_SECONDARY_NON_TERTIARY',
          'FOUNDATION',
          'ASSOCIATE',
          'DIPLOMA',
          'ADVANCED_DIPLOMA',
          'BACHELORS',
          'GRADUATE_CERTIFICATE',
          'GRADUATE_DIPLOMA',
          'POSTGRADUATE_CERTIFICATE',
          'POSTGRADUATE_DIPLOMA',
          'MASTERS',
          'MPHIL',
          'DOCTORATE',
          'PROFESSIONAL',
          'CERTIFICATE',
          'OTHER',
        ],
      },
      intake_year: { type: 'integer', minimum: 1900, maximum: 2999 },
      intake_month: { type: 'integer', minimum: 1, maximum: 12 },
      campus_name: { type: 'string', maxLength: 200 },
      audience: {
        type: 'string',
        enum: ['DOMESTIC', 'INTERNATIONAL', 'REGIONAL', 'OTHER'],
      },
      fee_type: {
        type: 'string',
        enum: [
          'TUITION',
          'REGISTRATION',
          'APPLICATION',
          'DEPOSIT',
          'MATERIALS',
          'LIVING_COST_ESTIMATE',
          'OTHER',
        ],
      },
      amount_minor: { type: 'integer' },
      amount_major: { type: 'string', pattern: '^-?\\d+(\\.\\d+)?$' },
      currency: { type: 'string', pattern: '^[A-Z]{3}$' },
      per_period: {
        type: 'string',
        enum: ['TOTAL', 'YEAR', 'SEMESTER', 'TERM', 'MONTH', 'MODULE'],
      },
      is_estimated: { type: 'boolean' },
      effective_from: { type: 'string', format: 'date' },
    },
    additionalProperties: false,
  },
};

// GET /imports/:resource/template.csv
export function getTemplateCsv(req: Request, res: Response, next: NextFunction): void {
  try {
    const resource = parseResource(req.params['resource']);
    const tpl = TEMPLATES[resource];
    if (!tpl) {
      res.status(501).type('text/plain').send('Template not yet available for this resource.');
      return;
    }
    const body =
      '﻿' +
      tpl.headers.join(',') +
      '\r\n' +
      tpl.sample.map(csvField).join(',') +
      '\r\n';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${resource}-template.csv"`);
    res.send(body);
  } catch (err) {
    next(err);
  }
}

// All sample rows use clearly-test markers (TEST UNIVERSITY, country code XX,
// example.com domains, IDs prefixed with TEST-/TESTONLY-). Reviewers should be
// able to spot a sample row at a glance in any database.
const TEMPLATES: Record<string, { headers: string[]; sample: string[] } | undefined> = {
  students: {
    headers: [
      'external_id',
      'given_name',
      'middle_name',
      'family_name',
      'preferred_name',
      'name_in_passport',
      'date_of_birth',
      'gender',
      'nationality_code',
      'primary_language',
      'email_primary',
      'email_secondary',
      'phone_primary_e164',
      'phone_secondary_e164',
    ],
    sample: [
      'TESTONLY-001',
      'Ada',
      '',
      'Lovelace',
      'Ada',
      'ADA LOVELACE',
      '1815-12-10',
      'FEMALE',
      'XX',
      'en',
      'ada@example.com',
      '',
      '+14155550123',
      '',
    ],
  },
  institutions: {
    headers: [
      'legal_name',
      'display_name',
      'short_name',
      'type',
      'country_code',
      'website',
      'email',
      'phone_e164',
      'established_year',
      'ranking_global',
      'is_partner',
      'cricos',
      'ukprn',
      'opeid',
      'dli',
      'pic',
    ],
    sample: [
      'TEST UNIVERSITY',
      'Test University',
      'TEST-U',
      'UNIVERSITY',
      'XX',
      'https://example.com',
      'admissions@example.com',
      '+14155550123',
      '1900',
      '999',
      'false',
      '',
      '',
      '',
      '',
      '',
    ],
  },
  programs: {
    headers: [
      'institution_legal_name',
      'country_code',
      'code',
      'name',
      'short_name',
      'level',
      'field_of_study',
      'isced_code',
      'delivery_mode',
      'language_of_instruction',
      'duration_months',
      'credit_hours',
      'description',
      'url',
      'intake_year',
      'intake_month',
      'intake_label',
    ],
    sample: [
      'TEST UNIVERSITY',
      'XX',
      'TEST-PROG-101',
      'Test Bachelor of Computing',
      'TBC',
      'BACHELORS',
      'Computing',
      '0613',
      'IN_PERSON',
      'en',
      '36',
      '120',
      'Sample test-only program for the bulk-import template.',
      'https://example.com/programs/test',
      '2099',
      '9',
      'Fall 2099 (TEST)',
    ],
  },
  enrollments: {
    headers: [
      'student_code',
      'institution_legal_name',
      'country_code',
      'program_name',
      'program_level',
      'intake_year',
      'intake_month',
      'campus_name',
      'enrollment_no',
      'status',
      'tuition_total_major',
      'tuition_currency',
      'scholarship_major',
      'agent_commission_major',
      'start_date',
      'expected_end_date',
    ],
    sample: [
      'TEST-STU-0001',
      'TEST UNIVERSITY',
      'XX',
      'Test Bachelor of Computing',
      'BACHELORS',
      '2099',
      '9',
      '',
      'TEST-ENR-0001',
      'OFFERED',
      '12345.67',
      'USD',
      '0.00',
      '0.00',
      '2099-09-01',
      '2102-06-30',
    ],
  },
  program_fees: {
    headers: [
      'institution_legal_name',
      'country_code',
      'program_name',
      'program_level',
      'intake_year',
      'intake_month',
      'campus_name',
      'audience',
      'fee_type',
      'amount_major',
      'currency',
      'per_period',
      'is_estimated',
      'effective_from',
    ],
    sample: [
      'TEST UNIVERSITY',
      'XX',
      'Test Bachelor of Computing',
      'BACHELORS',
      '2099',
      '9',
      '',
      'INTERNATIONAL',
      'TUITION',
      '12345.67',
      'USD',
      'YEAR',
      'false',
      '2099-01-01',
    ],
  },
};

function csvField(s: string): string {
  if (/[,"\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// POST /imports/:resource — multer puts the file under req.file.
export async function postImport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ctx = ctxFrom(req);
    if (req.user!.role === 'VIEWER') throw Forbidden('Viewer role cannot import');
    const resource = parseResource(req.params['resource']);
    const file = (req as Request & { file?: { originalname: string; buffer: Buffer; size: number } }).file;
    if (!file) throw BadRequest('Multipart "file" field is required');
    if (file.size > 50 * 1024 * 1024) throw BadRequest('File exceeds 50MB limit');
    const result = await startImport(
      ctx,
      { filename: file.originalname, buffer: file.buffer },
      resource,
    );
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
}

export async function getJob(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ctx = ctxFrom(req);
    const job = await getStatus(ctx, String(req.params['job_id']));
    res.json(job);
  } catch (err) {
    next(err);
  }
}

export async function getJobReport(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ctx = ctxFrom(req);
    const report = await getReport(ctx, String(req.params['job_id']));
    res.json(report);
  } catch (err) {
    next(err);
  }
}

export async function getJobErrors(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // SVT-RLS-2026-05: prevent shared/proxy caches from retaining sensitive bytes.
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    const ctx = ctxFrom(req);
    const buf = await getErrors(ctx, String(req.params['job_id']));
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="errors.jsonl"`);
    res.send(buf);
  } catch (err) {
    next(err);
  }
}

export async function postApply(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ctx = ctxFrom(req);
    if (req.user!.role === 'VIEWER') throw Forbidden('Viewer role cannot apply imports');
    // Express normalises header names to lowercase; req.header() is case-insensitive.
    const idemRaw = req.header('idempotency-key');
    if (!idemRaw) {
      throw BadRequest('Idempotency-Key header required');
    }
    const idem = idemRaw.trim();
    if (idem.length < 8 || idem.length > 128) {
      throw BadRequest('Idempotency-Key must be 8-128 characters');
    }
    const parsed = ApplyImportRequest.safeParse(req.body);
    if (!parsed.success) {
      throw BadRequest('Invalid apply payload');
    }
    const result = await apply(
      ctx,
      String(req.params['job_id']),
      parsed.data,
      { idempotencyKey: idem },
      req,
    );
    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
}

export async function postCancel(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const ctx = ctxFrom(req);
    if (req.user!.role === 'VIEWER') throw Forbidden('Viewer role cannot cancel');
    const job = await cancel(ctx, String(req.params['job_id']));
    res.json(job);
  } catch (err) {
    next(err);
  }
}

export async function getJobResult(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    // SVT-RLS-2026-05: prevent shared/proxy caches from retaining sensitive bytes.
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    const ctx = ctxFrom(req);
    const buf = await getResult(ctx, String(req.params['job_id']));
    if (!buf || buf.length === 0) throw NotFound('Result not available');
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="result.jsonl"`);
    res.send(buf);
  } catch (err) {
    next(err);
  }
}
