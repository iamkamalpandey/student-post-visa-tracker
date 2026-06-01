// Hand-declared OpenAPI 3.1 document for the Student Post-Visa Tracker API.
//
// We intentionally do NOT scan routes at runtime — Express does not retain
// enough metadata for a faithful spec, and decorating each route would impose
// noise on contributors. Instead we co-locate the contract here and rely on
// reviewers to keep it in step. Drift is caught by the contract tests under
// apps/backend/tests/openapi.spec.ts.
//
// Schemas referenced by name (#/components/schemas/...) are converted from the
// canonical Zod definitions in @spv/zod-schemas via zodToSchema().

import * as schemas from '@spv/zod-schemas';
import { zodToSchema, type OpenApiSchema } from './zod-to-openapi.js';

// Endpoints we know are exercised in the codebase but the converter cannot
// faithfully describe yet (e.g. multipart upload bodies, pre-signed URL flows,
// freeform JSON bodies). Tracked here so it shows up in the dev console.
export const TODO_GAPS: readonly string[] = [
  'POST /imports/{resource} — multipart/form-data file upload (binary body)',
  'POST /students/{id}/documents — multipart/form-data file upload (binary body)',
  'GET /documents/{id}/download — binary stream / signed redirect',
  'GET /imports/{job_id}/template.csv — CSV streaming response',
  'POST /exports — response is a job handle but the streaming download is opaque',
];

type Method = 'get' | 'post' | 'patch' | 'delete' | 'put';

interface Operation {
  summary: string;
  description?: string;
  tags?: string[];
  security?: Array<Record<string, string[]>>;
  parameters?: Array<{
    name: string;
    in: 'path' | 'query' | 'header';
    required?: boolean;
    schema: OpenApiSchema | { $ref: string };
    description?: string;
  }>;
  requestBody?: {
    required?: boolean;
    content: Record<string, { schema: OpenApiSchema | { $ref: string } }>;
  };
  responses: Record<string, {
    description: string;
    content?: Record<string, { schema: OpenApiSchema | { $ref: string } }>;
    $ref?: string;
  } | { $ref: string }>;
}

type PathItem = Partial<Record<Method, Operation>>;

const bearer = [{ bearerAuth: [] }];

// ---------------------------------------------------------------------------
// Component schemas: convert each Zod schema we want to expose by name.
// We swallow any conversion failure (the converter returns {}) rather than
// blocking the whole spec on one tricky shape.
// ---------------------------------------------------------------------------

function safe(name: keyof typeof schemas): OpenApiSchema {
  try {
    const z = schemas[name];
    if (z && typeof z === 'object' && '_def' in (z as object)) {
      return zodToSchema(z as Parameters<typeof zodToSchema>[0]);
    }
  } catch {
    // Fall through to empty schema.
  }
  return {};
}

const componentSchemas: Record<string, OpenApiSchema> = {
  // Auth
  LoginRequest: safe('LoginRequest'),
  ChangePasswordRequest: safe('ChangePasswordRequest'),
  RefreshRequest: safe('RefreshRequest'),
  AuthUserResponse: safe('AuthUserResponse'),
  TokenResponse: safe('TokenResponse'),
  // SVT-WAVE-OPENAPI-AUDIT-2026-05 — expose schemas already referenced by name
  // in the path registrations below. Without these entries the `$ref` arrows
  // dangle and Swagger UI silently drops the body schema.
  RequestPasswordResetRequest: safe('RequestPasswordResetRequest'),
  ConfirmPasswordResetRequest: safe('ConfirmPasswordResetRequest'),
  VerifyMfaRequest: safe('VerifyMfaRequest'),
  DisableMfaRequest: safe('DisableMfaRequest'),
  AdminDisableMfaRequest: safe('AdminDisableMfaRequest'),
  UpdateMyPreferencesRequest: safe('UpdateMyPreferencesRequest'),
  PublicDSARRequest: safe('PublicDSARRequest'),
  VoidPaymentRequest: safe('VoidPaymentRequest'),
  FailRefundRequest: safe('FailRefundRequest'),
  // Students
  CreateStudentRequest: safe('CreateStudentRequest'),
  UpdateStudentRequest: safe('UpdateStudentRequest'),
  StudentListQuery: safe('StudentListQuery'),
  AdvanceStageRequest: safe('AdvanceStageRequest'),
  // Stages
  CreateStageRequest: safe('CreateStageRequest'),
  UpdateStageRequest: safe('UpdateStageRequest'),
  ReorderStagesRequest: safe('ReorderStagesRequest'),
  CreateTransitionRequest: safe('CreateTransitionRequest'),
  PreviewImpactRequest: safe('PreviewImpactRequest'),
  // Institutions
  CreateInstitutionRequest: safe('CreateInstitutionRequest'),
  UpdateInstitutionRequest: safe('UpdateInstitutionRequest'),
  InstitutionListQuery: safe('InstitutionListQuery'),
  CreateInstitutionIdentifierRequest: safe('CreateInstitutionIdentifierRequest'),
  CreateInstitutionAccreditationRequest: safe('CreateInstitutionAccreditationRequest'),
  CreateInstitutionContactRequest: safe('CreateInstitutionContactRequest'),
  CreateCampusRequest: safe('CreateCampusRequest'),
  UpdateCampusRequest: safe('UpdateCampusRequest'),
  CreateSchoolRequest: safe('CreateSchoolRequest'),
  UpdateSchoolRequest: safe('UpdateSchoolRequest'),
  CreateDepartmentRequest: safe('CreateDepartmentRequest'),
  UpdateDepartmentRequest: safe('UpdateDepartmentRequest'),
  // Programs
  CreateProgramRequest: safe('CreateProgramRequest'),
  UpdateProgramRequest: safe('UpdateProgramRequest'),
  ProgramListQuery: safe('ProgramListQuery'),
  CreateProgramIntakeRequest: safe('CreateProgramIntakeRequest'),
  UpdateProgramIntakeRequest: safe('UpdateProgramIntakeRequest'),
  CreateProgramFeeRequest: safe('CreateProgramFeeRequest'),
  UpdateProgramFeeRequest: safe('UpdateProgramFeeRequest'),
  CreateProgramRequirementRequest: safe('CreateProgramRequirementRequest'),
  UpdateProgramRequirementRequest: safe('UpdateProgramRequirementRequest'),
  CreateProgramModuleRequest: safe('CreateProgramModuleRequest'),
  UpdateProgramModuleRequest: safe('UpdateProgramModuleRequest'),
  // Enrollments
  CreateEnrollmentRequest: safe('CreateEnrollmentRequest'),
  UpdateEnrollmentRequest: safe('UpdateEnrollmentRequest'),
  EnrollmentListQuery: safe('EnrollmentListQuery'),
  // Bulk
  StartImportResponse: safe('StartImportResponse'),
  ApplyImportRequest: safe('ApplyImportRequest'),
  CreateExportRequest: safe('CreateExportRequest'),
  ExportJobResponse: safe('ExportJobResponse'),
  // Users
  CreateUserRequest: safe('CreateUserRequest'),
  UpdateUserRequest: safe('UpdateUserRequest'),
  ResetPasswordRequest: safe('ResetPasswordRequest'),
  // DSAR / Consent / Breach / Sub-processors
  CreateDSARRequest: safe('CreateDSARRequest'),
  UpdateDSARRequest: safe('UpdateDSARRequest'),
  CreateConsentRequest: safe('CreateConsentRequest'),
  CreateBreachRequest: safe('CreateBreachRequest'),
  UpdateBreachRequest: safe('UpdateBreachRequest'),
  CreateSubProcessorRequest: safe('CreateSubProcessorRequest'),
  UpdateSubProcessorRequest: safe('UpdateSubProcessorRequest'),
  // Tenants (SVT-WAVE34-OPENAPI-2026-05)
  TenantSettingsResponse: safe('TenantSettingsResponse'),
  UpdateTenantSettingsRequest: safe('UpdateTenantSettingsRequest'),
  // Reminders
  CreateReminderRequest: safe('CreateReminderRequest'),
  UpdateReminderRequest: safe('UpdateReminderRequest'),
  SnoozeReminderRequest: safe('SnoozeReminderRequest'),
  // Commissions
  UpdateCommissionRequest: safe('UpdateCommissionRequest'),
  InvoiceRequest: safe('InvoiceRequest'),
  MarkPaidRequest: safe('MarkPaidRequest'),
  DisputeRequest: safe('DisputeRequest'),
  ResolveDisputeRequest: safe('ResolveDisputeRequest'),
  // Billing (Wave 3)
  CreateFeePlanRequest: safe('CreateFeePlanRequest'),
  RegeneratePlanRequest: safe('RegeneratePlanRequest'),
  PausePlanRequest: safe('PausePlanRequest'),
  ResumePlanRequest: safe('ResumePlanRequest'),
  CancelPlanRequest: safe('CancelPlanRequest'),
  RecordPaymentRequest: safe('RecordPaymentRequest'),
  ApplyAdjustmentRequest: safe('ApplyAdjustmentRequest'),
  CreateRefundRequest: safe('CreateRefundRequest'),
  CompleteRefundRequest: safe('CompleteRefundRequest'),
  // Visa types (admin CRUD catalogue)
  CreateVisaTypeRequest: safe('CreateVisaTypeRequest'),
  UpdateVisaTypeRequest: safe('UpdateVisaTypeRequest'),
  VisaTypeListQuery: safe('VisaTypeListQuery'),
  VisaTypeRow: safe('VisaTypeRow'),
  // Expiries (read-only triaged inbox)
  ExpiriesListQuery: safe('ExpiriesListQuery'),
  ExpiryRow: safe('ExpiryRow'),
  // Jobs (admin observability)
  JobRunListQuery: safe('JobRunListQuery'),
  JobRunRow: safe('JobRunRow'),
  JobRunListResponse: safe('JobRunListResponse'),
  // FSM options endpoint response
  FsmOptionsResponse: safe('FsmOptionsResponse'),
  // Domain sub-modules
  CreateTravelRequest: safe('CreateTravelRequest'),
  UpdateTravelRequest: safe('UpdateTravelRequest'),
  CreateAccommodationRequest: safe('CreateAccommodationRequest'),
  UpdateAccommodationRequest: safe('UpdateAccommodationRequest'),
  CreateInsuranceRequest: safe('CreateInsuranceRequest'),
  UpdateInsuranceRequest: safe('UpdateInsuranceRequest'),
  CreateFinanceRequest: safe('CreateFinanceRequest'),
  UpdateFinanceRequest: safe('UpdateFinanceRequest'),
  CreateComplianceRequest: safe('CreateComplianceRequest'),
  UpdateComplianceRequest: safe('UpdateComplianceRequest'),
  CreateEngagementRequest: safe('CreateEngagementRequest'),
  UpdateEngagementRequest: safe('UpdateEngagementRequest'),
  CreateEmploymentRequest: safe('CreateEmploymentRequest'),
  UpdateEmploymentRequest: safe('UpdateEmploymentRequest'),
  CreateDependentRequest: safe('CreateDependentRequest'),
  UpdateDependentRequest: safe('UpdateDependentRequest'),
  CreateSponsorRequest: safe('CreateSponsorRequest'),
  UpdateSponsorRequest: safe('UpdateSponsorRequest'),
  CreateSponsorshipRequest: safe('CreateSponsorshipRequest'),
  UpdateSponsorshipRequest: safe('UpdateSponsorshipRequest'),
  CreateContactRequest: safe('CreateContactRequest'),
  UpdateContactRequest: safe('UpdateContactRequest'),
  CreateQualificationRequest: safe('CreateQualificationRequest'),
  UpdateQualificationRequest: safe('UpdateQualificationRequest'),
  CreateLanguageTestRequest: safe('CreateLanguageTestRequest'),
  UpdateLanguageTestRequest: safe('UpdateLanguageTestRequest'),
  CreateIdentificationRequest: safe('CreateIdentificationRequest'),
  UpdateIdentificationRequest: safe('UpdateIdentificationRequest'),
  CreateVisaRequest: safe('CreateVisaRequest'),
  UpdateVisaRequest: safe('UpdateVisaRequest'),
  CreateRegulatorIdRequest: safe('CreateRegulatorIdRequest'),
  UpdateRegulatorIdRequest: safe('UpdateRegulatorIdRequest'),
  CreateAddressRequest: safe('CreateAddressRequest'),
  UpdateAddressRequest: safe('UpdateAddressRequest'),
  CreateStudentAddressRequest: safe('CreateStudentAddressRequest'),
  UpdateStudentAddressRequest: safe('UpdateStudentAddressRequest'),
  // Comms
  CreateMessageTemplateRequest: safe('CreateMessageTemplateRequest'),
  UpdateMessageTemplateRequest: safe('UpdateMessageTemplateRequest'),
  CreateMessageRequest: safe('CreateMessageRequest'),
  // Tags / Notes / Attributes / Saved-views
  CreateTagRequest: safe('CreateTagRequest'),
  UpdateTagRequest: safe('UpdateTagRequest'),
  CreateEntityTagRequest: safe('CreateEntityTagRequest'),
  CreateNoteRequest: safe('CreateNoteRequest'),
  UpdateNoteRequest: safe('UpdateNoteRequest'),
  CreateAttributeDefinitionRequest: safe('CreateAttributeDefinitionRequest'),
  UpdateAttributeDefinitionRequest: safe('UpdateAttributeDefinitionRequest'),
  CreateEntityAttributeRequest: safe('CreateEntityAttributeRequest'),
  UpdateEntityAttributeRequest: safe('UpdateEntityAttributeRequest'),
  CreateSavedViewRequest: safe('CreateSavedViewRequest'),
  UpdateSavedViewRequest: safe('UpdateSavedViewRequest'),
  // RFC 7807
  Problem: safe('ProblemDetail'),
};

// ---------------------------------------------------------------------------
// Reusable parameter + response fragments
// ---------------------------------------------------------------------------

const idParam = (name = 'id') => ({
  name,
  in: 'path' as const,
  required: true,
  schema: { type: 'string', format: 'uuid' } as OpenApiSchema,
});

const studentIdParam = idParam('studentId');

// Non-optional concrete-array type (the `Operation['parameters']` shape was
// `T[] | undefined`, which makes spreading the value a TS error even though
// the constant is obviously defined here).
const paginationParams: NonNullable<Operation['parameters']> = [
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 } },
  { name: 'cursor', in: 'query', schema: { type: 'string' } },
];

function problemRef(status: string): { $ref: string } {
  return { $ref: `#/components/responses/Problem${status}` };
}

const standardErrorResponses: Operation['responses'] = {
  '401': problemRef('401'),
  '403': problemRef('403'),
  '404': problemRef('404'),
  '422': problemRef('422'),
  '429': problemRef('429'),
  '500': problemRef('500'),
};

function ok(description: string, schemaName?: string): Operation['responses'][string] {
  return {
    description,
    content: schemaName
      ? { 'application/json': { schema: { $ref: `#/components/schemas/${schemaName}` } } }
      : { 'application/json': { schema: { type: 'object' } } },
  };
}

function noContent(): Operation['responses'][string] {
  return { description: 'No Content' };
}

function jsonBody(schemaName: string): Operation['requestBody'] {
  return {
    required: true,
    content: {
      'application/json': { schema: { $ref: `#/components/schemas/${schemaName}` } },
    },
  };
}

// ---------------------------------------------------------------------------
// Path declarations
// ---------------------------------------------------------------------------

const paths: Record<string, PathItem> = {};

function addPath(p: string, item: PathItem): void {
  paths[p] = { ...(paths[p] ?? {}), ...item };
}

// --- Auth ---
addPath('/auth/login', {
  post: {
    tags: ['Auth'],
    summary: 'Issue access + refresh tokens for credentials',
    requestBody: jsonBody('LoginRequest'),
    responses: { '200': ok('Tokens issued', 'TokenResponse'), '401': problemRef('401'), '422': problemRef('422'), '429': problemRef('429') },
  },
});
addPath('/auth/refresh', {
  post: {
    tags: ['Auth'],
    summary: 'Rotate refresh + access tokens',
    requestBody: { required: false, content: { 'application/json': { schema: { $ref: '#/components/schemas/RefreshRequest' } } } },
    responses: { '200': ok('Refreshed', 'TokenResponse'), '401': problemRef('401') },
  },
});
addPath('/auth/logout', {
  post: { tags: ['Auth'], summary: 'Revoke refresh cookie', responses: { '204': noContent() } },
});
addPath('/auth/me', {
  get: { tags: ['Auth'], summary: 'Current authenticated user', security: bearer, responses: { '200': ok('Current user', 'AuthUserResponse'), '401': problemRef('401') } },
  // SVT-WAVE9-PREFS-2026-05 — self-service preferences update (locale, timezone, etc).
  patch: {
    tags: ['Auth'],
    summary: 'Update own preferences (locale / timezone / notification toggles)',
    security: bearer,
    requestBody: jsonBody('UpdateMyPreferencesRequest'),
    responses: { '200': ok('Updated', 'AuthUserResponse'), ...standardErrorResponses },
  },
});
addPath('/auth/change-password', {
  post: { tags: ['Auth'], summary: 'Change own password', security: bearer, requestBody: jsonBody('ChangePasswordRequest'), responses: { '204': noContent(), ...standardErrorResponses } },
});
addPath('/auth/password/reset-request', {
  post: {
    tags: ['Auth'],
    summary: 'Request a self-service password reset link (always 200; anti-enumeration)',
    requestBody: jsonBody('RequestPasswordResetRequest'),
    responses: { '200': ok('Reset link sent if account exists'), ...standardErrorResponses },
  },
});
addPath('/auth/password/reset-confirm', {
  post: {
    tags: ['Auth'],
    summary: 'Confirm reset with token + new password (single-use, 30-min TTL)',
    requestBody: jsonBody('ConfirmPasswordResetRequest'),
    responses: { '204': noContent(), ...standardErrorResponses },
  },
});
// SVT-SEC-2026-05 — MFA enrol/verify/disable.
addPath('/auth/mfa/setup', {
  post: {
    tags: ['Auth'],
    summary: 'Start MFA enrolment (returns otpauth_url + Base32 secret)',
    security: bearer,
    responses: { '200': ok('PENDING_VERIFICATION'), ...standardErrorResponses },
  },
});
addPath('/auth/mfa/verify', {
  post: {
    tags: ['Auth'],
    summary: 'Verify TOTP code + enable MFA + return one-time recovery codes',
    security: bearer,
    requestBody: jsonBody('VerifyMfaRequest'),
    responses: { '200': ok('Enabled + recovery codes'), ...standardErrorResponses },
  },
});
addPath('/auth/mfa/disable', {
  post: {
    tags: ['Auth'],
    summary: 'Disable MFA (requires re-entering current password — step-up auth)',
    security: bearer,
    requestBody: jsonBody('DisableMfaRequest'),
    responses: { '204': noContent(), ...standardErrorResponses },
  },
});

// --- Students ---
addPath('/students', {
  get: { tags: ['Students'], summary: 'List students', security: bearer, parameters: paginationParams, responses: { '200': ok('Page of students'), ...standardErrorResponses } },
  post: { tags: ['Students'], summary: 'Create student', security: bearer, requestBody: jsonBody('CreateStudentRequest'), responses: { '201': ok('Created'), ...standardErrorResponses } },
});
addPath('/students/{id}', {
  get: { tags: ['Students'], summary: 'Get student', security: bearer, parameters: [idParam()], responses: { '200': ok('Student'), ...standardErrorResponses } },
  patch: { tags: ['Students'], summary: 'Update student', security: bearer, parameters: [idParam()], requestBody: jsonBody('UpdateStudentRequest'), responses: { '200': ok('Updated'), ...standardErrorResponses } },
  delete: { tags: ['Students'], summary: 'Soft-delete student', security: bearer, parameters: [idParam()], responses: { '204': noContent(), ...standardErrorResponses } },
});
addPath('/students/{id}/transitions', {
  post: { tags: ['Students'], summary: 'Advance student stage', security: bearer, parameters: [idParam()], requestBody: jsonBody('AdvanceStageRequest'), responses: { '201': ok('Transition recorded'), ...standardErrorResponses } },
});
addPath('/students/{id}/timeline', {
  get: { tags: ['Students'], summary: 'Audit timeline for student', security: bearer, parameters: [idParam(), ...paginationParams], responses: { '200': ok('Timeline events'), ...standardErrorResponses } },
});

// --- Stages ---
addPath('/stages', {
  get: { tags: ['Stages'], summary: 'List lifecycle stages', security: bearer, responses: { '200': ok('Stages'), ...standardErrorResponses } },
  post: { tags: ['Stages'], summary: 'Create stage', security: bearer, requestBody: jsonBody('CreateStageRequest'), responses: { '201': ok('Created'), ...standardErrorResponses } },
});
addPath('/stages/{id}', {
  patch: { tags: ['Stages'], summary: 'Update stage', security: bearer, parameters: [idParam()], requestBody: jsonBody('UpdateStageRequest'), responses: { '200': ok('Updated'), ...standardErrorResponses } },
  delete: { tags: ['Stages'], summary: 'Delete stage', security: bearer, parameters: [idParam()], responses: { '204': noContent(), ...standardErrorResponses } },
});
addPath('/stages/transitions', {
  post: { tags: ['Stages'], summary: 'Define an allowed stage transition', security: bearer, requestBody: jsonBody('CreateTransitionRequest'), responses: { '201': ok('Created'), ...standardErrorResponses } },
});
addPath('/stages/reorder', {
  post: { tags: ['Stages'], summary: 'Reorder stages in bulk', security: bearer, requestBody: jsonBody('ReorderStagesRequest'), responses: { '200': ok('Reordered'), ...standardErrorResponses } },
});

// --- Lookups ---
for (const r of ['countries', 'currencies', 'document-types', 'relationship-types', 'visa-categories', 'isced-fields']) {
  addPath(`/lookups/${r}`, {
    get: { tags: ['Lookups'], summary: `List ${r}`, security: bearer, responses: { '200': ok(`${r} list`), ...standardErrorResponses } },
  });
}

// --- Institutions / Programs / Enrollments ---
addPath('/institutions', {
  get: { tags: ['Institutions'], summary: 'List institutions', security: bearer, parameters: paginationParams, responses: { '200': ok('Institutions'), ...standardErrorResponses } },
  post: { tags: ['Institutions'], summary: 'Create institution', security: bearer, requestBody: jsonBody('CreateInstitutionRequest'), responses: { '201': ok('Created'), ...standardErrorResponses } },
});
addPath('/institutions/{id}', {
  get: { tags: ['Institutions'], summary: 'Get institution', security: bearer, parameters: [idParam()], responses: { '200': ok('Institution'), ...standardErrorResponses } },
  patch: { tags: ['Institutions'], summary: 'Update institution', security: bearer, parameters: [idParam()], requestBody: jsonBody('UpdateInstitutionRequest'), responses: { '200': ok('Updated'), ...standardErrorResponses } },
  delete: { tags: ['Institutions'], summary: 'Soft-delete institution', security: bearer, parameters: [idParam()], responses: { '204': noContent(), ...standardErrorResponses } },
});
addPath('/programs', {
  get: { tags: ['Programs'], summary: 'List programs', security: bearer, parameters: paginationParams, responses: { '200': ok('Programs'), ...standardErrorResponses } },
  post: { tags: ['Programs'], summary: 'Create program', security: bearer, requestBody: jsonBody('CreateProgramRequest'), responses: { '201': ok('Created'), ...standardErrorResponses } },
});
addPath('/programs/{id}', {
  get: { tags: ['Programs'], summary: 'Get program', security: bearer, parameters: [idParam()], responses: { '200': ok('Program'), ...standardErrorResponses } },
  patch: { tags: ['Programs'], summary: 'Update program', security: bearer, parameters: [idParam()], requestBody: jsonBody('UpdateProgramRequest'), responses: { '200': ok('Updated'), ...standardErrorResponses } },
  delete: { tags: ['Programs'], summary: 'Soft-delete program', security: bearer, parameters: [idParam()], responses: { '204': noContent(), ...standardErrorResponses } },
});
addPath('/enrollments', {
  get: { tags: ['Enrollments'], summary: 'List enrollments', security: bearer, parameters: paginationParams, responses: { '200': ok('Enrollments'), ...standardErrorResponses } },
  post: { tags: ['Enrollments'], summary: 'Create enrollment', security: bearer, requestBody: jsonBody('CreateEnrollmentRequest'), responses: { '201': ok('Created'), ...standardErrorResponses } },
});
addPath('/enrollments/{id}', {
  get: { tags: ['Enrollments'], summary: 'Get enrollment', security: bearer, parameters: [idParam()], responses: { '200': ok('Enrollment'), ...standardErrorResponses } },
  // SVT-WAVE-OCC-REQUIRED-2026-05 — If-Match is REQUIRED on enrollment PATCH
  // (mirrors the lost-update protection on /students/{id}). 428 when missing,
  // 412 when stale.
  patch: {
    tags: ['Enrollments'],
    summary: 'Update enrollment (requires If-Match header for optimistic concurrency)',
    security: bearer,
    parameters: [
      idParam(),
      {
        name: 'If-Match',
        in: 'header',
        required: true,
        schema: { type: 'string' },
        description: 'Numeric version (e.g. "3") from the previous ETag. Missing → 428; stale → 412.',
      },
    ],
    requestBody: jsonBody('UpdateEnrollmentRequest'),
    responses: { '200': ok('Updated'), ...standardErrorResponses },
  },
});

// --- Imports / Exports ---
const resourceParam = { name: 'resource', in: 'path' as const, required: true, schema: { type: 'string', enum: ['students', 'institutions', 'programs', 'enrollments', 'program_fees'] } as OpenApiSchema };
addPath('/imports/{resource}/schema', {
  get: { tags: ['Imports'], summary: 'JSON schema for the importable resource', security: bearer, parameters: [resourceParam], responses: { '200': ok('Schema'), ...standardErrorResponses } },
});
addPath('/imports/{resource}/template.csv', {
  get: { tags: ['Imports'], summary: 'CSV header template for the resource', security: bearer, parameters: [resourceParam], responses: { '200': { description: 'CSV template', content: { 'text/csv': { schema: { type: 'string' } } } }, ...standardErrorResponses } },
});
addPath('/imports/{resource}', {
  post: {
    tags: ['Imports'],
    summary: 'Upload an import file (multipart). See TODO_GAPS — body is binary.',
    security: bearer,
    parameters: [resourceParam],
    requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } }, required: ['file'] } } } },
    responses: { '202': ok('Job started', 'StartImportResponse'), ...standardErrorResponses },
  },
});
addPath('/imports/{job_id}', {
  get: { tags: ['Imports'], summary: 'Get import job status', security: bearer, parameters: [idParam('job_id')], responses: { '200': ok('Job'), ...standardErrorResponses } },
});
addPath('/imports/{job_id}/report', {
  get: { tags: ['Imports'], summary: 'Get the dry-run validation report', security: bearer, parameters: [idParam('job_id')], responses: { '200': ok('Report'), ...standardErrorResponses } },
});
addPath('/imports/{job_id}/apply', {
  post: { tags: ['Imports'], summary: 'Apply an import after dry-run review (idempotent)', security: bearer, parameters: [idParam('job_id'), { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } }], requestBody: jsonBody('ApplyImportRequest'), responses: { '202': ok('Applying'), ...standardErrorResponses } },
});
addPath('/exports', {
  get: { tags: ['Exports'], summary: 'List export jobs', security: bearer, parameters: paginationParams, responses: { '200': ok('Jobs'), ...standardErrorResponses } },
  post: { tags: ['Exports'], summary: 'Enqueue an export job', security: bearer, requestBody: jsonBody('CreateExportRequest'), responses: { '202': ok('Queued', 'ExportJobResponse'), ...standardErrorResponses } },
});

// --- Dashboard ---
addPath('/dashboard/summary', {
  get: { tags: ['Dashboard'], summary: 'Dashboard summary counts', security: bearer, responses: { '200': ok('Summary'), ...standardErrorResponses } },
});
// SVT-WAVE-BILLING-DASHBOARD-2026-05 — finance KPIs (role-scoped).
addPath('/dashboard/finance-summary', {
  get: { tags: ['Dashboard', 'Billing'], summary: 'Outstanding + overdue + 30d collections/refunds + active plans (ADMIN tenant-wide; COUNSELLOR own caseload)', security: bearer, responses: { '200': ok('Finance KPIs'), ...standardErrorResponses } },
});
addPath('/dashboard/expiries', {
  get: { tags: ['Dashboard'], summary: 'Upcoming expiry alerts (visa, passport, insurance)', security: bearer, parameters: [{ name: 'within_days', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 365, default: 60 } }], responses: { '200': ok('Expiries'), ...standardErrorResponses } },
});
// SVT-WAVE33-SLA-2026-05 + SVT-WAVE49-SLA-SEVERITY-2026-05
addPath('/dashboard/sla-breaches', {
  get: {
    tags: ['Dashboard'],
    summary: 'Students past their stage SLA (worst first)',
    security: bearer,
    parameters: [
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
      {
        name: 'min_hours_over',
        in: 'query',
        schema: { type: 'number', minimum: 0, maximum: 8760, default: 0 },
        description: 'Filter to breaches at least N hours past SLA (e.g. 24 for critical-only).',
      },
    ],
    responses: { '200': ok('SLA breaches'), ...standardErrorResponses },
  },
});

// --- Users ---
addPath('/users', {
  get: { tags: ['Users'], summary: 'List users', security: bearer, parameters: paginationParams, responses: { '200': ok('Users'), ...standardErrorResponses } },
  post: { tags: ['Users'], summary: 'Create user', security: bearer, requestBody: jsonBody('CreateUserRequest'), responses: { '201': ok('Created'), ...standardErrorResponses } },
});
addPath('/users/{id}', {
  get: { tags: ['Users'], summary: 'Get user', security: bearer, parameters: [idParam()], responses: { '200': ok('User'), ...standardErrorResponses } },
  patch: { tags: ['Users'], summary: 'Update user', security: bearer, parameters: [idParam()], requestBody: jsonBody('UpdateUserRequest'), responses: { '200': ok('Updated'), ...standardErrorResponses } },
  delete: { tags: ['Users'], summary: 'Deactivate user', security: bearer, parameters: [idParam()], responses: { '204': noContent(), ...standardErrorResponses } },
});

// --- Documents ---
addPath('/documents/{id}/download', {
  get: { tags: ['Documents'], summary: 'Download document (binary; see TODO_GAPS)', security: bearer, parameters: [idParam()], responses: { '200': { description: 'Binary stream', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, ...standardErrorResponses } },
});
addPath('/documents/{id}/verification', {
  post: { tags: ['Documents'], summary: 'Mark document verification status', security: bearer, parameters: [idParam()], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { verified: { type: 'boolean' }, notes: { type: 'string' } }, required: ['verified'] } } } }, responses: { '200': ok('Updated'), ...standardErrorResponses } },
});

// --- DSAR / Consent / Breach ---
addPath('/dsar', {
  get: { tags: ['Privacy'], summary: 'List DSAR requests', security: bearer, parameters: paginationParams, responses: { '200': ok('DSAR list'), ...standardErrorResponses } },
  post: { tags: ['Privacy'], summary: 'Create a DSAR request', security: bearer, requestBody: jsonBody('CreateDSARRequest'), responses: { '201': ok('Created'), ...standardErrorResponses } },
});
// SVT-WAVE37-DSAR-DASH-2026-05
addPath('/dsar/dashboard-summary', {
  get: {
    tags: ['Privacy', 'Dashboard'],
    summary: 'Admin-only counts of open / overdue / due-within-3d DSAR requests',
    security: bearer,
    responses: { '200': ok('DSAR dashboard summary'), ...standardErrorResponses },
  },
});
addPath('/consents', {
  get: { tags: ['Privacy'], summary: 'List consents', security: bearer, parameters: paginationParams, responses: { '200': ok('Consents'), ...standardErrorResponses } },
  post: { tags: ['Privacy'], summary: 'Record a consent grant/withdrawal', security: bearer, requestBody: jsonBody('CreateConsentRequest'), responses: { '201': ok('Created'), ...standardErrorResponses } },
});
addPath('/breach-incidents', {
  get: { tags: ['Privacy'], summary: 'List breach incidents', security: bearer, parameters: paginationParams, responses: { '200': ok('Breach incidents'), ...standardErrorResponses } },
  post: { tags: ['Privacy'], summary: 'Record a breach incident', security: bearer, requestBody: jsonBody('CreateBreachRequest'), responses: { '201': ok('Created'), ...standardErrorResponses } },
});
// SVT-WAVE36-BREACH-DASH-2026-05
addPath('/breach-incidents/dashboard-summary', {
  get: {
    tags: ['Privacy', 'Dashboard'],
    summary: 'Admin-only counts of open / overdue / due-within-24h breaches',
    security: bearer,
    responses: { '200': ok('Breach dashboard summary'), ...standardErrorResponses },
  },
});

// --- Billing (Wave 3) — gated by Tenant.billing_enabled (404 when off). ---
// SVT-WAVE-BILLING-2026-05 — fee plan lifecycle + outstanding aggregate.
addPath('/billing/plans', {
  get: {
    tags: ['Billing'],
    summary: 'List fee plans (filter by enrollment_id, student_id, status)',
    security: bearer,
    parameters: paginationParams,
    responses: { '200': ok('Fee plans'), ...standardErrorResponses },
  },
  post: {
    tags: ['Billing'],
    summary: 'Create a fee plan for an enrollment (idempotent via Idempotency-Key)',
    security: bearer,
    requestBody: jsonBody('CreateFeePlanRequest'),
    responses: { '201': ok('Created'), ...standardErrorResponses },
  },
});
addPath('/billing/plans/{id}', {
  get: {
    tags: ['Billing'],
    summary: 'Get fee plan + installments',
    security: bearer,
    parameters: [idParam()],
    responses: { '200': ok('Fee plan'), ...standardErrorResponses },
  },
});
addPath('/billing/plans/{id}/pause', {
  post: {
    tags: ['Billing'],
    summary: 'Pause plan (ON_LEAVE flow) — suspends SCHEDULED/INVOICED installments',
    security: bearer,
    parameters: [idParam()],
    requestBody: jsonBody('PausePlanRequest'),
    responses: { '200': ok('Paused'), ...standardErrorResponses },
  },
});
addPath('/billing/plans/{id}/resume', {
  post: {
    tags: ['Billing'],
    summary: 'Resume paused plan — optionally shifts remaining due dates',
    security: bearer,
    parameters: [idParam()],
    requestBody: jsonBody('ResumePlanRequest'),
    responses: { '200': ok('Resumed'), ...standardErrorResponses },
  },
});
addPath('/billing/plans/{id}/cancel', {
  post: {
    tags: ['Billing'],
    summary: 'Cancel plan (ADMIN) — terminates non-paid installments',
    security: bearer,
    parameters: [idParam()],
    requestBody: jsonBody('CancelPlanRequest'),
    responses: { '200': ok('Cancelled'), ...standardErrorResponses },
  },
});
addPath('/billing/plans/{id}/regenerate', {
  post: {
    tags: ['Billing'],
    summary: 'Regenerate plan (ADMIN) — supersedes prior plan; idempotent',
    security: bearer,
    parameters: [idParam()],
    requestBody: jsonBody('RegeneratePlanRequest'),
    responses: { '201': ok('Regenerated'), ...standardErrorResponses },
  },
});
addPath('/billing/outstanding', {
  get: {
    tags: ['Billing'],
    summary: 'Outstanding balance aggregate (by student or enrollment)',
    security: bearer,
    parameters: [
      { name: 'student_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
      { name: 'enrollment_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
    ],
    responses: { '200': ok('Outstanding'), ...standardErrorResponses },
  },
});

// --- Billing (Wave 4) — Payments + Refunds + Adjustments ----------------
addPath('/billing/payments', {
  get: {
    tags: ['Billing'],
    summary: 'List payments (student/enrollment/status/date filter)',
    security: bearer,
    parameters: paginationParams,
    responses: { '200': ok('Payments'), ...standardErrorResponses },
  },
  post: {
    tags: ['Billing'],
    summary: 'Record a payment (FIFO or explicit allocations; idempotent via Idempotency-Key)',
    security: bearer,
    requestBody: jsonBody('RecordPaymentRequest'),
    responses: { '201': ok('Recorded'), ...standardErrorResponses },
  },
});
addPath('/billing/payments/{id}', {
  get: {
    tags: ['Billing'],
    summary: 'Get payment + allocations + refunds',
    security: bearer,
    parameters: [idParam()],
    responses: { '200': ok('Payment'), ...standardErrorResponses },
  },
});
addPath('/billing/payments/{id}/void', {
  post: {
    tags: ['Billing'],
    summary: 'Void a payment (ADMIN) — reverses allocations',
    security: bearer,
    parameters: [idParam()],
    requestBody: jsonBody('VoidPaymentRequest'),
    responses: { '200': ok('Voided'), ...standardErrorResponses },
  },
});
addPath('/billing/payments/{id}/refunds', {
  post: {
    tags: ['Billing'],
    summary: 'Create refund (ADMIN; PENDING; idempotent)',
    security: bearer,
    parameters: [idParam()],
    requestBody: jsonBody('CreateRefundRequest'),
    responses: { '201': ok('Refund created'), ...standardErrorResponses },
  },
});
addPath('/billing/refunds/{id}/complete', {
  post: {
    tags: ['Billing'],
    summary: 'Complete a PENDING refund (ADMIN) — reverses allocations + credit carryforward',
    security: bearer,
    parameters: [idParam()],
    requestBody: jsonBody('CompleteRefundRequest'),
    responses: { '200': ok('Refunded'), ...standardErrorResponses },
  },
});
addPath('/billing/refunds/{id}/fail', {
  post: {
    tags: ['Billing'],
    summary: 'Mark a PENDING refund FAILED (ADMIN) — payment-gateway / bank-rail failure',
    security: bearer,
    parameters: [idParam()],
    requestBody: jsonBody('FailRefundRequest'),
    responses: { '200': ok('Failed'), ...standardErrorResponses },
  },
});
// --- Admin / Privacy: GDPR Art. 30 Records of Processing Activities ------
addPath('/admin/ropa', {
  get: {
    tags: ['Privacy'],
    summary: 'Records of Processing Activities (GDPR Art. 30) — JSON',
    description:
      'Aggregates the static processing-activity catalogue, the per-tenant sub-processor register (Art 28(2)), and operational evidence (DSAR + consent counts). ADMIN-only; access audited.',
    security: bearer,
    responses: { '200': ok('ROPA'), ...standardErrorResponses },
  },
});
addPath('/admin/ropa.csv', {
  get: {
    tags: ['Privacy'],
    summary: 'ROPA — CSV download (regulator handoff format)',
    security: bearer,
    responses: {
      '200': {
        description: 'CSV (UTF-8 with BOM)',
        content: { 'text/csv': { schema: { type: 'string' } } },
      },
      ...standardErrorResponses,
    },
  },
});

addPath('/billing/installments/{id}/adjustments', {
  post: {
    tags: ['Billing'],
    summary: 'Apply adjustment (LATE_FEE / DISCOUNT / SCHOLARSHIP / WAIVER / WRITE_OFF)',
    security: bearer,
    parameters: [idParam()],
    requestBody: jsonBody('ApplyAdjustmentRequest'),
    responses: { '201': ok('Adjustment applied'), ...standardErrorResponses },
  },
});

// --- Comms threads / inbox / tenants ---
// SVT-WAVE34-OPENAPI-2026-05 — register endpoints added in waves 17, 19, 20, 32.
addPath('/comms/threads', {
  get: {
    tags: ['Comms'],
    summary: 'List comms threads (tenant-wide)',
    security: bearer,
    parameters: [
      { name: 'channel', in: 'query', schema: { type: 'string', enum: ['EMAIL', 'SMS', 'WHATSAPP', 'IN_APP'] } },
      { name: 'student_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
      { name: 'q', in: 'query', schema: { type: 'string', maxLength: 80 }, description: 'Subject or student name substring (case-insensitive)' },
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
    ],
    responses: { '200': ok('Threads'), ...standardErrorResponses },
  },
});
addPath('/comms/threads/{id}', {
  get: {
    tags: ['Comms'],
    summary: 'Get thread + messages (auto-marks recipient rows as read)',
    security: bearer,
    parameters: [idParam()],
    responses: { '200': ok('Thread'), ...standardErrorResponses },
  },
});
addPath('/inbox/messages', {
  get: {
    tags: ['Comms'],
    summary: 'Authenticated user inbox (IN_APP outbound notifications)',
    security: bearer,
    parameters: [
      { name: 'unread', in: 'query', schema: { type: 'boolean' } },
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
    ],
    responses: { '200': ok('Inbox'), ...standardErrorResponses },
  },
});
addPath('/inbox/messages/{id}/read', {
  post: {
    tags: ['Comms'],
    summary: 'Mark a single inbox message as read',
    security: bearer,
    parameters: [idParam()],
    responses: { '204': noContent(), ...standardErrorResponses },
  },
});
addPath('/inbox/messages/read-all', {
  post: {
    tags: ['Comms'],
    summary: 'Mark all unread inbox messages as read (returns updated count)',
    security: bearer,
    responses: { '200': ok('Bulk count'), ...standardErrorResponses },
  },
});
addPath('/tenants/me', {
  get: {
    tags: ['Tenants'],
    summary: 'Get the caller tenant settings',
    security: bearer,
    responses: { '200': ok('Tenant'), ...standardErrorResponses },
  },
  patch: {
    tags: ['Tenants'],
    summary: 'Update tenant settings (admin only)',
    security: bearer,
    requestBody: jsonBody('UpdateTenantSettingsRequest'),
    responses: { '200': ok('Updated'), ...standardErrorResponses },
  },
});

// ---------------------------------------------------------------------------
// Extended path declarations — generated to keep the spec in step with app.ts.
// Each helper below assumes the standard error envelope and bearer security.
// ---------------------------------------------------------------------------

// Helper: build a list/create pair on a flat collection.
function flatCollection(
  path: string,
  tag: string,
  opts: {
    summary: string;
    listSummary?: string;
    createSummary?: string;
    createSchema?: string;
  },
): void {
  const item: PathItem = {
    get: {
      tags: [tag],
      summary: opts.listSummary ?? `List ${opts.summary}`,
      security: bearer,
      parameters: paginationParams,
      responses: { '200': ok(`${opts.summary} page`), ...standardErrorResponses },
    },
  };
  if (opts.createSchema) {
    item.post = {
      tags: [tag],
      summary: opts.createSummary ?? `Create ${opts.summary.replace(/s$/, '')}`,
      security: bearer,
      requestBody: jsonBody(opts.createSchema),
      responses: { '201': ok('Created'), ...standardErrorResponses },
    };
  }
  addPath(path, item);
}

// Helper: build a get/patch/delete trio on an item by id.
function itemRoutes(
  path: string,
  tag: string,
  opts: {
    summary: string;
    updateSchema?: string;
    includeGet?: boolean;
    includeDelete?: boolean;
    paramName?: string;
  },
): void {
  const param = idParam(opts.paramName ?? 'id');
  const item: PathItem = {};
  if (opts.includeGet ?? true) {
    item.get = {
      tags: [tag],
      summary: `Get ${opts.summary}`,
      security: bearer,
      parameters: [param],
      responses: { '200': ok(opts.summary), ...standardErrorResponses },
    };
  }
  if (opts.updateSchema) {
    item.patch = {
      tags: [tag],
      summary: `Update ${opts.summary}`,
      security: bearer,
      parameters: [param],
      requestBody: jsonBody(opts.updateSchema),
      responses: { '200': ok('Updated'), ...standardErrorResponses },
    };
  }
  if (opts.includeDelete ?? true) {
    item.delete = {
      tags: [tag],
      summary: `Delete ${opts.summary}`,
      security: bearer,
      parameters: [param],
      responses: { '204': noContent(), ...standardErrorResponses },
    };
  }
  addPath(path, item);
}

// Helper: nested-under-student list/create pair.
function studentNested(
  path: string,
  tag: string,
  opts: { summary: string; createSchema?: string },
): void {
  const item: PathItem = {
    get: {
      tags: [tag],
      summary: `List student ${opts.summary}`,
      security: bearer,
      parameters: [studentIdParam, ...paginationParams],
      responses: { '200': ok(`${opts.summary} page`), ...standardErrorResponses },
    },
  };
  if (opts.createSchema) {
    item.post = {
      tags: [tag],
      summary: `Add ${opts.summary.replace(/s$/, '')} for student`,
      security: bearer,
      parameters: [studentIdParam],
      requestBody: jsonBody(opts.createSchema),
      responses: { '201': ok('Created'), ...standardErrorResponses },
    };
  }
  addPath(path, item);
}

// --- Stages: extra endpoints already-not-covered ---
addPath('/stages/transitions/{id}', {
  delete: {
    tags: ['Stages'],
    summary: 'Delete a stage transition',
    security: bearer,
    parameters: [idParam()],
    responses: { '204': noContent(), ...standardErrorResponses },
  },
});
addPath('/stages/preview-impact', {
  post: {
    tags: ['Stages'],
    summary: 'Preview the impact of a stage change',
    security: bearer,
    requestBody: jsonBody('PreviewImpactRequest'),
    responses: { '200': ok('Impact preview'), ...standardErrorResponses },
  },
});

// --- Lookups: airports + airlines (global catalogs) ---
for (const r of ['airports', 'airlines']) {
  addPath(`/lookups/${r}`, {
    get: {
      tags: ['Lookups'],
      summary: `List ${r}`,
      security: bearer,
      responses: { '200': ok(`${r} list`), ...standardErrorResponses },
    },
  });
}

// --- Institutions: nested sub-resources ---
addPath('/institutions/{id}/identifiers', {
  get: { tags: ['Institutions'], summary: 'List institution identifiers', security: bearer, parameters: [idParam()], responses: { '200': ok('Identifiers'), ...standardErrorResponses } },
  post: { tags: ['Institutions'], summary: 'Create institution identifier', security: bearer, parameters: [idParam()], requestBody: jsonBody('CreateInstitutionIdentifierRequest'), responses: { '201': ok('Created'), ...standardErrorResponses } },
});
addPath('/institutions/identifiers/{id}', {
  delete: { tags: ['Institutions'], summary: 'Delete identifier', security: bearer, parameters: [idParam()], responses: { '204': noContent(), ...standardErrorResponses } },
});
addPath('/institutions/{id}/accreditations', {
  get: { tags: ['Institutions'], summary: 'List institution accreditations', security: bearer, parameters: [idParam()], responses: { '200': ok('Accreditations'), ...standardErrorResponses } },
  post: { tags: ['Institutions'], summary: 'Create accreditation', security: bearer, parameters: [idParam()], requestBody: jsonBody('CreateInstitutionAccreditationRequest'), responses: { '201': ok('Created'), ...standardErrorResponses } },
});
addPath('/institutions/accreditations/{id}', {
  delete: { tags: ['Institutions'], summary: 'Delete accreditation', security: bearer, parameters: [idParam()], responses: { '204': noContent(), ...standardErrorResponses } },
});
addPath('/institutions/{id}/contacts', {
  get: { tags: ['Institutions'], summary: 'List institution contacts', security: bearer, parameters: [idParam()], responses: { '200': ok('Contacts'), ...standardErrorResponses } },
  post: { tags: ['Institutions'], summary: 'Create institution contact', security: bearer, parameters: [idParam()], requestBody: jsonBody('CreateInstitutionContactRequest'), responses: { '201': ok('Created'), ...standardErrorResponses } },
});
addPath('/institutions/contacts/{id}', {
  delete: { tags: ['Institutions'], summary: 'Delete contact', security: bearer, parameters: [idParam()], responses: { '204': noContent(), ...standardErrorResponses } },
});
addPath('/institutions/{id}/campuses', {
  get: { tags: ['Institutions'], summary: 'List institution campuses', security: bearer, parameters: [idParam()], responses: { '200': ok('Campuses'), ...standardErrorResponses } },
  post: { tags: ['Institutions'], summary: 'Create campus', security: bearer, parameters: [idParam()], requestBody: jsonBody('CreateCampusRequest'), responses: { '201': ok('Created'), ...standardErrorResponses } },
});
addPath('/institutions/campuses/{id}', {
  patch: { tags: ['Institutions'], summary: 'Update campus', security: bearer, parameters: [idParam()], requestBody: jsonBody('UpdateCampusRequest'), responses: { '200': ok('Updated'), ...standardErrorResponses } },
  delete: { tags: ['Institutions'], summary: 'Delete campus', security: bearer, parameters: [idParam()], responses: { '204': noContent(), ...standardErrorResponses } },
});
addPath('/institutions/{id}/schools', {
  get: { tags: ['Institutions'], summary: 'List schools', security: bearer, parameters: [idParam()], responses: { '200': ok('Schools'), ...standardErrorResponses } },
  post: { tags: ['Institutions'], summary: 'Create school', security: bearer, parameters: [idParam()], requestBody: jsonBody('CreateSchoolRequest'), responses: { '201': ok('Created'), ...standardErrorResponses } },
});
addPath('/institutions/schools/{id}', {
  patch: { tags: ['Institutions'], summary: 'Update school', security: bearer, parameters: [idParam()], requestBody: jsonBody('UpdateSchoolRequest'), responses: { '200': ok('Updated'), ...standardErrorResponses } },
  delete: { tags: ['Institutions'], summary: 'Delete school', security: bearer, parameters: [idParam()], responses: { '204': noContent(), ...standardErrorResponses } },
});
addPath('/institutions/schools/{id}/departments', {
  post: { tags: ['Institutions'], summary: 'Create department under school', security: bearer, parameters: [idParam()], requestBody: jsonBody('CreateDepartmentRequest'), responses: { '201': ok('Created'), ...standardErrorResponses } },
});
addPath('/institutions/departments/{id}', {
  patch: { tags: ['Institutions'], summary: 'Update department', security: bearer, parameters: [idParam()], requestBody: jsonBody('UpdateDepartmentRequest'), responses: { '200': ok('Updated'), ...standardErrorResponses } },
  delete: { tags: ['Institutions'], summary: 'Delete department', security: bearer, parameters: [idParam()], responses: { '204': noContent(), ...standardErrorResponses } },
});

// --- Programs: nested sub-resources (intakes / fees / requirements / modules) ---
addPath('/programs/{id}/intakes', {
  get: { tags: ['Programs'], summary: 'List program intakes', security: bearer, parameters: [idParam()], responses: { '200': ok('Intakes'), ...standardErrorResponses } },
  post: { tags: ['Programs'], summary: 'Create program intake', security: bearer, parameters: [idParam()], requestBody: jsonBody('CreateProgramIntakeRequest'), responses: { '201': ok('Created'), ...standardErrorResponses } },
});
addPath('/programs/intakes/{id}', {
  patch: { tags: ['Programs'], summary: 'Update intake', security: bearer, parameters: [idParam()], requestBody: jsonBody('UpdateProgramIntakeRequest'), responses: { '200': ok('Updated'), ...standardErrorResponses } },
  delete: { tags: ['Programs'], summary: 'Delete intake', security: bearer, parameters: [idParam()], responses: { '204': noContent(), ...standardErrorResponses } },
});
addPath('/programs/intakes/{intakeId}/fees', {
  get: { tags: ['Programs'], summary: 'List fees for an intake', security: bearer, parameters: [idParam('intakeId')], responses: { '200': ok('Fees'), ...standardErrorResponses } },
  post: { tags: ['Programs'], summary: 'Create fee on an intake', security: bearer, parameters: [idParam('intakeId')], requestBody: jsonBody('CreateProgramFeeRequest'), responses: { '201': ok('Created'), ...standardErrorResponses } },
});
addPath('/programs/fees/{id}', {
  patch: { tags: ['Programs'], summary: 'Update program fee', security: bearer, parameters: [idParam()], requestBody: jsonBody('UpdateProgramFeeRequest'), responses: { '200': ok('Updated'), ...standardErrorResponses } },
  delete: { tags: ['Programs'], summary: 'Delete program fee', security: bearer, parameters: [idParam()], responses: { '204': noContent(), ...standardErrorResponses } },
});
addPath('/programs/{id}/requirements', {
  get: { tags: ['Programs'], summary: 'List program requirements', security: bearer, parameters: [idParam()], responses: { '200': ok('Requirements'), ...standardErrorResponses } },
  post: { tags: ['Programs'], summary: 'Create program requirement', security: bearer, parameters: [idParam()], requestBody: jsonBody('CreateProgramRequirementRequest'), responses: { '201': ok('Created'), ...standardErrorResponses } },
});
addPath('/programs/requirements/{id}', {
  patch: { tags: ['Programs'], summary: 'Update requirement', security: bearer, parameters: [idParam()], requestBody: jsonBody('UpdateProgramRequirementRequest'), responses: { '200': ok('Updated'), ...standardErrorResponses } },
  delete: { tags: ['Programs'], summary: 'Delete requirement', security: bearer, parameters: [idParam()], responses: { '204': noContent(), ...standardErrorResponses } },
});
addPath('/programs/{id}/modules', {
  get: { tags: ['Programs'], summary: 'List program modules', security: bearer, parameters: [idParam()], responses: { '200': ok('Modules'), ...standardErrorResponses } },
  post: { tags: ['Programs'], summary: 'Create program module', security: bearer, parameters: [idParam()], requestBody: jsonBody('CreateProgramModuleRequest'), responses: { '201': ok('Created'), ...standardErrorResponses } },
});
addPath('/programs/modules/{id}', {
  patch: { tags: ['Programs'], summary: 'Update module', security: bearer, parameters: [idParam()], requestBody: jsonBody('UpdateProgramModuleRequest'), responses: { '200': ok('Updated'), ...standardErrorResponses } },
  delete: { tags: ['Programs'], summary: 'Delete module', security: bearer, parameters: [idParam()], responses: { '204': noContent(), ...standardErrorResponses } },
});

// --- Enrollments: per-student nested ---
addPath('/students/{studentId}/enrollments', {
  get: { tags: ['Enrollments'], summary: 'List student enrollments', security: bearer, parameters: [studentIdParam, ...paginationParams], responses: { '200': ok('Enrollments'), ...standardErrorResponses } },
  post: { tags: ['Enrollments'], summary: 'Create enrollment for student', security: bearer, parameters: [studentIdParam], requestBody: jsonBody('CreateEnrollmentRequest'), responses: { '201': ok('Created'), ...standardErrorResponses } },
});
addPath('/enrollments/{id}', {
  delete: { tags: ['Enrollments'], summary: 'Soft-delete enrollment', security: bearer, parameters: [idParam()], responses: { '204': noContent(), ...standardErrorResponses } },
});

// --- Students: completeness ---
addPath('/students/{id}/completeness', {
  get: { tags: ['Students'], summary: 'Profile completeness score for student', security: bearer, parameters: [idParam()], responses: { '200': ok('Completeness'), ...standardErrorResponses } },
});

// --- Students: documents nested ---
addPath('/students/{studentId}/documents', {
  get: { tags: ['Documents'], summary: 'List student documents', security: bearer, parameters: [studentIdParam, ...paginationParams], responses: { '200': ok('Documents'), ...standardErrorResponses } },
  post: {
    tags: ['Documents'],
    summary: 'Upload a document for the student (multipart/form-data — see TODO_GAPS)',
    security: bearer,
    parameters: [studentIdParam],
    requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, document_type_id: { type: 'string', format: 'uuid' } }, required: ['file'] } } } },
    responses: { '201': ok('Created'), ...standardErrorResponses },
  },
});
addPath('/documents/{id}', {
  delete: { tags: ['Documents'], summary: 'Delete document (admin)', security: bearer, parameters: [idParam()], responses: { '204': noContent(), ...standardErrorResponses } },
});
addPath('/documents/{id}/stream', {
  get: { tags: ['Documents'], summary: 'Stream document bytes', security: bearer, parameters: [idParam()], responses: { '200': { description: 'Binary stream', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, ...standardErrorResponses } },
});

// --- Auth: discovery + change-password adjuncts ---
addPath('/auth/jwks', {
  get: { tags: ['Auth'], summary: 'JWKS keyset (public keys)', responses: { '200': ok('JWKS'), ...standardErrorResponses } },
});
addPath('/auth/.well-known/jwks.json', {
  get: { tags: ['Auth'], summary: 'JWKS keyset (RFC discovery alias)', responses: { '200': ok('JWKS'), ...standardErrorResponses } },
});

// --- Health / Version / Discovery ---
addPath('/health/livez', { get: { tags: ['Health'], summary: 'Liveness probe', responses: { '200': ok('Alive') } } });
addPath('/health/readyz', { get: { tags: ['Health'], summary: 'Readiness probe (DB ping)', responses: { '200': ok('Ready'), '503': { description: 'Not ready' } } } });
addPath('/health/version', { get: { tags: ['Health'], summary: 'App version', responses: { '200': ok('Version') } } });
addPath('/version', { get: { tags: ['Health'], summary: 'Version info (name/version/commit/node)', responses: { '200': ok('Version') } } });

// --- Users adjuncts ---
addPath('/users/{id}/reset-password', {
  post: { tags: ['Users'], summary: 'Admin: reset a user password', security: bearer, parameters: [idParam()], requestBody: jsonBody('ResetPasswordRequest'), responses: { '204': noContent(), ...standardErrorResponses } },
});
addPath('/users/{id}/sessions/revoke', {
  post: { tags: ['Users'], summary: 'Admin: revoke all sessions for a user', security: bearer, parameters: [idParam()], responses: { '204': noContent(), ...standardErrorResponses } },
});

// --- Imports / Exports adjuncts ---
addPath('/imports/{job_id}/errors.jsonl', {
  get: { tags: ['Imports'], summary: 'Stream parse/validation errors as JSONL', security: bearer, parameters: [idParam('job_id')], responses: { '200': { description: 'JSONL stream', content: { 'application/x-ndjson': { schema: { type: 'string' } } } }, ...standardErrorResponses } },
});
addPath('/imports/{job_id}/result.jsonl', {
  get: { tags: ['Imports'], summary: 'Stream import result records as JSONL', security: bearer, parameters: [idParam('job_id')], responses: { '200': { description: 'JSONL stream', content: { 'application/x-ndjson': { schema: { type: 'string' } } } }, ...standardErrorResponses } },
});
addPath('/imports/{job_id}/cancel', {
  post: { tags: ['Imports'], summary: 'Cancel an in-flight import job', security: bearer, parameters: [idParam('job_id')], responses: { '202': ok('Cancelling'), ...standardErrorResponses } },
});
addPath('/exports/{job_id}', {
  get: { tags: ['Exports'], summary: 'Get export job status', security: bearer, parameters: [idParam('job_id')], responses: { '200': ok('Job'), ...standardErrorResponses } },
});
addPath('/exports/{job_id}/download', {
  get: { tags: ['Exports'], summary: 'Download export artifact (binary)', security: bearer, parameters: [idParam('job_id')], responses: { '200': { description: 'Binary stream', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, ...standardErrorResponses } },
});
addPath('/exports/{job_id}/cancel', {
  post: { tags: ['Exports'], summary: 'Cancel an in-flight export job', security: bearer, parameters: [idParam('job_id')], responses: { '202': ok('Cancelling'), ...standardErrorResponses } },
});

// --- Reminders ---
flatCollection('/reminders', 'Reminders', { summary: 'reminders', createSchema: 'CreateReminderRequest' });
itemRoutes('/reminders/{id}', 'Reminders', { summary: 'reminder', updateSchema: 'UpdateReminderRequest' });
addPath('/reminders/{id}/acknowledge', {
  post: { tags: ['Reminders'], summary: 'Acknowledge a reminder', security: bearer, parameters: [idParam()], responses: { '200': ok('Acknowledged'), ...standardErrorResponses } },
});
addPath('/reminders/{id}/snooze', {
  post: { tags: ['Reminders'], summary: 'Snooze a reminder', security: bearer, parameters: [idParam()], requestBody: jsonBody('SnoozeReminderRequest'), responses: { '200': ok('Snoozed'), ...standardErrorResponses } },
});
addPath('/reminders/{id}/dismiss', {
  post: { tags: ['Reminders'], summary: 'Dismiss a reminder', security: bearer, parameters: [idParam()], responses: { '200': ok('Dismissed'), ...standardErrorResponses } },
});

// --- Commissions ---
addPath('/commissions', {
  get: { tags: ['Commissions'], summary: 'List commissions', security: bearer, parameters: paginationParams, responses: { '200': ok('Commissions'), ...standardErrorResponses } },
});
addPath('/commissions/summary', {
  get: { tags: ['Commissions'], summary: 'Commissions summary aggregates', security: bearer, responses: { '200': ok('Summary'), ...standardErrorResponses } },
});
addPath('/commissions/{id}', {
  get: { tags: ['Commissions'], summary: 'Get commission', security: bearer, parameters: [idParam()], responses: { '200': ok('Commission'), ...standardErrorResponses } },
  patch: { tags: ['Commissions'], summary: 'Admin update commission (corrections)', security: bearer, parameters: [idParam()], requestBody: jsonBody('UpdateCommissionRequest'), responses: { '200': ok('Updated'), ...standardErrorResponses } },
});
addPath('/commissions/{id}/claim', {
  post: { tags: ['Commissions'], summary: 'Claim a commission (state transition)', security: bearer, parameters: [idParam()], responses: { '200': ok('Claimed'), ...standardErrorResponses } },
});
addPath('/commissions/{id}/invoice', {
  post: { tags: ['Commissions'], summary: 'Issue an invoice for a commission', security: bearer, parameters: [idParam()], requestBody: jsonBody('InvoiceRequest'), responses: { '200': ok('Invoiced'), ...standardErrorResponses } },
});
addPath('/commissions/{id}/mark-paid', {
  post: { tags: ['Commissions'], summary: 'Mark a commission as paid', security: bearer, parameters: [idParam()], requestBody: jsonBody('MarkPaidRequest'), responses: { '200': ok('Marked paid'), ...standardErrorResponses } },
});
addPath('/commissions/{id}/dispute', {
  post: { tags: ['Commissions'], summary: 'Raise a dispute on a commission', security: bearer, parameters: [idParam()], requestBody: jsonBody('DisputeRequest'), responses: { '200': ok('Disputed'), ...standardErrorResponses } },
});
addPath('/commissions/{id}/waive', {
  post: { tags: ['Commissions'], summary: 'Waive a commission (admin only)', security: bearer, parameters: [idParam()], responses: { '200': ok('Waived'), ...standardErrorResponses } },
});

// --- Audit logs (admin only) ---
addPath('/audit-logs', {
  get: { tags: ['Audit'], summary: 'List audit log entries', security: bearer, parameters: paginationParams, responses: { '200': ok('Audit log page'), ...standardErrorResponses } },
});
addPath('/audit-logs/verify', {
  get: { tags: ['Audit'], summary: 'Verify audit log hash chain integrity', security: bearer, responses: { '200': ok('Verification report'), ...standardErrorResponses } },
});
addPath('/audit-logs/{id}', {
  get: { tags: ['Audit'], summary: 'Get a single audit log entry', security: bearer, parameters: [idParam()], responses: { '200': ok('Audit entry'), ...standardErrorResponses } },
});

// --- Domain sub-modules: nested under student + flat by id ---
// Travel
studentNested('/students/{studentId}/travel', 'Travel', { summary: 'travel records', createSchema: 'CreateTravelRequest' });
itemRoutes('/travel/{id}', 'Travel', { summary: 'travel record', updateSchema: 'UpdateTravelRequest' });

// Accommodations
studentNested('/students/{studentId}/accommodations', 'Accommodation', { summary: 'accommodations', createSchema: 'CreateAccommodationRequest' });
itemRoutes('/accommodations/{id}', 'Accommodation', { summary: 'accommodation', updateSchema: 'UpdateAccommodationRequest' });

// Insurances
studentNested('/students/{studentId}/insurances', 'Insurance', { summary: 'insurances', createSchema: 'CreateInsuranceRequest' });
itemRoutes('/insurances/{id}', 'Insurance', { summary: 'insurance', updateSchema: 'UpdateInsuranceRequest' });

// Finance
studentNested('/students/{studentId}/finance', 'Finance', { summary: 'finance records', createSchema: 'CreateFinanceRequest' });
itemRoutes('/finance/{id}', 'Finance', { summary: 'finance record', updateSchema: 'UpdateFinanceRequest' });

// Compliance
studentNested('/students/{studentId}/compliance', 'Compliance', { summary: 'compliance records', createSchema: 'CreateComplianceRequest' });
itemRoutes('/compliance/{id}', 'Compliance', { summary: 'compliance record', updateSchema: 'UpdateComplianceRequest' });

// Engagement
studentNested('/students/{studentId}/engagements', 'Engagement', { summary: 'engagements', createSchema: 'CreateEngagementRequest' });
itemRoutes('/engagements/{id}', 'Engagement', { summary: 'engagement', updateSchema: 'UpdateEngagementRequest' });

// Employment
studentNested('/students/{studentId}/employment', 'Employment', { summary: 'employment records', createSchema: 'CreateEmploymentRequest' });
itemRoutes('/employment/{id}', 'Employment', { summary: 'employment record', updateSchema: 'UpdateEmploymentRequest' });

// Dependents
studentNested('/students/{studentId}/dependents', 'Dependents', { summary: 'dependents', createSchema: 'CreateDependentRequest' });
itemRoutes('/dependents/{id}', 'Dependents', { summary: 'dependent', updateSchema: 'UpdateDependentRequest' });

// Sponsors / Sponsorships
flatCollection('/sponsors', 'Sponsorships', { summary: 'sponsors', createSchema: 'CreateSponsorRequest' });
itemRoutes('/sponsors/{id}', 'Sponsorships', { summary: 'sponsor', updateSchema: 'UpdateSponsorRequest' });
studentNested('/students/{studentId}/sponsorships', 'Sponsorships', { summary: 'sponsorships', createSchema: 'CreateSponsorshipRequest' });
itemRoutes('/sponsorships/{id}', 'Sponsorships', { summary: 'sponsorship', updateSchema: 'UpdateSponsorshipRequest' });

// Contacts
studentNested('/students/{studentId}/contacts', 'Contacts', { summary: 'contacts', createSchema: 'CreateContactRequest' });
itemRoutes('/contacts/{id}', 'Contacts', { summary: 'contact', updateSchema: 'UpdateContactRequest' });

// Qualifications
studentNested('/students/{studentId}/qualifications', 'Qualifications', { summary: 'qualifications', createSchema: 'CreateQualificationRequest' });
itemRoutes('/qualifications/{id}', 'Qualifications', { summary: 'qualification', updateSchema: 'UpdateQualificationRequest' });

// Language tests
studentNested('/students/{studentId}/language-tests', 'LanguageTests', { summary: 'language tests', createSchema: 'CreateLanguageTestRequest' });
itemRoutes('/language-tests/{id}', 'LanguageTests', { summary: 'language test', updateSchema: 'UpdateLanguageTestRequest' });

// Identifications
studentNested('/students/{studentId}/identifications', 'Identifications', { summary: 'identifications', createSchema: 'CreateIdentificationRequest' });
itemRoutes('/identifications/{id}', 'Identifications', { summary: 'identification', updateSchema: 'UpdateIdentificationRequest' });

// Visas
studentNested('/students/{studentId}/visas', 'Visas', { summary: 'visas', createSchema: 'CreateVisaRequest' });
itemRoutes('/visas/{id}', 'Visas', { summary: 'visa', updateSchema: 'UpdateVisaRequest' });

// Regulator IDs
studentNested('/students/{studentId}/regulator-ids', 'RegulatorIds', { summary: 'regulator IDs', createSchema: 'CreateRegulatorIdRequest' });
itemRoutes('/regulator-ids/{id}', 'RegulatorIds', { summary: 'regulator ID', updateSchema: 'UpdateRegulatorIdRequest' });

// Addresses (flat + per-student link table)
flatCollection('/addresses', 'Addresses', { summary: 'addresses', createSchema: 'CreateAddressRequest' });
itemRoutes('/addresses/{id}', 'Addresses', { summary: 'address', updateSchema: 'UpdateAddressRequest' });
addPath('/students/{studentId}/addresses', {
  get: { tags: ['Addresses'], summary: 'List student address links', security: bearer, parameters: [studentIdParam], responses: { '200': ok('Student addresses'), ...standardErrorResponses } },
  post: { tags: ['Addresses'], summary: 'Link an address to a student', security: bearer, parameters: [studentIdParam], requestBody: jsonBody('CreateStudentAddressRequest'), responses: { '201': ok('Linked'), ...standardErrorResponses } },
});
addPath('/students/{studentId}/addresses/{id}', {
  get: { tags: ['Addresses'], summary: 'Get a student-address link', security: bearer, parameters: [studentIdParam, idParam()], responses: { '200': ok('Link'), ...standardErrorResponses } },
  patch: { tags: ['Addresses'], summary: 'Update a student-address link', security: bearer, parameters: [studentIdParam, idParam()], requestBody: jsonBody('UpdateStudentAddressRequest'), responses: { '200': ok('Updated'), ...standardErrorResponses } },
  delete: { tags: ['Addresses'], summary: 'Unlink an address from a student', security: bearer, parameters: [studentIdParam, idParam()], responses: { '204': noContent(), ...standardErrorResponses } },
});

// --- Communications (templates + per-student messages) ---
flatCollection('/message-templates', 'Communications', { summary: 'message templates', createSchema: 'CreateMessageTemplateRequest' });
itemRoutes('/message-templates/{id}', 'Communications', { summary: 'message template', updateSchema: 'UpdateMessageTemplateRequest' });
addPath('/students/{studentId}/messages', {
  get: { tags: ['Communications'], summary: 'List messages sent to student', security: bearer, parameters: [studentIdParam, ...paginationParams], responses: { '200': ok('Messages'), ...standardErrorResponses } },
  post: { tags: ['Communications'], summary: 'Send a message to student', security: bearer, parameters: [studentIdParam], requestBody: jsonBody('CreateMessageRequest'), responses: { '201': ok('Queued'), ...standardErrorResponses } },
});

// --- Privacy: DSAR / Consents / Breach / Sub-processors ---
addPath('/dsar/{id}', {
  get: { tags: ['Privacy'], summary: 'Get a DSAR', security: bearer, parameters: [idParam()], responses: { '200': ok('DSAR'), ...standardErrorResponses } },
  patch: { tags: ['Privacy'], summary: 'Update DSAR', security: bearer, parameters: [idParam()], requestBody: jsonBody('UpdateDSARRequest'), responses: { '200': ok('Updated'), ...standardErrorResponses } },
});
addPath('/consents/{id}', {
  get: { tags: ['Privacy'], summary: 'Get a consent record', security: bearer, parameters: [idParam()], responses: { '200': ok('Consent'), ...standardErrorResponses } },
});
addPath('/breach-incidents/{id}', {
  get: { tags: ['Privacy'], summary: 'Get a breach incident', security: bearer, parameters: [idParam()], responses: { '200': ok('Breach incident'), ...standardErrorResponses } },
  patch: { tags: ['Privacy'], summary: 'Update breach incident', security: bearer, parameters: [idParam()], requestBody: jsonBody('UpdateBreachRequest'), responses: { '200': ok('Updated'), ...standardErrorResponses } },
  delete: { tags: ['Privacy'], summary: 'Delete breach incident', security: bearer, parameters: [idParam()], responses: { '204': noContent(), ...standardErrorResponses } },
});
flatCollection('/sub-processors', 'Privacy', { summary: 'sub-processors', createSchema: 'CreateSubProcessorRequest' });
itemRoutes('/sub-processors/{id}', 'Privacy', { summary: 'sub-processor', updateSchema: 'UpdateSubProcessorRequest' });

// --- Tags / Notes / Attributes / Saved views ---
flatCollection('/tags', 'Tags', { summary: 'tags', createSchema: 'CreateTagRequest' });
itemRoutes('/tags/{id}', 'Tags', { summary: 'tag', updateSchema: 'UpdateTagRequest' });
addPath('/entity-tags', {
  get: { tags: ['Tags'], summary: 'List entity-tag links', security: bearer, parameters: paginationParams, responses: { '200': ok('Entity-tag links'), ...standardErrorResponses } },
  post: { tags: ['Tags'], summary: 'Tag an entity', security: bearer, requestBody: jsonBody('CreateEntityTagRequest'), responses: { '201': ok('Linked'), ...standardErrorResponses } },
});
addPath('/entity-tags/{id}', {
  delete: { tags: ['Tags'], summary: 'Remove an entity-tag link', security: bearer, parameters: [idParam()], responses: { '204': noContent(), ...standardErrorResponses } },
});

flatCollection('/notes', 'Notes', { summary: 'notes', createSchema: 'CreateNoteRequest' });
itemRoutes('/notes/{id}', 'Notes', { summary: 'note', updateSchema: 'UpdateNoteRequest' });

flatCollection('/attribute-definitions', 'Attributes', { summary: 'attribute definitions', createSchema: 'CreateAttributeDefinitionRequest' });
itemRoutes('/attribute-definitions/{id}', 'Attributes', { summary: 'attribute definition', updateSchema: 'UpdateAttributeDefinitionRequest' });

flatCollection('/entity-attributes', 'Attributes', { summary: 'entity attributes', createSchema: 'CreateEntityAttributeRequest' });
itemRoutes('/entity-attributes/{id}', 'Attributes', { summary: 'entity attribute', updateSchema: 'UpdateEntityAttributeRequest' });

flatCollection('/saved-views', 'SavedViews', { summary: 'saved views', createSchema: 'CreateSavedViewRequest' });
itemRoutes('/saved-views/{id}', 'SavedViews', { summary: 'saved view', updateSchema: 'UpdateSavedViewRequest' });

// ---------------------------------------------------------------------------
// Wave-9 endpoints (added v1.0): Expiries, VisaTypes catalogue, Jobs runs,
// commission resolve-dispute, FSM options. All are mounted in app.ts behind
// `authenticate` + `tenantContext`; visa-types/jobs additionally require ADMIN.
// ---------------------------------------------------------------------------

// --- Expiries (auth: any role; read-only aggregated view) ---
addPath('/expiries', {
  get: {
    tags: ['Expiries'],
    summary: 'List expiring artefacts (visa, passport, insurance, document, regulator_id)',
    security: bearer,
    parameters: [
      {
        name: 'within_days',
        in: 'query',
        schema: { type: 'integer', minimum: 1, maximum: 365, default: 60 },
        description: 'Horizon in days for the inbox; default 60.',
      },
      {
        name: 'kind',
        in: 'query',
        schema: { type: 'string', enum: ['visa', 'passport', 'insurance', 'document', 'regulator_id'] },
        description: 'Restrict to a single source kind. Optional.',
      },
    ],
    responses: {
      '200': {
        description: 'Expiry rows (denormalised across owning modules).',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                data: { type: 'array', items: { $ref: '#/components/schemas/ExpiryRow' } },
              },
              required: ['data'],
            },
          },
        },
      },
      ...standardErrorResponses,
    },
  },
});

// --- Visa types (admin CRUD; list visible to all authenticated roles) ---
addPath('/visa-types', {
  get: {
    tags: ['VisaTypes'],
    summary: 'List visa types for the tenant',
    security: bearer,
    parameters: [
      {
        name: 'country_code',
        in: 'query',
        schema: { type: 'string', minLength: 2, maxLength: 2 },
      },
      {
        name: 'is_active',
        in: 'query',
        schema: { type: 'boolean' },
      },
    ],
    responses: {
      '200': {
        description: 'Visa types page',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                data: { type: 'array', items: { $ref: '#/components/schemas/VisaTypeRow' } },
              },
              required: ['data'],
            },
          },
        },
      },
      ...standardErrorResponses,
    },
  },
  post: {
    tags: ['VisaTypes'],
    summary: 'Create visa type (admin only)',
    security: bearer,
    requestBody: jsonBody('CreateVisaTypeRequest'),
    responses: {
      '201': ok('Created', 'VisaTypeRow'),
      ...standardErrorResponses,
    },
  },
});
addPath('/visa-types/{id}', {
  get: {
    tags: ['VisaTypes'],
    summary: 'Get visa type by id',
    security: bearer,
    parameters: [idParam()],
    responses: { '200': ok('Visa type', 'VisaTypeRow'), ...standardErrorResponses },
  },
  patch: {
    tags: ['VisaTypes'],
    summary: 'Update visa type (admin only)',
    security: bearer,
    parameters: [idParam()],
    requestBody: jsonBody('UpdateVisaTypeRequest'),
    responses: { '200': ok('Updated', 'VisaTypeRow'), ...standardErrorResponses },
  },
  delete: {
    tags: ['VisaTypes'],
    summary: 'Soft-delete visa type (admin only)',
    security: bearer,
    parameters: [idParam()],
    responses: { '204': noContent(), ...standardErrorResponses },
  },
});

// --- Jobs (admin observability; read-only by design) ---
addPath('/jobs/recent', {
  get: {
    tags: ['Jobs'],
    summary: 'Recent background-job runs (admin only)',
    security: bearer,
    parameters: [
      {
        name: 'limit',
        in: 'query',
        schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      {
        name: 'job_name',
        in: 'query',
        schema: { type: 'string', minLength: 1, maxLength: 120 },
        description: 'Optional exact-match filter, e.g. "reminder.dispatcher".',
      },
    ],
    responses: {
      '200': ok('Recent job runs', 'JobRunListResponse'),
      ...standardErrorResponses,
    },
  },
});

// --- Commissions: resolve-dispute (admin; idempotent state transition) ---
addPath('/commissions/{id}/resolve-dispute', {
  post: {
    tags: ['Commissions'],
    summary: 'Resolve a dispute (DISPUTED -> INVOICED, admin only)',
    security: bearer,
    parameters: [
      idParam(),
      { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } },
    ],
    requestBody: jsonBody('ResolveDisputeRequest'),
    responses: { '200': ok('Resolved'), '409': problemRef('409'), ...standardErrorResponses },
  },
});

// --- FSM options (live transition table for FE) ---
addPath('/fsm/{machineName}/options', {
  get: {
    tags: ['FSM'],
    summary: 'Allowed targets from a given FSM state for the caller role',
    security: bearer,
    parameters: [
      {
        name: 'machineName',
        in: 'path',
        required: true,
        schema: {
          type: 'string',
          enum: ['commission', 'enrollment', 'dsar', 'reminder', 'document', 'student'],
        },
      },
      {
        name: 'from',
        in: 'query',
        required: true,
        schema: { type: 'string' },
        description: 'Current state of the entity (must be a valid state for the machine).',
      },
    ],
    responses: {
      '200': ok('Allowed transitions for the caller role', 'FsmOptionsResponse'),
      ...standardErrorResponses,
    },
  },
});

// SVT-WAVE-REPORTS-2026-05 — admin-only analytics endpoints.
addPath('/reports/visa-funnel', {
  get: {
    tags: ['Reports'],
    summary: 'Visa-stage funnel counts (admin)',
    security: bearer,
    parameters: [
      { name: 'visa_type_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
    ],
    responses: { '200': ok('Funnel buckets'), ...standardErrorResponses },
  },
});
addPath('/reports/counsellor-load', {
  get: {
    tags: ['Reports'],
    summary: 'Active caseload + SLA breaches per counsellor (admin)',
    security: bearer,
    parameters: [
      { name: 'include_inactive_users', in: 'query', schema: { type: 'boolean', default: false } },
    ],
    responses: { '200': ok('Counsellor load rows'), ...standardErrorResponses },
  },
});
addPath('/reports/commission-revenue', {
  get: {
    tags: ['Reports'],
    summary: 'Commission revenue by month + status + currency (admin)',
    security: bearer,
    parameters: [
      { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
      { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
      { name: 'currency', in: 'query', schema: { type: 'string', minLength: 3, maxLength: 3 } },
    ],
    responses: { '200': ok('Revenue series'), ...standardErrorResponses },
  },
});
addPath('/reports/refund-rate', {
  get: {
    tags: ['Reports'],
    summary: 'Refund $ / payment $ ratio per month (admin)',
    security: bearer,
    parameters: [
      { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
      { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
    ],
    responses: { '200': ok('Refund rate series'), ...standardErrorResponses },
  },
});
addPath('/reports/outstanding-by-age', {
  get: {
    tags: ['Reports'],
    summary: 'AR-aging buckets for outstanding installments (admin)',
    security: bearer,
    parameters: [
      { name: 'currency', in: 'query', schema: { type: 'string', minLength: 3, maxLength: 3 } },
    ],
    responses: { '200': ok('Aged-AR buckets'), ...standardErrorResponses },
  },
});

// SVT-AUDIT-WORM-2026-05 — persisted Merkle roots.
addPath('/audit-logs/anchors', {
  get: {
    tags: ['Audit'],
    summary: 'List persisted hash-chain Merkle roots (admin, paged by anchored_at DESC)',
    security: bearer,
    parameters: [
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
      { name: 'cursor', in: 'query', schema: { type: 'string', format: 'date-time' } },
      { name: 'tenant_id', in: 'query', schema: { type: 'string', format: 'uuid' } },
    ],
    responses: { '200': ok('Anchors page'), ...standardErrorResponses },
  },
});

// SVT-COMPLIANCE-2026-05 — Resend bounce/complaint webhook (HMAC-signed, no auth).
addPath('/webhooks/resend', {
  post: {
    tags: ['Webhooks'],
    summary: 'Resend bounce/complaint webhook — HMAC-SHA256 via svix-signature',
    parameters: [
      { name: 'svix-id', in: 'header', required: true, schema: { type: 'string' } },
      { name: 'svix-timestamp', in: 'header', required: true, schema: { type: 'string' } },
      { name: 'svix-signature', in: 'header', required: true, schema: { type: 'string' } },
    ],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { type: 'object' } } },
    },
    responses: {
      '200': { description: 'Acknowledged' },
      '401': problemRef('401'),
    },
  },
});

// SVT-COMPLIANCE-2026-05 — One-click unsubscribe (RFC 8058).
addPath('/comms/unsubscribe', {
  get: {
    tags: ['Communications'],
    summary: 'Human landing page for one-click unsubscribe (always 200 HTML)',
    parameters: [
      { name: 'u', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } },
      { name: 't', in: 'query', required: true, schema: { type: 'string', minLength: 64, maxLength: 64 } },
    ],
    responses: { '200': { description: 'HTML', content: { 'text/html': { schema: { type: 'string' } } } } },
  },
  post: {
    tags: ['Communications'],
    summary: 'RFC 8058 One-Click unsubscribe target (form or JSON body)',
    parameters: [
      { name: 'u', in: 'query', required: false, schema: { type: 'string', format: 'uuid' } },
      { name: 't', in: 'query', required: false, schema: { type: 'string' } },
    ],
    responses: { '200': { description: 'Acknowledged (anti-enumeration; always 200)' } },
  },
});

// ---------------------------------------------------------------------------
// SVT-WAVE-OPENAPI-AUDIT-2026-05 — gap-fill for endpoints added across the
// MFA-admin / public-DSAR / public-status / onboarding /
// invoice-render waves that were never registered in this document. Pure
// path registration — no new Zod schemas are introduced.
// ---------------------------------------------------------------------------

// --- Billing: invoice rendering (.txt + .pdf) ---
addPath('/billing/plans/{id}/invoice.txt', {
  get: {
    tags: ['Billing'],
    summary: 'Render fee plan invoice as text/plain (ETag-cached; ADMIN | COUNSELLOR)',
    security: bearer,
    parameters: [
      idParam(),
      { name: 'If-None-Match', in: 'header', required: false, schema: { type: 'string' } },
    ],
    responses: {
      '200': { description: 'Invoice (plain text)', content: { 'text/plain': { schema: { type: 'string' } } } },
      '304': { description: 'Not Modified (ETag matched If-None-Match)' },
      ...standardErrorResponses,
    },
  },
});
addPath('/billing/plans/{id}/invoice.pdf', {
  get: {
    tags: ['Billing'],
    summary: 'Render fee plan invoice as application/pdf (pdf-lib; ETag-cached)',
    security: bearer,
    parameters: [
      idParam(),
      { name: 'If-None-Match', in: 'header', required: false, schema: { type: 'string' } },
    ],
    responses: {
      '200': {
        description: 'Invoice PDF (binary)',
        content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
      },
      '304': { description: 'Not Modified (ETag matched If-None-Match)' },
      ...standardErrorResponses,
    },
  },
});

// --- Dashboard: first-run onboarding checklist (ADMIN | COUNSELLOR). ---
addPath('/dashboard/onboarding', {
  get: {
    tags: ['Dashboard'],
    summary: 'First-run setup checklist (8 steps with complete flags + action URLs; 60s tenant cache)',
    security: bearer,
    responses: { '200': ok('Onboarding checklist'), ...standardErrorResponses },
  },
});

// --- Users: admin-driven MFA force-disable (recovery flow). ---
// SVT-SEC-MFA-FORCE-DISABLE-2026-05 — for the case where a tenant admin
// loses both their TOTP device AND every recovery code; the actor must
// themselves pass step-up MFA (X-MFA-Code).
addPath('/users/{id}/mfa/disable', {
  post: {
    tags: ['Users'],
    summary: 'Admin force-disable a user MFA (step-up: caller X-MFA-Code required)',
    security: bearer,
    parameters: [
      idParam(),
      { name: 'X-MFA-Code', in: 'header', required: false, schema: { type: 'string', minLength: 6, maxLength: 8 } },
    ],
    requestBody: jsonBody('AdminDisableMfaRequest'),
    responses: { '204': noContent(), ...standardErrorResponses },
  },
});

// --- Public (no-auth) DSAR intake. ---
// SVT-WAVE-DSAR-PUBLIC-2026-05 — always returns 200 with a generic message
// (anti-enumeration); per-IP rate-limited.
addPath('/public/dsar', {
  post: {
    tags: ['Privacy'],
    summary: 'Public DSAR intake (unauthenticated; 200 always; anti-enumeration; rate-limited)',
    requestBody: jsonBody('PublicDSARRequest'),
    responses: {
      '200': ok('Generic acknowledgement (constant body regardless of subject match)'),
      '422': problemRef('422'),
      '429': problemRef('429'),
    },
  },
});

// --- Public (no-auth) operational status snapshot. ---
// SVT-WAVE-STATUS-PUBLIC-2026-05 — degrades gracefully; never 5xx.
addPath('/public/status', {
  get: {
    tags: ['Health'],
    summary: 'Public operational status snapshot (60s cache; never 5xx)',
    responses: {
      '200': ok('Status snapshot (overall status + per-subsystem rows + incidents)'),
      '429': problemRef('429'),
    },
  },
});

// --- Public (no-auth) CSP violation report sink. ---
// SVT-SEC-P2-FE3-2026-05 — receives application/csp-report or
// application/reports+json POSTs from browsers. Rate-limited 10/min/IP.
addPath('/csp/report', {
  post: {
    tags: ['Health'],
    summary: 'CSP violation report sink (browsers POST report-uri payloads here)',
    requestBody: {
      required: false,
      content: {
        'application/csp-report': { schema: { type: 'object' } },
        'application/reports+json': { schema: { type: 'array', items: { type: 'object' } } },
        'application/json': { schema: { type: 'object' } },
      },
    },
    responses: {
      '204': noContent(),
      '429': problemRef('429'),
    },
  },
});

// --- Public (no-auth) frontend error-boundary report sink. ---
// SVT-SEC-P2-FE4-2026-05 — sanitised: error name + Next.js digest only
// (no message, no stack). Rate-limited 30/min/IP.
addPath('/security/error-report', {
  post: {
    tags: ['Health'],
    summary: 'Frontend error-boundary report sink (sanitised: name + digest only)',
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              name: { type: 'string', maxLength: 200 },
              digest: { type: 'string', maxLength: 200 },
              route: { type: 'string', maxLength: 80 },
            },
          },
        },
      },
    },
    responses: {
      '204': noContent(),
      '429': problemRef('429'),
    },
  },
});

// ---------------------------------------------------------------------------
// Final assembly
// ---------------------------------------------------------------------------

function problemResponse(status: number, title: string): {
  description: string;
  content: Record<string, { schema: { $ref: string } }>;
} {
  return {
    description: title,
    content: {
      'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } },
    },
  };
}

export function buildOpenApiDocument(): Record<string, unknown> {
  const doc = {
    openapi: '3.1.0',
    info: {
      title: 'Student Post-Visa Tracker API',
      version: '1.0.0',
      description: 'Multi-tenant student lifecycle tracker. Authentication via RS256 JWT.',
    },
    servers: [{ url: '/api/v1' }],
    tags: [
      { name: 'Auth' },
      { name: 'Health' },
      { name: 'Students' },
      { name: 'Stages' },
      { name: 'Lookups' },
      { name: 'Institutions' },
      { name: 'Programs' },
      { name: 'Enrollments' },
      { name: 'Imports' },
      { name: 'Exports' },
      { name: 'Dashboard' },
      { name: 'Users' },
      { name: 'Documents' },
      { name: 'Reminders' },
      { name: 'Commissions' },
      { name: 'Audit' },
      { name: 'Travel' },
      { name: 'Accommodation' },
      { name: 'Insurance' },
      { name: 'Finance' },
      { name: 'Compliance' },
      { name: 'Engagement' },
      { name: 'Employment' },
      { name: 'Dependents' },
      { name: 'Sponsorships' },
      { name: 'Contacts' },
      { name: 'Qualifications' },
      { name: 'LanguageTests' },
      { name: 'Identifications' },
      { name: 'Visas' },
      { name: 'RegulatorIds' },
      { name: 'Addresses' },
      { name: 'Communications' },
      { name: 'Privacy' },
      { name: 'Tags' },
      { name: 'Notes' },
      { name: 'Attributes' },
      { name: 'SavedViews' },
      { name: 'Expiries' },
      { name: 'VisaTypes' },
      { name: 'Jobs' },
      { name: 'FSM' },
      { name: 'Webhooks' },
      { name: 'Reports' },
      { name: 'Billing' },
      { name: 'Tenants' },
    ],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
      responses: {
        Problem401: problemResponse(401, 'Unauthorized — credentials missing or invalid'),
        Problem403: problemResponse(403, 'Forbidden — authenticated but not allowed'),
        Problem404: problemResponse(404, 'Not Found'),
        Problem409: problemResponse(409, 'Conflict — version or uniqueness violation'),
        Problem412: problemResponse(412, 'Precondition Failed — If-Match header version mismatch'),
        Problem422: problemResponse(422, 'Unprocessable Entity — validation error'),
        Problem429: problemResponse(429, 'Too Many Requests — rate limited'),
        Problem500: problemResponse(500, 'Internal Server Error'),
      },
      schemas: componentSchemas,
    },
  };
  // Round-trip through JSON to guarantee the result is serialisable. The
  // replacer coerces BigInt to string and drops functions/symbols so a single
  // mis-converted Zod default cannot blow up the entire spec endpoint.
  const replacer = (_k: string, v: unknown): unknown => {
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'function' || typeof v === 'symbol') return undefined;
    return v;
  };
  return JSON.parse(JSON.stringify(doc, replacer)) as Record<string, unknown>;
}

// Memoised — built once per process; the spec is immutable for a given build.
let cached: Record<string, unknown> | null = null;
export function getOpenApiDocument(): Record<string, unknown> {
  if (!cached) cached = buildOpenApiDocument();
  return cached;
}
