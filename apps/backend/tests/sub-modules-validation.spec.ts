// Table-driven happy-path + key-required validation for every sub-module CreateXRequest schema.
// Each row asserts that the well-formed payload parses, and that omitting `requiredKey`
// produces a parse failure — yielding ~50 micro-tests across 25 schemas.

import { describe, it, expect } from 'vitest';
import {
  CreateTravelRequest, CreateAccommodationRequest, CreateInsuranceRequest, CreateFinanceRequest,
  CreateComplianceRequest, CreateEngagementRequest, CreateEmploymentRequest, CreateDependentRequest,
  CreateSponsorRequest, CreateSponsorshipRequest, CreateContactRequest, CreateQualificationRequest,
  CreateLanguageTestRequest, CreateIdentificationRequest, CreateVisaRequest, CreateRegulatorIdRequest,
  CreateAddressRequest, CreateStudentAddressRequest, CreateMessageTemplateRequest, CreateMessageRequest,
  CreateConsentRequest, CreateDSARRequest, CreateBreachRequest, CreateSubProcessorRequest,
  CreateTagRequest, CreateEntityTagRequest, CreateNoteRequest, CreateAttributeDefinitionRequest,
  CreateEntityAttributeRequest, CreateSavedViewRequest,
} from '@spv/zod-schemas';
import type { ZodSchema } from 'zod';

const U = '018f4a3a-1e5e-7c2b-9b3a-1234567890ab';

// For most schemas a single required field exists, so the failure case is
// "delete bad[req]". A handful of schemas (e.g. Travel) have defaults on
// every field, so omitting any one still parses; for those we supply an
// explicit `badPatch` that makes the payload illegal in some other way
// (e.g. wrong type, unknown key with .strict()).
interface Row {
  name: string;
  schema: ZodSchema<unknown>;
  ok: Record<string, unknown>;
  req: string;
  badPatch?: Record<string, unknown>;
}

const TABLE: Row[] = [
  // Travel has defaults on every field, so omitting `status` still parses.
  // Use `badPatch` to send an invalid `status` enum value instead — this
  // still validates that the schema rejects malformed status payloads.
  { name: 'Travel', schema: CreateTravelRequest, ok: { status: 'BOOKED', pickup_arranged: false },
    req: 'status', badPatch: { status: 'NOT_A_REAL_STATUS' } },
  { name: 'Accommodation', schema: CreateAccommodationRequest, ok: { type: 'PRIVATE_RENTAL', is_current: true }, req: 'type' },
  { name: 'Insurance', schema: CreateInsuranceRequest,
    ok: { provider: 'A', policy_number: 'P', coverage_type: 'H', starts_on: '2026-01-01', ends_on: '2027-01-01' },
    req: 'provider' },
  { name: 'Finance', schema: CreateFinanceRequest,
    ok: { category: 'TUITION', description: 'd', amount_minor: 100, currency: 'USD', status: 'PENDING' },
    req: 'amount_minor' },
  { name: 'Compliance', schema: CreateComplianceRequest, ok: { check_type: 'TB_TEST' }, req: 'check_type' },
  { name: 'Engagement', schema: CreateEngagementRequest,
    ok: { check_date: '2026-05-14', method: 'in_person', present: true, recorded_by_id: U },
    req: 'check_date' },
  { name: 'Employment', schema: CreateEmploymentRequest,
    ok: { employer_name: 'A', work_type: 'X', started_on: '2026-01-01' }, req: 'employer_name' },
  { name: 'Dependent', schema: CreateDependentRequest,
    ok: { relationship_id: U, given_name: 'A', family_name: 'B', date_of_birth: '2020-01-01',
      nationality_code: 'NP', accompanies_principal: true },
    req: 'relationship_id' },
  { name: 'Sponsor', schema: CreateSponsorRequest,
    ok: { type: 'INDIVIDUAL', legal_name: 'X', is_active: true }, req: 'legal_name' },
  { name: 'Sponsorship', schema: CreateSponsorshipRequest,
    ok: { sponsor_id: U, coverage_pct: 50 }, req: 'sponsor_id' },
  { name: 'Contact', schema: CreateContactRequest,
    ok: { relationship_id: U, given_name: 'A', family_name: 'B',
      is_primary_guardian: false, is_emergency_contact: false, is_financial_sponsor: false },
    req: 'relationship_id' },
  { name: 'Qualification', schema: CreateQualificationRequest,
    ok: { level: 'BACHELORS', institution: 'TU', is_highest: true }, req: 'institution' },
  { name: 'LanguageTest', schema: CreateLanguageTestRequest,
    ok: { test_type: 'IELTS', overall_score: 7.5, test_date: '2026-01-01' }, req: 'overall_score' },
  { name: 'Identification', schema: CreateIdentificationRequest,
    ok: { type: 'PASSPORT', document_number: 'P1', issuing_country: 'NP', issued_on: '2020-01-01', is_primary: true },
    req: 'document_number' },
  { name: 'Visa', schema: CreateVisaRequest,
    ok: { visa_category_id: U, visa_number: 'V', destination_country: 'GB',
      issued_on: '2026-01-01', expires_on: '2028-01-01', entries: 'MULTIPLE', is_active: true },
    req: 'visa_number' },
  { name: 'RegulatorId', schema: CreateRegulatorIdRequest, ok: { scheme: 'CAS', value: 'X' }, req: 'scheme' },
  { name: 'Address', schema: CreateAddressRequest,
    ok: { line1: '1 High St', locality: 'London', country_code: 'GB' }, req: 'line1' },
  { name: 'StudentAddress', schema: CreateStudentAddressRequest,
    ok: { address_id: U, type: 'CURRENT', is_current: true }, req: 'address_id' },
  { name: 'MessageTemplate', schema: CreateMessageTemplateRequest,
    ok: { key: 'welcome', channel: 'EMAIL', body_md: 'Hi', is_active: true }, req: 'key' },
  { name: 'Message', schema: CreateMessageRequest, ok: { channel: 'EMAIL', body: 'Hi' }, req: 'body' },
  { name: 'Consent', schema: CreateConsentRequest,
    ok: { subject_type: 'student', subject_id: U, purpose: 'm', lawful_basis: 'CONSENT', granted: true },
    req: 'purpose' },
  { name: 'DSAR', schema: CreateDSARRequest,
    ok: { subject_type: 'student', subject_id: U, type: 'ACCESS' }, req: 'type' },
  { name: 'Breach', schema: CreateBreachRequest,
    ok: { detected_at: '2026-05-14T00:00:00Z', severity: 'HIGH', description: 'L', notification_sent: false },
    req: 'detected_at' },
  { name: 'SubProcessor', schema: CreateSubProcessorRequest,
    ok: { name: 'AWS', purpose: 'h', region: 'eu' }, req: 'name' },
  // Tag.key has min(2) and a slug regex — `'k'` (single char) fails happy-path.
  { name: 'Tag', schema: CreateTagRequest, ok: { key: 'kk', label: 'L', is_active: true }, req: 'key' },
  { name: 'EntityTag', schema: CreateEntityTagRequest,
    ok: { tag_id: U, entity_type: 'student', entity_id: U }, req: 'tag_id' },
  { name: 'Note', schema: CreateNoteRequest,
    ok: { entity_type: 'student', entity_id: U, body: 'n', is_pinned: false }, req: 'body' },
  { name: 'AttributeDefinition', schema: CreateAttributeDefinitionRequest,
    ok: { entity_type: 'student', key: 'colour', label: 'Colour', data_type: 'text',
      is_pii: false, is_required: false },
    req: 'data_type' },
  { name: 'EntityAttribute', schema: CreateEntityAttributeRequest,
    ok: { definition_id: U, entity_type: 'student', entity_id: U, value_text: 'red' },
    req: 'definition_id' },
  { name: 'SavedView', schema: CreateSavedViewRequest,
    ok: { resource: 'students', name: 'Mine', query_json: { f: 1 }, is_shared: false }, req: 'resource' },
];

describe('sub-module CreateXRequest schemas', () => {
  for (const r of TABLE) {
    it(`${r.name}: happy path parses`, () => {
      const result = r.schema.safeParse(r.ok);
      if (!result.success) console.error(r.name, result.error.format());
      expect(result.success).toBe(true);
    });
    it(`${r.name}: missing ${r.req} fails`, () => {
      const bad: Record<string, unknown> = { ...r.ok };
      if (r.badPatch) {
        // Schema has no truly required field (defaults everywhere); apply an
        // explicit invalid patch so the assertion still verifies *some*
        // failure mode rather than relying on missing-field semantics.
        Object.assign(bad, r.badPatch);
      } else {
        delete bad[r.req];
      }
      expect(r.schema.safeParse(bad).success).toBe(false);
    });
  }
});

describe('CreateConsentRequest — GDPR Art. 6(1)(f) balancing test', () => {
  const base = { subject_type: 'student', subject_id: U, purpose: 'marketing analytics', granted: true };

  it('requires justification when lawful_basis is LEGITIMATE_INTEREST', () => {
    expect(
      CreateConsentRequest.safeParse({ ...base, lawful_basis: 'LEGITIMATE_INTEREST' }).success,
    ).toBe(false);
    expect(
      CreateConsentRequest.safeParse({ ...base, lawful_basis: 'LEGITIMATE_INTEREST', justification: '   ' }).success,
    ).toBe(false);
    expect(
      CreateConsentRequest.safeParse({
        ...base,
        lawful_basis: 'LEGITIMATE_INTEREST',
        justification: 'LIA: necessity established, balanced against the data subject rights; opt-out offered.',
      }).success,
    ).toBe(true);
  });

  it('does not require justification for other lawful bases', () => {
    expect(CreateConsentRequest.safeParse({ ...base, lawful_basis: 'CONSENT' }).success).toBe(true);
    expect(CreateConsentRequest.safeParse({ ...base, lawful_basis: 'CONTRACT' }).success).toBe(true);
  });
});
