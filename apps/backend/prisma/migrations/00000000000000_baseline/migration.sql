-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'COUNSELLOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "NotificationDigest" AS ENUM ('PER_EVENT', 'DAILY', 'OFF');

-- CreateEnum
CREATE TYPE "LawfulBasis" AS ENUM ('CONSENT', 'CONTRACT', 'LEGAL_OBLIGATION', 'VITAL_INTEREST', 'PUBLIC_TASK', 'LEGITIMATE_INTEREST');

-- CreateEnum
CREATE TYPE "DSARType" AS ENUM ('ACCESS', 'PORTABILITY', 'ERASURE', 'RECTIFICATION', 'RESTRICTION', 'OBJECTION');

-- CreateEnum
CREATE TYPE "DSARStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "StageCategory" AS ENUM ('PRE_DEPARTURE', 'IN_TRANSIT', 'POST_ARRIVAL', 'ENROLLED', 'COMPLETED', 'EXCEPTION', 'IN_PROGRESS');

-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('NOT_KNOWN', 'MALE', 'FEMALE', 'NOT_APPLICABLE');

-- CreateEnum
CREATE TYPE "MaritalStatus" AS ENUM ('SINGLE', 'MARRIED', 'CIVIL_PARTNERSHIP', 'SEPARATED', 'DIVORCED', 'WIDOWED', 'OTHER');

-- CreateEnum
CREATE TYPE "StudentStatus" AS ENUM ('ACTIVE', 'ON_HOLD', 'ON_LEAVE', 'WITHDRAWN', 'COMPLETED', 'DEFERRED');

-- CreateEnum
CREATE TYPE "AddressType" AS ENUM ('PERMANENT', 'CURRENT', 'DESTINATION', 'CORRESPONDENCE');

-- CreateEnum
CREATE TYPE "IdType" AS ENUM ('PASSPORT', 'NATIONAL_ID', 'BIRTH_CERTIFICATE', 'DRIVING_LICENCE', 'OTHER');

-- CreateEnum
CREATE TYPE "VisaEntries" AS ENUM ('SINGLE', 'DOUBLE', 'MULTIPLE');

-- CreateEnum
CREATE TYPE "ComplianceType" AS ENUM ('MEDICAL_EXAM', 'BIOMETRICS', 'POLICE_CLEARANCE', 'TB_TEST', 'IHS_PAID', 'GTE_INTERVIEW', 'OTHER');

-- CreateEnum
CREATE TYPE "AcademicLevel" AS ENUM ('PRIMARY', 'LOWER_SECONDARY', 'UPPER_SECONDARY', 'POST_SECONDARY_NON_TERTIARY', 'FOUNDATION', 'ASSOCIATE', 'DIPLOMA', 'ADVANCED_DIPLOMA', 'BACHELORS', 'GRADUATE_CERTIFICATE', 'GRADUATE_DIPLOMA', 'POSTGRADUATE_CERTIFICATE', 'POSTGRADUATE_DIPLOMA', 'MASTERS', 'MPHIL', 'DOCTORATE', 'PROFESSIONAL', 'CERTIFICATE', 'OTHER');

-- CreateEnum
CREATE TYPE "LanguageTest" AS ENUM ('IELTS', 'PTE', 'TOEFL', 'DUOLINGO', 'OET', 'CAMBRIDGE', 'SAT', 'GRE', 'GMAT', 'OTHER');

-- CreateEnum
CREATE TYPE "SponsorType" AS ENUM ('INDIVIDUAL', 'FAMILY', 'EMPLOYER', 'GOVERNMENT', 'INSTITUTION', 'CHARITY', 'OTHER');

-- CreateEnum
CREATE TYPE "InstitutionType" AS ENUM ('UNIVERSITY', 'COLLEGE', 'COMMUNITY_COLLEGE', 'POLYTECHNIC', 'LANGUAGE_SCHOOL', 'PATHWAY_PROVIDER', 'VOCATIONAL', 'HIGH_SCHOOL', 'OTHER');

-- CreateEnum
CREATE TYPE "DeliveryMode" AS ENUM ('IN_PERSON', 'ONLINE', 'HYBRID', 'DISTANCE');

-- CreateEnum
CREATE TYPE "DurationPattern" AS ENUM ('SEMESTER_2_PER_YEAR', 'TRIMESTER_3_PER_YEAR', 'QUARTER_4_PER_YEAR', 'ANNUAL_COHORT', 'BIANNUAL_2_YEARS', 'CONTINUOUS_ENROLLMENT', 'MONTHLY_INTAKE', 'MODULAR');

-- CreateEnum
CREATE TYPE "RequirementCategory" AS ENUM ('ACADEMIC', 'LANGUAGE', 'TEST', 'WORK_EXPERIENCE', 'PORTFOLIO', 'INTERVIEW', 'DOCUMENT', 'FINANCIAL', 'OTHER');

-- CreateEnum
CREATE TYPE "FeeAudience" AS ENUM ('DOMESTIC', 'INTERNATIONAL', 'REGIONAL', 'OTHER');

-- CreateEnum
CREATE TYPE "FeeType" AS ENUM ('TUITION', 'REGISTRATION', 'APPLICATION', 'DEPOSIT', 'MATERIALS', 'LIVING_COST_ESTIMATE', 'OTHER');

-- CreateEnum
CREATE TYPE "FeePeriod" AS ENUM ('TOTAL', 'YEAR', 'SEMESTER', 'TERM', 'MONTH', 'MODULE');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('OFFERED', 'ACCEPTED', 'ENROLLED', 'ON_LEAVE', 'DEFERRED', 'WITHDRAWN', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SuperAgentStatus" AS ENUM ('ACTIVE', 'PAUSED', 'TERMINATED');

-- CreateEnum
CREATE TYPE "TravelStatus" AS ENUM ('PLANNED', 'BOOKED', 'CANCELLED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "AccommodationType" AS ENUM ('UNIVERSITY_HALL', 'HOMESTAY', 'PRIVATE_RENTAL', 'OWNED', 'OTHER');

-- CreateEnum
CREATE TYPE "RentPeriod" AS ENUM ('WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY');

-- CreateEnum
CREATE TYPE "FinanceCategory" AS ENUM ('TUITION', 'ACCOMMODATION', 'TRAVEL', 'INSURANCE', 'LIVING_COST', 'CONSULTANCY', 'COMMISSION', 'OTHER');

-- CreateEnum
CREATE TYPE "FinanceStatus" AS ENUM ('PENDING', 'PAID', 'OVERDUE', 'WAIVED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "DocumentVerification" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AvStatus" AS ENUM ('PENDING', 'CLEAN', 'INFECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "CommsChannel" AS ENUM ('EMAIL', 'SMS', 'WHATSAPP', 'IN_APP');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('UPLOADED', 'PARSING', 'VALIDATING', 'DRY_RUN_READY', 'APPLYING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ExportStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "IdempotencyStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "ReminderType" AS ENUM ('INTAKE_START', 'PAYMENT_DUE', 'VISA_EXPIRY', 'PASSPORT_EXPIRY', 'INSURANCE_EXPIRY', 'DOCUMENT_EXPIRY', 'ENROLLMENT_DECISION_DUE', 'COMMISSION_CLAIM_DUE', 'COMPLIANCE_CHECK_DUE', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ReminderStatus" AS ENUM ('PENDING', 'SENT', 'ACKNOWLEDGED', 'SNOOZED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "CommissionStatus" AS ENUM ('PENDING', 'CLAIMED', 'INVOICED', 'PAID', 'DISPUTED', 'WAIVED');

-- CreateEnum
CREATE TYPE "JobRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'PARTIAL', 'SKIPPED_LOCKED');

-- CreateEnum
CREATE TYPE "FeePlanStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FeeInstallmentStatus" AS ENUM ('SCHEDULED', 'INVOICED', 'DUE', 'OVERDUE', 'PARTIAL', 'PAID', 'WAIVED', 'SUSPENDED', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('RECEIVED', 'VOIDED', 'PARTIALLY_REFUNDED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'CARD', 'CHEQUE', 'OTHER');

-- CreateEnum
CREATE TYPE "FeeAdjustmentKind" AS ENUM ('LATE_FEE', 'DISCOUNT', 'SCHOLARSHIP', 'WAIVER', 'WRITE_OFF');

-- CreateEnum
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "BillingCadence" AS ENUM ('MONTHLY', 'QUARTERLY', 'TRIMESTER', 'SEMESTER', 'TERM', 'ANNUAL', 'CUSTOM');

-- CreateEnum
CREATE TYPE "CrmLeadCourseState" AS ENUM ('documents_collection', 'application_form', 'offer_received_unconditional', 'offer_received_conditional', 'offer_accepted', 'offer_rejected', 'visa_lodgement', 'visa_accepted', 'visa_refused');

-- CreateEnum
CREATE TYPE "CrmLeadProfileStatus" AS ENUM ('complete', 'incomplete');

-- CreateEnum
CREATE TYPE "CrmLeadPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'VIP');

-- CreateEnum
CREATE TYPE "CrmPaymentMethodKind" AS ENUM ('CASH', 'ONLINE', 'BANK', 'SPLIT');

-- CreateEnum
CREATE TYPE "CrmVisitOutcome" AS ENUM ('REGISTERED', 'COUNSELLED', 'FOLLOW_UP_NEEDED', 'NO_SHOW', 'LOST');

-- CreateEnum
CREATE TYPE "CrmQualificationLevel" AS ENUM ('SLC', 'HIGHSCHOOL', 'BACHELORS', 'MASTERS', 'PHD', 'DIPLOMA', 'CERTIFICATE', 'PROFESSIONAL');

-- CreateEnum
CREATE TYPE "CrmGradeScale" AS ENUM ('PERCENT', 'CGPA_4', 'CGPA_10', 'DIVISION', 'LETTER');

-- CreateEnum
CREATE TYPE "CrmQualificationDivision" AS ENUM ('FIRST', 'SECOND', 'THIRD', 'PASS');

-- CreateEnum
CREATE TYPE "CrmLanguageTestType" AS ENUM ('IELTS', 'PTE', 'TOEFL', 'SAT', 'DUOLINGO', 'OET', 'CAMBRIDGE', 'GRE', 'GMAT', 'OTHER');

-- CreateEnum
CREATE TYPE "CrmGuardianRelationshipType" AS ENUM ('FATHER', 'MOTHER', 'SPOUSE', 'SIBLING', 'GUARDIAN', 'SPONSOR', 'EMERGENCY_CONTACT', 'OTHER');

-- CreateEnum
CREATE TYPE "CrmAssignmentKind" AS ENUM ('ASSIGNEE', 'FOLLOWER');

-- CreateEnum
CREATE TYPE "CrmLeadStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'WITHDRAWN', 'ON_HOLD');

-- CreateEnum
CREATE TYPE "CrmFeeStatus" AS ENUM ('SCHEDULED', 'DUE', 'PAID', 'WAIVED', 'OVERDUE');

-- CreateEnum
CREATE TYPE "InterviewQuestionCategory" AS ENUM ('GENERAL', 'ACADEMIC', 'FINANCIAL', 'TIES_TO_HOME', 'FUTURE_PLANS', 'PERSONAL', 'I20_ANALYSIS', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "InterviewAttemptStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'ABANDONED');

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "legal_name" TEXT,
    "default_locale" TEXT NOT NULL DEFAULT 'en',
    "default_timezone" TEXT NOT NULL DEFAULT 'UTC',
    "default_currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "data_residency_region" TEXT NOT NULL DEFAULT 'eu-west-1',
    "email_from" TEXT,
    "billing_enabled" BOOLEAN NOT NULL DEFAULT false,
    "require_mfa_for_admins" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sub_processors" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "contract_url" TEXT,
    "dpa_signed_at" TIMESTAMPTZ,
    "transfer_mechanism" TEXT,
    "added_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMPTZ,

    CONSTRAINT "sub_processors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified_at" TIMESTAMPTZ,
    "password_hash" TEXT NOT NULL,
    "given_name" TEXT NOT NULL,
    "family_name" TEXT NOT NULL,
    "display_name" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'COUNSELLOR',
    "locale" TEXT NOT NULL DEFAULT 'en',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ,
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ,
    "password_changed_at" TIMESTAMPTZ,
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "mfa_secret_enc" BYTEA,
    "mfa_recovery_hashes" TEXT,
    "notifications_email_enabled" BOOLEAN NOT NULL DEFAULT true,
    "notifications_digest" "NotificationDigest" NOT NULL DEFAULT 'PER_EVENT',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "device_id" TEXT,
    "ua_hash" TEXT,
    "ip_subnet" TEXT,
    "issued_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "last_used_at" TIMESTAMPTZ,
    "replaced_by_id" UUID,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_token_denylist" (
    "jti" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "access_token_denylist_pkey" PRIMARY KEY ("jti")
);

-- CreateTable
CREATE TABLE "audit_anchors" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "root_hash" CHAR(64) NOT NULL,
    "entries_count" INTEGER NOT NULL,
    "last_entry_id" UUID,
    "last_entry_created_at" TIMESTAMPTZ,
    "anchored_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_anchors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "consumed_at" TIMESTAMPTZ,
    "invalidated_at" TIMESTAMPTZ,
    "ip_hash" TEXT,
    "ua_hash" TEXT,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "lawful_basis" "LawfulBasis" NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "justification" TEXT,
    "evidence" JSONB,
    "granted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ,

    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dsar_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "type" "DSARType" NOT NULL,
    "status" "DSARStatus" NOT NULL DEFAULT 'PENDING',
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "due_by" TIMESTAMPTZ NOT NULL,
    "completed_at" TIMESTAMPTZ,
    "export_storage_key" TEXT,
    "notes" TEXT,

    CONSTRAINT "dsar_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "breach_incidents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "detected_at" TIMESTAMPTZ NOT NULL,
    "due_by" TIMESTAMPTZ NOT NULL,
    "reported_at" TIMESTAMPTZ,
    "severity" TEXT NOT NULL,
    "affected_subjects_count" INTEGER,
    "description" TEXT NOT NULL,
    "remediation" TEXT,
    "notification_sent" BOOLEAN NOT NULL DEFAULT false,
    "closed_at" TIMESTAMPTZ,

    CONSTRAINT "breach_incidents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "countries" (
    "code_alpha2" CHAR(2) NOT NULL,
    "code_alpha3" CHAR(3) NOT NULL,
    "numeric_code" CHAR(3) NOT NULL,
    "name" TEXT NOT NULL,
    "dial_code" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "countries_pkey" PRIMARY KEY ("code_alpha2")
);

-- CreateTable
CREATE TABLE "currencies" (
    "code" CHAR(3) NOT NULL,
    "name" TEXT NOT NULL,
    "minor_unit" INTEGER NOT NULL DEFAULT 2,
    "symbol" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "currencies_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "isced_fields" (
    "code" CHAR(4) NOT NULL,
    "label" TEXT NOT NULL,

    CONSTRAINT "isced_fields_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "airlines_iata" (
    "iata" CHAR(2) NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "airlines_iata_pkey" PRIMARY KEY ("iata")
);

-- CreateTable
CREATE TABLE "airports_iata" (
    "iata" CHAR(3) NOT NULL,
    "name" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "country_code" CHAR(2) NOT NULL,

    CONSTRAINT "airports_iata_pkey" PRIMARY KEY ("iata")
);

-- CreateTable
CREATE TABLE "visa_categories" (
    "id" UUID NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "is_student" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "visa_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "relationship_types" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "is_guardian" BOOLEAN NOT NULL DEFAULT true,
    "is_emergency" BOOLEAN NOT NULL DEFAULT false,
    "is_sponsor" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "relationship_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_types" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "is_required" BOOLEAN NOT NULL DEFAULT false,
    "has_expiry" BOOLEAN NOT NULL DEFAULT false,
    "retention_days" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "document_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lifecycle_stages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "label_translations" JSONB,
    "description" TEXT,
    "sequence" INTEGER NOT NULL,
    "category" "StageCategory" NOT NULL DEFAULT 'IN_PROGRESS',
    "color_hex" CHAR(7),
    "icon" TEXT,
    "is_initial" BOOLEAN NOT NULL DEFAULT false,
    "is_terminal" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sla_hours" INTEGER,
    "destination_country" CHAR(2),
    "config_version" INTEGER NOT NULL DEFAULT 1,
    "visa_type_id" UUID,
    "is_outcome_success" BOOLEAN NOT NULL DEFAULT false,
    "is_outcome_failure" BOOLEAN NOT NULL DEFAULT false,
    "show_on_dashboard" BOOLEAN NOT NULL DEFAULT true,
    "prompt_date_label" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "lifecycle_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visa_types" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "name" TEXT NOT NULL,
    "short_name" TEXT,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "is_generic" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "visa_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lifecycle_stage_transitions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "from_stage_id" UUID NOT NULL,
    "to_stage_id" UUID NOT NULL,
    "requires_role" "UserRole",

    CONSTRAINT "lifecycle_stage_transitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lifecycle_stage_checklist_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "is_required" BOOLEAN NOT NULL DEFAULT true,
    "sla_hours" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "lifecycle_stage_checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_stage_checklist_progress" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "checklist_item_id" UUID NOT NULL,
    "completed_at" TIMESTAMPTZ,
    "completed_by_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "student_stage_checklist_progress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "students" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_code" TEXT NOT NULL,
    "given_name" TEXT NOT NULL,
    "middle_name" TEXT,
    "family_name" TEXT NOT NULL,
    "preferred_name" TEXT,
    "name_in_passport_enc" BYTEA NOT NULL,
    "date_of_birth" DATE NOT NULL,
    "gender" "Gender" NOT NULL DEFAULT 'NOT_KNOWN',
    "gender_self_described" TEXT,
    "nationality_code" CHAR(2) NOT NULL,
    "marital_status" "MaritalStatus",
    "primary_language" TEXT NOT NULL DEFAULT 'en',
    "religion" TEXT,
    "ethnicity" TEXT,
    "email_primary" TEXT,
    "email_secondary" TEXT,
    "phone_primary_e164" TEXT,
    "phone_secondary_e164" TEXT,
    "current_stage_id" UUID NOT NULL,
    "stage_entered_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "StudentStatus" NOT NULL DEFAULT 'ACTIVE',
    "assigned_to_id" UUID,
    "notes" TEXT,
    "completeness_pct" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ,
    "deleted_by_id" UUID,

    CONSTRAINT "students_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "addresses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "line3" TEXT,
    "locality" TEXT NOT NULL,
    "region" TEXT,
    "postal_code" TEXT,
    "country_code" CHAR(2) NOT NULL,
    "latitude" DECIMAL(9,6),
    "longitude" DECIMAL(9,6),
    "formatted" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_addresses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "address_id" UUID NOT NULL,
    "type" "AddressType" NOT NULL,
    "is_current" BOOLEAN NOT NULL DEFAULT false,
    "valid_from" DATE,
    "valid_to" DATE,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_identifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "type" "IdType" NOT NULL,
    "document_number_enc" BYTEA NOT NULL,
    "issuing_country" CHAR(2) NOT NULL,
    "issued_on" DATE NOT NULL,
    "expires_on" DATE,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "student_identifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_visas" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "visa_category_id" UUID NOT NULL,
    "visa_number_enc" BYTEA NOT NULL,
    "destination_country" CHAR(2) NOT NULL,
    "issuing_post" TEXT,
    "issued_on" DATE NOT NULL,
    "expires_on" DATE NOT NULL,
    "entries" "VisaEntries" NOT NULL DEFAULT 'MULTIPLE',
    "conditions" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "student_visas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_regulator_identifiers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "scheme" TEXT NOT NULL,
    "value_enc" BYTEA NOT NULL,
    "issued_on" DATE,
    "expires_on" DATE,
    "status" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "student_regulator_identifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_checks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "check_type" "ComplianceType" NOT NULL,
    "scheduled_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "result" TEXT,
    "expires_on" DATE,
    "document_id" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "compliance_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "engagement_checks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "check_date" DATE NOT NULL,
    "method" TEXT NOT NULL,
    "present" BOOLEAN NOT NULL,
    "notes" TEXT,
    "recorded_by_id" UUID NOT NULL,

    CONSTRAINT "engagement_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_employment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "employer_name" TEXT NOT NULL,
    "employer_address_id" UUID,
    "work_type" TEXT NOT NULL,
    "hours_per_week" INTEGER,
    "started_on" DATE NOT NULL,
    "ended_on" DATE,
    "authorisation_doc_id" UUID,
    "notes" TEXT,

    CONSTRAINT "student_employment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_dependents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "relationship_id" UUID NOT NULL,
    "given_name" TEXT NOT NULL,
    "family_name" TEXT NOT NULL,
    "date_of_birth" DATE NOT NULL,
    "nationality_code" CHAR(2) NOT NULL,
    "passport_number_enc" BYTEA,
    "visa_status" TEXT,
    "accompanies_principal" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,

    CONSTRAINT "student_dependents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "academic_qualifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "level" "AcademicLevel" NOT NULL,
    "institution" TEXT NOT NULL,
    "board_or_university" TEXT,
    "country_code" CHAR(2),
    "field_of_study" TEXT,
    "isced_code" CHAR(4),
    "started_on" DATE,
    "completed_on" DATE,
    "grade_value" TEXT,
    "grade_scale" TEXT,
    "is_highest" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "academic_qualifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "language_test_results" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "test_type" "LanguageTest" NOT NULL,
    "overall_score" DECIMAL(5,2) NOT NULL,
    "listening" DECIMAL(5,2),
    "reading" DECIMAL(5,2),
    "writing" DECIMAL(5,2),
    "speaking" DECIMAL(5,2),
    "test_date" DATE NOT NULL,
    "expires_on" DATE,
    "certificate_no" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "language_test_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_contacts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "relationship_id" UUID NOT NULL,
    "given_name" TEXT NOT NULL,
    "family_name" TEXT NOT NULL,
    "phone_e164" TEXT,
    "email" TEXT,
    "occupation" TEXT,
    "employer" TEXT,
    "annual_income_minor_enc" BYTEA,
    "income_currency" CHAR(3),
    "is_primary_guardian" BOOLEAN NOT NULL DEFAULT false,
    "is_emergency_contact" BOOLEAN NOT NULL DEFAULT false,
    "is_financial_sponsor" BOOLEAN NOT NULL DEFAULT false,
    "address_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "student_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sponsors" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type" "SponsorType" NOT NULL,
    "legal_name" TEXT NOT NULL,
    "registration_no" TEXT,
    "country_code" CHAR(2),
    "email" TEXT,
    "phone_e164" TEXT,
    "address_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sponsors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_sponsorships" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "sponsor_id" UUID NOT NULL,
    "coverage_pct" DECIMAL(5,2) NOT NULL,
    "amount_minor" BIGINT,
    "currency" CHAR(3),
    "starts_on" DATE,
    "ends_on" DATE,
    "letter_doc_id" UUID,
    "notes" TEXT,

    CONSTRAINT "student_sponsorships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institutions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "legal_name" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "short_name" TEXT,
    "type" "InstitutionType" NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "primary_address_id" UUID,
    "website" TEXT,
    "email" TEXT,
    "phone_e164" TEXT,
    "established_year" INTEGER,
    "ranking_global" INTEGER,
    "ranking_national" INTEGER,
    "description" TEXT,
    "logo_url" TEXT,
    "banner_url" TEXT,
    "is_partner" BOOLEAN NOT NULL DEFAULT false,
    "partner_since" DATE,
    "commission_pct" DECIMAL(5,2),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "institutions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institution_identifiers" (
    "id" UUID NOT NULL,
    "institution_id" UUID NOT NULL,
    "scheme" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "issued_by" TEXT,
    "valid_from" DATE,
    "valid_to" DATE,

    CONSTRAINT "institution_identifiers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institution_accreditations" (
    "id" UUID NOT NULL,
    "institution_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "accreditation_no" TEXT,
    "awarded_on" DATE,
    "expires_on" DATE,
    "scope" TEXT,

    CONSTRAINT "institution_accreditations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institution_contacts" (
    "id" UUID NOT NULL,
    "institution_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "designation" TEXT,
    "department" TEXT,
    "email" TEXT,
    "phone_e164" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,

    CONSTRAINT "institution_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campuses" (
    "id" UUID NOT NULL,
    "institution_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_main" BOOLEAN NOT NULL DEFAULT false,
    "address_id" UUID,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "phone_e164" TEXT,
    "email" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "campuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schools" (
    "id" UUID NOT NULL,
    "institution_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "short_name" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "schools_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "departments" (
    "id" UUID NOT NULL,
    "school_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "short_name" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "programs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "institution_id" UUID NOT NULL,
    "school_id" UUID,
    "department_id" UUID,
    "code" TEXT,
    "name" TEXT NOT NULL,
    "short_name" TEXT,
    "level" "AcademicLevel" NOT NULL,
    "field_of_study" TEXT,
    "isced_code" CHAR(4),
    "delivery_mode" "DeliveryMode" NOT NULL DEFAULT 'IN_PERSON',
    "language_of_instruction" TEXT NOT NULL DEFAULT 'en',
    "duration_months" INTEGER NOT NULL,
    "duration_pattern" "DurationPattern",
    "terms_per_year" INTEGER,
    "credit_hours" INTEGER,
    "description" TEXT,
    "url" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_intakes" (
    "id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "campus_id" UUID,
    "intake_year" INTEGER NOT NULL,
    "intake_month" INTEGER NOT NULL,
    "intake_label" TEXT NOT NULL,
    "application_open" DATE,
    "application_close" DATE,
    "decision_date" DATE,
    "classes_start_on" DATE,
    "classes_end_on" DATE,
    "capacity" INTEGER,
    "is_open" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,

    CONSTRAINT "program_intakes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_requirements" (
    "id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "category" "RequirementCategory" NOT NULL,
    "label" TEXT NOT NULL,
    "details" TEXT,
    "min_value" DECIMAL(8,2),
    "unit" TEXT,
    "is_mandatory" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "program_requirements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_modules" (
    "id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "credits" DECIMAL(5,2),
    "semester" INTEGER,
    "is_core" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,

    CONSTRAINT "program_modules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "program_fees" (
    "id" UUID NOT NULL,
    "program_intake_id" UUID NOT NULL,
    "audience" "FeeAudience" NOT NULL DEFAULT 'INTERNATIONAL',
    "fee_type" "FeeType" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "per_period" "FeePeriod" NOT NULL DEFAULT 'YEAR',
    "is_estimated" BOOLEAN NOT NULL DEFAULT false,
    "effective_from" DATE,
    "notes" TEXT,

    CONSTRAINT "program_fees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrollments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "institution_id" UUID NOT NULL,
    "program_id" UUID NOT NULL,
    "program_intake_id" UUID,
    "campus_id" UUID,
    "enrollment_no" TEXT,
    "start_date" DATE,
    "expected_end_date" DATE,
    "actual_end_date" DATE,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'OFFERED',
    "tuition_total_minor" BIGINT,
    "tuition_currency" CHAR(3),
    "scholarship_minor" BIGINT DEFAULT 0,
    "scholarship_name" TEXT,
    "agent_commission_minor" BIGINT,
    "super_agent_id" UUID,
    "notes" TEXT,
    "paused_at" TIMESTAMPTZ,
    "resumed_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "super_agent_types" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "super_agent_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "super_agents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type_id" UUID,
    "name" TEXT NOT NULL,
    "short_name" TEXT,
    "legal_name" TEXT,
    "country_code" CHAR(2),
    "website" TEXT,
    "logo_url" TEXT,
    "contact_email" TEXT,
    "contact_phone_e164" TEXT,
    "default_commission_pct" DECIMAL(5,2),
    "default_currency" CHAR(3),
    "payment_terms_days" INTEGER,
    "status" "SuperAgentStatus" NOT NULL DEFAULT 'ACTIVE',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "sub_processor_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "super_agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "super_agent_contacts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "super_agent_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "email" TEXT,
    "phone_e164" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "super_agent_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "super_agent_commission_rules" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "super_agent_id" UUID NOT NULL,
    "institution_id" UUID,
    "program_level" TEXT,
    "commission_pct" DECIMAL(5,2) NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "effective_from" DATE NOT NULL,
    "effective_to" DATE,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,

    CONSTRAINT "super_agent_commission_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institution_super_agents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "institution_id" UUID NOT NULL,
    "super_agent_id" UUID NOT NULL,
    "is_preferred" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "institution_super_agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "travel_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "pnr" TEXT,
    "airline_iata" CHAR(2),
    "flight_number" TEXT,
    "departure_iata" CHAR(3),
    "arrival_iata" CHAR(3),
    "departure_at" TIMESTAMPTZ,
    "arrival_at" TIMESTAMPTZ,
    "pickup_arranged" BOOLEAN NOT NULL DEFAULT false,
    "pickup_notes" TEXT,
    "fare_minor" BIGINT,
    "fare_currency" CHAR(3),
    "status" "TravelStatus" NOT NULL DEFAULT 'BOOKED',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "travel_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accommodations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "type" "AccommodationType" NOT NULL,
    "provider_name" TEXT,
    "contact_phone_e164" TEXT,
    "contact_email" TEXT,
    "address_id" UUID,
    "move_in_date" DATE,
    "move_out_date" DATE,
    "rent_minor" BIGINT,
    "rent_currency" CHAR(3),
    "rent_period" "RentPeriod",
    "deposit_minor" BIGINT,
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "accommodations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "insurance_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "policy_number_enc" BYTEA NOT NULL,
    "coverage_type" TEXT NOT NULL,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "premium_minor" BIGINT,
    "premium_currency" CHAR(3),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "insurance_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finance_items" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "enrollment_id" UUID,
    "sponsor_id" UUID,
    "category" "FinanceCategory" NOT NULL,
    "description" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "exchange_rate_to_base" DECIMAL(18,8),
    "invoice_no" TEXT,
    "due_on" DATE,
    "paid_on" DATE,
    "status" "FinanceStatus" NOT NULL DEFAULT 'PENDING',
    "reference" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "finance_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "document_type_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "av_status" "AvStatus" NOT NULL DEFAULT 'PENDING',
    "av_scanned_at" TIMESTAMPTZ,
    "issued_on" DATE,
    "expires_on" DATE,
    "verification" "DocumentVerification" NOT NULL DEFAULT 'PENDING',
    "verified_at" TIMESTAMPTZ,
    "verified_by_id" UUID,
    "retention_until" DATE,
    "version" INTEGER NOT NULL DEFAULT 1,
    "superseded_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "channel" "CommsChannel" NOT NULL,
    "subject" TEXT,
    "body_md" TEXT NOT NULL,
    "destination_country" CHAR(2),
    "stage_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comms_threads" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID,
    "channel" "CommsChannel" NOT NULL,
    "subject" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comms_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comms_messages" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "recipient_user_id" UUID,
    "direction" "MessageDirection" NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'QUEUED',
    "subject" TEXT,
    "template_id" UUID,
    "body" TEXT NOT NULL,
    "sent_at" TIMESTAMPTZ,
    "delivered_at" TIMESTAMPTZ,
    "read_at" TIMESTAMPTZ,
    "provider_id" TEXT,
    "metadata" JSONB,
    "created_by_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_attempt_at" TIMESTAMPTZ,
    "next_retry_at" TIMESTAMPTZ,

    CONSTRAINT "comms_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "color_hex" CHAR(7),
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_tags" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,

    CONSTRAINT "entity_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attribute_definitions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "data_type" TEXT NOT NULL,
    "enum_values" JSONB,
    "is_pii" BOOLEAN NOT NULL DEFAULT false,
    "is_required" BOOLEAN NOT NULL DEFAULT false,
    "destination_country" CHAR(2),

    CONSTRAINT "attribute_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_attributes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "definition_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "value_text" TEXT,
    "value_number" DECIMAL(20,6),
    "value_date" DATE,
    "value_bool" BOOLEAN,

    CONSTRAINT "entity_attributes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_views" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "resource" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "query_json" JSONB NOT NULL,
    "is_shared" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_lifecycle_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "from_stage_id" UUID,
    "to_stage_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effective_at" TIMESTAMPTZ NOT NULL,
    "reason_code" TEXT,
    "notes" TEXT,
    "actor_id" UUID NOT NULL,
    "actor_role" "UserRole" NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "student_lifecycle_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "actor_id" UUID,
    "actor_email_hash" TEXT,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID,
    "entity_version" INTEGER,
    "before_enc" BYTEA,
    "after_enc" BYTEA,
    "ip_hash" TEXT,
    "ua_hash" TEXT,
    "request_id" TEXT,
    "prev_hash" CHAR(64),
    "entry_hash" CHAR(64) NOT NULL,
    "hash_version" SMALLINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_jobs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "resource" TEXT NOT NULL,
    "source_filename" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "row_total" INTEGER,
    "row_processed" INTEGER NOT NULL DEFAULT 0,
    "row_created" INTEGER NOT NULL DEFAULT 0,
    "row_updated" INTEGER NOT NULL DEFAULT 0,
    "row_skipped" INTEGER NOT NULL DEFAULT 0,
    "row_failed" INTEGER NOT NULL DEFAULT 0,
    "status" "ImportStatus" NOT NULL DEFAULT 'UPLOADED',
    "mapping_json" JSONB,
    "error_report_key" TEXT,
    "result_key" TEXT,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID NOT NULL,
    "webhook_url" TEXT,

    CONSTRAINT "import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_mapping_templates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "resource" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mapping_json" JSONB NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_mapping_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "export_jobs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "resource" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "filter_json" JSONB NOT NULL,
    "columns_json" JSONB NOT NULL,
    "redact_pii" BOOLEAN NOT NULL DEFAULT true,
    "row_total" INTEGER,
    "status" "ExportStatus" NOT NULL DEFAULT 'QUEUED',
    "storage_key" TEXT,
    "sha256" CHAR(64),
    "expires_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID NOT NULL,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "export_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_ids" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "external_id" TEXT NOT NULL,
    "source_system" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_ids_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status" "IdempotencyStatus" NOT NULL DEFAULT 'PENDING',
    "status_code" INTEGER,
    "response" JSONB,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminders" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID,
    "enrollment_id" UUID,
    "type" "ReminderType" NOT NULL,
    "source_entity_type" TEXT,
    "source_entity_id" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "due_on" DATE NOT NULL,
    "scheduled_for" TIMESTAMPTZ NOT NULL,
    "assigned_to_id" UUID,
    "status" "ReminderStatus" NOT NULL DEFAULT 'PENDING',
    "fire_count" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMPTZ,
    "acknowledged_at" TIMESTAMPTZ,
    "snooze_until" TIMESTAMPTZ,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_claims" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "institution_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "super_agent_id" UUID,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "commission_pct" DECIMAL(5,2) NOT NULL,
    "basis_minor" BIGINT NOT NULL,
    "status" "CommissionStatus" NOT NULL DEFAULT 'PENDING',
    "claimed_on" DATE,
    "invoice_no" TEXT,
    "invoiced_on" DATE,
    "paid_on" DATE,
    "received_minor" BIGINT,
    "payment_reference" TEXT,
    "dispute_reason" TEXT,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "commission_claims_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_runs" (
    "id" UUID NOT NULL,
    "job_name" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ,
    "status" "JobRunStatus" NOT NULL DEFAULT 'RUNNING',
    "rows_processed" INTEGER NOT NULL DEFAULT 0,
    "rows_failed" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "metadata" JSONB,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_plans" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "cadence" "BillingCadence" NOT NULL,
    "total_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "scholarship_minor" BIGINT NOT NULL DEFAULT 0,
    "status" "FeePlanStatus" NOT NULL DEFAULT 'DRAFT',
    "starts_on" DATE NOT NULL,
    "ends_on" DATE,
    "paused_at" TIMESTAMPTZ,
    "paused_reason" TEXT,
    "resumed_at" TIMESTAMPTZ,
    "superseded_by_id" UUID,
    "late_fee_policy" JSONB,
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "fee_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_installments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fee_plan_id" UUID NOT NULL,
    "sequence_no" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "due_on" DATE NOT NULL,
    "gross_minor" BIGINT NOT NULL,
    "net_minor" BIGINT NOT NULL,
    "paid_minor" BIGINT NOT NULL DEFAULT 0,
    "balance_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "status" "FeeInstallmentStatus" NOT NULL DEFAULT 'SCHEDULED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "fee_installments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "received_on" DATE NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "reference" TEXT,
    "receipt_no" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "gross_minor" BIGINT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'RECEIVED',
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "fee_installment_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fee_adjustments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "fee_installment_id" UUID NOT NULL,
    "kind" "FeeAdjustmentKind" NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "reason_code" TEXT,
    "reason_text" TEXT NOT NULL,
    "applied_on" DATE NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,

    CONSTRAINT "fee_adjustments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "refunded_on" DATE,
    "method" "PaymentMethod" NOT NULL,
    "reference" TEXT,
    "reason_code" TEXT NOT NULL,
    "reason_text" TEXT NOT NULL,
    "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by_id" UUID,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_credits" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "enrollment_id" UUID,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "source" TEXT NOT NULL,
    "source_ref_id" UUID,
    "consumed_minor" BIGINT NOT NULL DEFAULT 0,
    "expires_on" DATE,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "student_credits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_countries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "currency_code" TEXT,
    "v2_country_id" INTEGER NOT NULL,
    "source_system" TEXT NOT NULL DEFAULT 'v2_mis',
    "synced_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ,
    "deleted_by_id" UUID,

    CONSTRAINT "crm_countries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_institutions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "street" TEXT,
    "city" TEXT,
    "state" TEXT,
    "post_code" TEXT,
    "currency_code" TEXT,
    "category" TEXT,
    "logo" TEXT,
    "is_active" BOOLEAN DEFAULT true,
    "v2_institution_id" INTEGER NOT NULL,
    "v2_country_id" INTEGER NOT NULL,
    "source_system" TEXT NOT NULL DEFAULT 'v2_mis',
    "synced_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "country_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ,
    "deleted_by_id" UUID,

    CONSTRAINT "crm_institutions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_courses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT,
    "category" TEXT,
    "start_date" TEXT,
    "end_date" TEXT,
    "fee_legacy" TEXT,
    "fee_amount_minor" BIGINT,
    "fee_currency" CHAR(3),
    "v2_course_id" INTEGER NOT NULL,
    "v2_institution_id" INTEGER,
    "source_system" TEXT NOT NULL DEFAULT 'v2_mis',
    "synced_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "institution_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ,
    "deleted_by_id" UUID,

    CONSTRAINT "crm_courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_leads" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "phone_number" TEXT NOT NULL,
    "secondary_number" TEXT,
    "gender" TEXT,
    "address" TEXT,
    "dob" TEXT,
    "email" TEXT,
    "city" TEXT,
    "source" TEXT,
    "type" TEXT,
    "interested_course" TEXT,
    "field_of_study" TEXT,
    "intake_month" VARCHAR(7),
    "application_status" TEXT,
    "profile_status" TEXT,
    "profile_state" "CrmLeadProfileStatus",
    "counsellor_status" BOOLEAN DEFAULT false,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "dropout" BOOLEAN DEFAULT false,
    "priority" "CrmLeadPriority" NOT NULL DEFAULT 'NORMAL',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "slc_institution_name" TEXT,
    "slc_grade" TEXT,
    "slc_year" TEXT,
    "highschool_institution_name" TEXT,
    "highschool_grade" TEXT,
    "highschool_year" TEXT,
    "bachelors_institution_name" TEXT,
    "bachelors_grade" TEXT,
    "bachelors_year" TEXT,
    "masters_institution_name" TEXT,
    "masters_grade" TEXT,
    "masters_year" TEXT,
    "ielts_overall_score" TEXT,
    "ielts_listening_score" TEXT,
    "ielts_reading_score" TEXT,
    "ielts_writing_score" TEXT,
    "ielts_speaking_score" TEXT,
    "ielts_date" TEXT,
    "pte_overall_score" TEXT,
    "pte_listening_score" TEXT,
    "pte_reading_score" TEXT,
    "pte_writing_score" TEXT,
    "pte_speaking_score" TEXT,
    "pte_date" TEXT,
    "sat_overall_score" TEXT,
    "sat_math_score" TEXT,
    "sat_reading_score" TEXT,
    "sat_writing_and_language_score" TEXT,
    "sat_date" TEXT,
    "utm_source" TEXT,
    "utm_medium" TEXT,
    "utm_campaign" TEXT,
    "utm_term" TEXT,
    "utm_content" TEXT,
    "landing_page" TEXT,
    "referrer" TEXT,
    "first_touched_at" TIMESTAMPTZ,
    "v2_created_at" TIMESTAMPTZ,
    "v2_updated_at" TIMESTAMPTZ,
    "v2_lead_id" INTEGER NOT NULL,
    "source_system" TEXT NOT NULL DEFAULT 'v2_mis',
    "synced_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assigned_to_id" UUID,
    "spv_status" "CrmLeadStatus" NOT NULL DEFAULT 'ACTIVE',
    "spv_notes" TEXT,
    "student_id" UUID,
    "converted_at" TIMESTAMPTZ,
    "converted_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ,
    "deleted_by_id" UUID,

    CONSTRAINT "crm_leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_applications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "intake_key" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'draft',
    "notes" TEXT,
    "started_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "v2_created_at" TIMESTAMPTZ,
    "v2_updated_at" TIMESTAMPTZ,
    "v2_deleted_at" TIMESTAMPTZ,
    "v2_application_id" INTEGER NOT NULL,
    "v2_lead_id" INTEGER NOT NULL,
    "v2_course_id" INTEGER NOT NULL,
    "source_system" TEXT NOT NULL DEFAULT 'v2_mis',
    "synced_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lead_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ,
    "deleted_by_id" UUID,

    CONSTRAINT "crm_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_lead_courses" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "state" TEXT,
    "state_v2" "CrmLeadCourseState",
    "sub_state" TEXT,
    "start_date" TIMESTAMPTZ,
    "end_date" TIMESTAMPTZ,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "v2_created_at" TIMESTAMPTZ,
    "v2_updated_at" TIMESTAMPTZ,
    "v2_lead_id" INTEGER NOT NULL,
    "v2_course_id" INTEGER NOT NULL,
    "source_system" TEXT NOT NULL DEFAULT 'v2_mis',
    "synced_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lead_id" UUID NOT NULL,
    "course_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ,
    "deleted_by_id" UUID,

    CONSTRAINT "crm_lead_courses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_lead_course_history" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "from_state" TEXT,
    "to_state" TEXT NOT NULL,
    "changed_by" TEXT,
    "changed_at" TIMESTAMPTZ NOT NULL,
    "v2_history_id" INTEGER NOT NULL,
    "v2_lead_id" INTEGER NOT NULL,
    "v2_course_id" INTEGER NOT NULL,
    "source_system" TEXT NOT NULL DEFAULT 'v2_mis',
    "synced_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lead_id" UUID NOT NULL,
    "course_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,

    CONSTRAINT "crm_lead_course_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_payments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'NPR',
    "method" "CrmPaymentMethodKind" NOT NULL,
    "cash_amount_minor" BIGINT,
    "online_amount_minor" BIGINT,
    "bank_ref" TEXT,
    "voucher_no" TEXT,
    "receipt_no" TEXT,
    "received_by" TEXT,
    "received_at" TIMESTAMPTZ NOT NULL,
    "notes" TEXT,
    "v2_payment_id" INTEGER NOT NULL,
    "v2_student_id" INTEGER NOT NULL,
    "v2_lead_id" INTEGER NOT NULL,
    "v2_class_id" INTEGER,
    "source_system" TEXT NOT NULL DEFAULT 'v2_mis',
    "synced_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lead_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ,
    "deleted_by_id" UUID,

    CONSTRAINT "crm_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_remarks" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "v2_user_id" TEXT,
    "v2_created_at" TIMESTAMPTZ,
    "v2_updated_at" TIMESTAMPTZ,
    "v2_remark_id" INTEGER NOT NULL,
    "v2_lead_id" INTEGER NOT NULL,
    "source_system" TEXT NOT NULL DEFAULT 'v2_mis',
    "synced_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lead_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ,
    "deleted_by_id" UUID,

    CONSTRAINT "crm_remarks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_follow_ups" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "date" TIMESTAMPTZ NOT NULL,
    "status" TEXT DEFAULT 'incomplete',
    "v2_user_id" TEXT,
    "v2_created_at" TIMESTAMPTZ,
    "v2_follow_up_id" INTEGER NOT NULL,
    "v2_lead_id" INTEGER NOT NULL,
    "source_system" TEXT NOT NULL DEFAULT 'v2_mis',
    "synced_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lead_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ,
    "deleted_by_id" UUID,

    CONSTRAINT "crm_follow_ups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_call_history" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "notes" TEXT,
    "v2_user_id" TEXT,
    "v2_created_at" TIMESTAMPTZ,
    "v2_call_id" INTEGER NOT NULL,
    "v2_lead_id" INTEGER NOT NULL,
    "source_system" TEXT NOT NULL DEFAULT 'v2_mis',
    "synced_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lead_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ,
    "deleted_by_id" UUID,

    CONSTRAINT "crm_call_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_visits" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "date" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "outcome" "CrmVisitOutcome",
    "v2_user_id" TEXT,
    "v2_actor_id" TEXT,
    "v2_branch_id" INTEGER,
    "v2_campaign_id" INTEGER,
    "v2_created_at" TIMESTAMPTZ,
    "v2_updated_at" TIMESTAMPTZ,
    "v2_visit_id" INTEGER NOT NULL,
    "v2_lead_id" INTEGER NOT NULL,
    "source_system" TEXT NOT NULL DEFAULT 'v2_mis',
    "synced_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lead_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ,
    "deleted_by_id" UUID,

    CONSTRAINT "crm_visits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_assignments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "CrmAssignmentKind" NOT NULL,
    "v2_user_id" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "v2_created_at" TIMESTAMPTZ,
    "v2_updated_at" TIMESTAMPTZ,
    "v2_assignment_id" INTEGER NOT NULL,
    "v2_lead_id" INTEGER NOT NULL,
    "source_system" TEXT NOT NULL DEFAULT 'v2_mis',
    "synced_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lead_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ,
    "deleted_by_id" UUID,

    CONSTRAINT "crm_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_qualifications" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "level" "CrmQualificationLevel" NOT NULL,
    "institution_name" TEXT,
    "board_or_university" TEXT,
    "stream_or_major" TEXT,
    "grade" TEXT,
    "grade_scale" "CrmGradeScale",
    "start_year" INTEGER,
    "end_year" INTEGER,
    "is_ongoing" BOOLEAN NOT NULL DEFAULT false,
    "division" "CrmQualificationDivision",
    "notes" TEXT,
    "v2_created_at" TIMESTAMPTZ,
    "v2_updated_at" TIMESTAMPTZ,
    "v2_qualification_id" INTEGER NOT NULL,
    "v2_lead_id" INTEGER NOT NULL,
    "source_system" TEXT NOT NULL DEFAULT 'v2_mis',
    "synced_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lead_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ,
    "deleted_by_id" UUID,

    CONSTRAINT "crm_qualifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_language_tests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "test_type" "CrmLanguageTestType" NOT NULL,
    "custom_test_name" TEXT,
    "test_date" TIMESTAMPTZ,
    "overall_score" DECIMAL(7,2),
    "listening_score" DECIMAL(7,2),
    "reading_score" DECIMAL(7,2),
    "writing_score" DECIMAL(7,2),
    "speaking_score" DECIMAL(7,2),
    "extra_scores" JSONB,
    "test_center" TEXT,
    "reference_no" TEXT,
    "is_official" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "v2_created_at" TIMESTAMPTZ,
    "v2_updated_at" TIMESTAMPTZ,
    "v2_language_test_id" INTEGER NOT NULL,
    "v2_lead_id" INTEGER NOT NULL,
    "source_system" TEXT NOT NULL DEFAULT 'v2_mis',
    "synced_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lead_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ,
    "deleted_by_id" UUID,

    CONSTRAINT "crm_language_tests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_guardians" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "relationship_type" "CrmGuardianRelationshipType" NOT NULL,
    "custom_relationship_label" TEXT,
    "phone" TEXT,
    "secondary_phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "occupation" TEXT,
    "notes" TEXT,
    "v2_created_at" TIMESTAMPTZ,
    "v2_updated_at" TIMESTAMPTZ,
    "v2_guardian_id" INTEGER NOT NULL,
    "v2_lead_id" INTEGER NOT NULL,
    "source_system" TEXT NOT NULL DEFAULT 'v2_mis',
    "synced_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lead_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ,
    "deleted_by_id" UUID,

    CONSTRAINT "crm_guardians_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crm_lead_fees" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "application_id" UUID,
    "session_label" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "due_on" DATE NOT NULL,
    "status" "CrmFeeStatus" NOT NULL DEFAULT 'SCHEDULED',
    "paid_at" TIMESTAMPTZ,
    "paid_amount_minor" BIGINT,
    "notes" TEXT,
    "seeded_from_v2" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ,
    "deleted_by_id" UUID,

    CONSTRAINT "crm_lead_fees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spv_lead_overlay" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "v2_lead_id" INTEGER NOT NULL,
    "spv_status" "CrmLeadStatus" NOT NULL DEFAULT 'ACTIVE',
    "assigned_to_id" UUID,
    "spv_notes" TEXT,
    "student_id" UUID,
    "converted_at" TIMESTAMPTZ,
    "converted_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ,
    "deleted_by_id" UUID,

    CONSTRAINT "spv_lead_overlay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spv_lead_fees" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "v2_lead_id" INTEGER NOT NULL,
    "v2_application_id" INTEGER,
    "session_label" TEXT NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "due_on" DATE NOT NULL,
    "status" "CrmFeeStatus" NOT NULL DEFAULT 'SCHEDULED',
    "paid_at" TIMESTAMPTZ,
    "paid_amount_minor" BIGINT,
    "notes" TEXT,
    "seeded_from_v2" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ,
    "deleted_by_id" UUID,

    CONSTRAINT "spv_lead_fees_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_questions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "academic_level" "AcademicLevel",
    "institution_id" UUID,
    "category" "InterviewQuestionCategory" NOT NULL,
    "question_text" TEXT NOT NULL,
    "model_answer" TEXT,
    "tips" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "updated_by_id" UUID,
    "deleted_at" TIMESTAMPTZ,
    "deleted_by_id" UUID,

    CONSTRAINT "interview_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_attempts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "student_id" UUID,
    "candidate_name" TEXT NOT NULL,
    "candidate_email" TEXT NOT NULL,
    "country_code" CHAR(2) NOT NULL,
    "institution_name" TEXT NOT NULL,
    "institution_id" UUID,
    "course_name" TEXT NOT NULL,
    "academic_level" "AcademicLevel" NOT NULL,
    "intake_label" TEXT NOT NULL,
    "has_i20" BOOLEAN NOT NULL DEFAULT false,
    "question_count" INTEGER NOT NULL DEFAULT 0,
    "answered_count" INTEGER NOT NULL DEFAULT 0,
    "status" "InterviewAttemptStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "interview_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_answers" (
    "id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "question_id" UUID NOT NULL,
    "answer_text" TEXT NOT NULL,
    "answered_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "time_spent_seconds" INTEGER,

    CONSTRAINT "interview_answers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sub_processors_tenant_id_idx" ON "sub_processors"("tenant_id");

-- CreateIndex
CREATE INDEX "users_tenant_id_role_idx" ON "users"("tenant_id", "role");

-- CreateIndex
CREATE INDEX "users_deleted_at_idx" ON "users"("deleted_at");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_tenant_id_email_key" ON "users"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_idx" ON "refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_tenant_id_idx" ON "refresh_tokens"("tenant_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_user_id_last_used_at_idx" ON "refresh_tokens"("user_id", "last_used_at");

-- CreateIndex
CREATE INDEX "audit_anchors_anchored_at_idx" ON "audit_anchors"("anchored_at");

-- CreateIndex
CREATE UNIQUE INDEX "audit_anchors_tenant_id_anchored_at_key" ON "audit_anchors"("tenant_id", "anchored_at");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_expires_at_idx" ON "password_reset_tokens"("user_id", "expires_at");

-- CreateIndex
CREATE INDEX "password_reset_tokens_tenant_id_idx" ON "password_reset_tokens"("tenant_id");

-- CreateIndex
CREATE INDEX "consent_records_subject_type_subject_id_idx" ON "consent_records"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "consent_records_tenant_id_idx" ON "consent_records"("tenant_id");

-- CreateIndex
CREATE INDEX "dsar_requests_tenant_id_status_idx" ON "dsar_requests"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "dsar_requests_subject_type_subject_id_idx" ON "dsar_requests"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "breach_incidents_tenant_id_idx" ON "breach_incidents"("tenant_id");

-- CreateIndex
CREATE INDEX "breach_incidents_due_by_idx" ON "breach_incidents"("due_by");

-- CreateIndex
CREATE UNIQUE INDEX "countries_code_alpha3_key" ON "countries"("code_alpha3");

-- CreateIndex
CREATE UNIQUE INDEX "countries_numeric_code_key" ON "countries"("numeric_code");

-- CreateIndex
CREATE INDEX "airports_iata_country_code_idx" ON "airports_iata"("country_code");

-- CreateIndex
CREATE UNIQUE INDEX "visa_categories_country_code_code_key" ON "visa_categories"("country_code", "code");

-- CreateIndex
CREATE UNIQUE INDEX "relationship_types_tenant_id_key_key" ON "relationship_types"("tenant_id", "key");

-- CreateIndex
CREATE UNIQUE INDEX "document_types_tenant_id_key_key" ON "document_types"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "lifecycle_stages_tenant_id_sequence_idx" ON "lifecycle_stages"("tenant_id", "sequence");

-- CreateIndex
CREATE INDEX "lifecycle_stages_visa_type_id_idx" ON "lifecycle_stages"("visa_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "lifecycle_stages_tenant_id_key_key" ON "lifecycle_stages"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "visa_types_tenant_id_country_code_idx" ON "visa_types"("tenant_id", "country_code");

-- CreateIndex
CREATE INDEX "visa_types_is_active_idx" ON "visa_types"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "visa_types_tenant_id_country_code_name_key" ON "visa_types"("tenant_id", "country_code", "name");

-- CreateIndex
CREATE INDEX "lifecycle_stage_transitions_tenant_id_idx" ON "lifecycle_stage_transitions"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "lifecycle_stage_transitions_tenant_id_from_stage_id_to_stag_key" ON "lifecycle_stage_transitions"("tenant_id", "from_stage_id", "to_stage_id");

-- CreateIndex
CREATE INDEX "lifecycle_stage_checklist_items_stage_id_sequence_idx" ON "lifecycle_stage_checklist_items"("stage_id", "sequence");

-- CreateIndex
CREATE INDEX "lifecycle_stage_checklist_items_tenant_id_idx" ON "lifecycle_stage_checklist_items"("tenant_id");

-- CreateIndex
CREATE INDEX "student_stage_checklist_progress_tenant_id_stage_id_idx" ON "student_stage_checklist_progress"("tenant_id", "stage_id");

-- CreateIndex
CREATE UNIQUE INDEX "student_stage_checklist_progress_student_id_checklist_item__key" ON "student_stage_checklist_progress"("student_id", "checklist_item_id");

-- CreateIndex
CREATE INDEX "students_tenant_id_current_stage_id_assigned_to_id_idx" ON "students"("tenant_id", "current_stage_id", "assigned_to_id");

-- CreateIndex
CREATE INDEX "students_tenant_id_status_idx" ON "students"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "students_tenant_id_family_name_given_name_idx" ON "students"("tenant_id", "family_name", "given_name");

-- CreateIndex
CREATE INDEX "students_deleted_at_idx" ON "students"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "students_tenant_id_student_code_key" ON "students"("tenant_id", "student_code");

-- CreateIndex
CREATE UNIQUE INDEX "students_tenant_id_email_primary_key" ON "students"("tenant_id", "email_primary");

-- CreateIndex
CREATE INDEX "addresses_tenant_id_country_code_idx" ON "addresses"("tenant_id", "country_code");

-- CreateIndex
CREATE INDEX "student_addresses_student_id_type_idx" ON "student_addresses"("student_id", "type");

-- CreateIndex
CREATE INDEX "student_identifications_student_id_idx" ON "student_identifications"("student_id");

-- CreateIndex
CREATE INDEX "student_identifications_type_expires_on_idx" ON "student_identifications"("type", "expires_on");

-- CreateIndex
CREATE INDEX "student_visas_student_id_is_active_idx" ON "student_visas"("student_id", "is_active");

-- CreateIndex
CREATE INDEX "student_visas_expires_on_idx" ON "student_visas"("expires_on");

-- CreateIndex
CREATE INDEX "student_regulator_identifiers_student_id_scheme_idx" ON "student_regulator_identifiers"("student_id", "scheme");

-- CreateIndex
CREATE INDEX "compliance_checks_student_id_check_type_idx" ON "compliance_checks"("student_id", "check_type");

-- CreateIndex
CREATE INDEX "engagement_checks_student_id_check_date_idx" ON "engagement_checks"("student_id", "check_date");

-- CreateIndex
CREATE INDEX "student_employment_student_id_idx" ON "student_employment"("student_id");

-- CreateIndex
CREATE INDEX "student_dependents_student_id_idx" ON "student_dependents"("student_id");

-- CreateIndex
CREATE INDEX "academic_qualifications_student_id_level_idx" ON "academic_qualifications"("student_id", "level");

-- CreateIndex
CREATE INDEX "language_test_results_student_id_test_type_idx" ON "language_test_results"("student_id", "test_type");

-- CreateIndex
CREATE UNIQUE INDEX "language_test_results_student_id_test_type_test_date_key" ON "language_test_results"("student_id", "test_type", "test_date");

-- CreateIndex
CREATE INDEX "student_contacts_student_id_is_primary_guardian_idx" ON "student_contacts"("student_id", "is_primary_guardian");

-- CreateIndex
CREATE INDEX "student_contacts_student_id_is_emergency_contact_idx" ON "student_contacts"("student_id", "is_emergency_contact");

-- CreateIndex
CREATE INDEX "sponsors_tenant_id_idx" ON "sponsors"("tenant_id");

-- CreateIndex
CREATE INDEX "student_sponsorships_student_id_idx" ON "student_sponsorships"("student_id");

-- CreateIndex
CREATE INDEX "student_sponsorships_sponsor_id_idx" ON "student_sponsorships"("sponsor_id");

-- CreateIndex
CREATE INDEX "institutions_tenant_id_country_code_idx" ON "institutions"("tenant_id", "country_code");

-- CreateIndex
CREATE INDEX "institutions_tenant_id_is_partner_idx" ON "institutions"("tenant_id", "is_partner");

-- CreateIndex
CREATE INDEX "institutions_deleted_at_idx" ON "institutions"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "institutions_tenant_id_legal_name_country_code_key" ON "institutions"("tenant_id", "legal_name", "country_code");

-- CreateIndex
CREATE INDEX "institution_identifiers_scheme_value_idx" ON "institution_identifiers"("scheme", "value");

-- CreateIndex
CREATE UNIQUE INDEX "institution_identifiers_institution_id_scheme_key" ON "institution_identifiers"("institution_id", "scheme");

-- CreateIndex
CREATE INDEX "institution_accreditations_institution_id_idx" ON "institution_accreditations"("institution_id");

-- CreateIndex
CREATE INDEX "institution_contacts_institution_id_idx" ON "institution_contacts"("institution_id");

-- CreateIndex
CREATE UNIQUE INDEX "campuses_institution_id_name_key" ON "campuses"("institution_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "schools_institution_id_name_key" ON "schools"("institution_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "departments_school_id_name_key" ON "departments"("school_id", "name");

-- CreateIndex
CREATE INDEX "programs_institution_id_is_active_idx" ON "programs"("institution_id", "is_active");

-- CreateIndex
CREATE INDEX "programs_level_field_of_study_idx" ON "programs"("level", "field_of_study");

-- CreateIndex
CREATE UNIQUE INDEX "programs_institution_id_name_level_key" ON "programs"("institution_id", "name", "level");

-- CreateIndex
CREATE INDEX "program_intakes_program_id_intake_year_intake_month_idx" ON "program_intakes"("program_id", "intake_year", "intake_month");

-- CreateIndex
CREATE UNIQUE INDEX "program_intakes_program_id_campus_id_intake_year_intake_mon_key" ON "program_intakes"("program_id", "campus_id", "intake_year", "intake_month");

-- CreateIndex
CREATE INDEX "program_requirements_program_id_category_idx" ON "program_requirements"("program_id", "category");

-- CreateIndex
CREATE INDEX "program_modules_program_id_idx" ON "program_modules"("program_id");

-- CreateIndex
CREATE UNIQUE INDEX "program_modules_program_id_code_key" ON "program_modules"("program_id", "code");

-- CreateIndex
CREATE INDEX "program_fees_program_intake_id_audience_fee_type_idx" ON "program_fees"("program_intake_id", "audience", "fee_type");

-- CreateIndex
CREATE INDEX "enrollments_student_id_idx" ON "enrollments"("student_id");

-- CreateIndex
CREATE INDEX "enrollments_institution_id_program_id_idx" ON "enrollments"("institution_id", "program_id");

-- CreateIndex
CREATE INDEX "enrollments_program_intake_id_idx" ON "enrollments"("program_intake_id");

-- CreateIndex
CREATE INDEX "enrollments_super_agent_id_idx" ON "enrollments"("super_agent_id");

-- CreateIndex
CREATE INDEX "enrollments_deleted_at_idx" ON "enrollments"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "super_agent_types_tenant_id_key_key" ON "super_agent_types"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "super_agents_tenant_id_status_idx" ON "super_agents"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "super_agents_tenant_id_type_id_idx" ON "super_agents"("tenant_id", "type_id");

-- CreateIndex
CREATE UNIQUE INDEX "super_agents_tenant_id_name_key" ON "super_agents"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "super_agent_contacts_super_agent_id_idx" ON "super_agent_contacts"("super_agent_id");

-- CreateIndex
CREATE INDEX "super_agent_commission_rules_tenant_id_super_agent_id_effec_idx" ON "super_agent_commission_rules"("tenant_id", "super_agent_id", "effective_from");

-- CreateIndex
CREATE INDEX "super_agent_commission_rules_tenant_id_institution_id_effec_idx" ON "super_agent_commission_rules"("tenant_id", "institution_id", "effective_from");

-- CreateIndex
CREATE INDEX "institution_super_agents_tenant_id_institution_id_idx" ON "institution_super_agents"("tenant_id", "institution_id");

-- CreateIndex
CREATE INDEX "institution_super_agents_super_agent_id_idx" ON "institution_super_agents"("super_agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "institution_super_agents_institution_id_super_agent_id_key" ON "institution_super_agents"("institution_id", "super_agent_id");

-- CreateIndex
CREATE INDEX "travel_records_student_id_departure_at_idx" ON "travel_records"("student_id", "departure_at");

-- CreateIndex
CREATE INDEX "accommodations_student_id_is_current_idx" ON "accommodations"("student_id", "is_current");

-- CreateIndex
CREATE INDEX "insurance_records_student_id_idx" ON "insurance_records"("student_id");

-- CreateIndex
CREATE INDEX "insurance_records_ends_on_idx" ON "insurance_records"("ends_on");

-- CreateIndex
CREATE INDEX "insurance_records_tenant_id_ends_on_idx" ON "insurance_records"("tenant_id", "ends_on");

-- CreateIndex
CREATE INDEX "finance_items_student_id_status_idx" ON "finance_items"("student_id", "status");

-- CreateIndex
CREATE INDEX "finance_items_enrollment_id_idx" ON "finance_items"("enrollment_id");

-- CreateIndex
CREATE INDEX "finance_items_tenant_id_status_due_on_idx" ON "finance_items"("tenant_id", "status", "due_on");

-- CreateIndex
CREATE UNIQUE INDEX "documents_storage_key_key" ON "documents"("storage_key");

-- CreateIndex
CREATE INDEX "documents_student_id_document_type_id_idx" ON "documents"("student_id", "document_type_id");

-- CreateIndex
CREATE INDEX "documents_sha256_idx" ON "documents"("sha256");

-- CreateIndex
CREATE INDEX "documents_tenant_id_expires_on_idx" ON "documents"("tenant_id", "expires_on");

-- CreateIndex
CREATE INDEX "documents_tenant_id_retention_until_idx" ON "documents"("tenant_id", "retention_until");

-- CreateIndex
CREATE UNIQUE INDEX "message_templates_tenant_id_key_channel_key" ON "message_templates"("tenant_id", "key", "channel");

-- CreateIndex
CREATE INDEX "comms_threads_student_id_channel_idx" ON "comms_threads"("student_id", "channel");

-- CreateIndex
CREATE INDEX "comms_threads_tenant_id_channel_idx" ON "comms_threads"("tenant_id", "channel");

-- CreateIndex
CREATE INDEX "comms_messages_tenant_id_thread_id_created_at_idx" ON "comms_messages"("tenant_id", "thread_id", "created_at");

-- CreateIndex
CREATE INDEX "comms_messages_thread_id_idx" ON "comms_messages"("thread_id");

-- CreateIndex
CREATE INDEX "comms_messages_tenant_id_recipient_user_id_read_at_idx" ON "comms_messages"("tenant_id", "recipient_user_id", "read_at");

-- CreateIndex
CREATE INDEX "comms_messages_status_next_retry_at_idx" ON "comms_messages"("status", "next_retry_at");

-- CreateIndex
CREATE UNIQUE INDEX "tags_tenant_id_key_key" ON "tags"("tenant_id", "key");

-- CreateIndex
CREATE INDEX "entity_tags_entity_type_entity_id_idx" ON "entity_tags"("entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "entity_tags_tag_id_entity_type_entity_id_key" ON "entity_tags"("tag_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "notes_entity_type_entity_id_created_at_idx" ON "notes"("entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "attribute_definitions_tenant_id_entity_type_key_key" ON "attribute_definitions"("tenant_id", "entity_type", "key");

-- CreateIndex
CREATE INDEX "entity_attributes_entity_type_entity_id_idx" ON "entity_attributes"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "saved_views_tenant_id_resource_idx" ON "saved_views"("tenant_id", "resource");

-- CreateIndex
CREATE INDEX "student_lifecycle_events_student_id_occurred_at_idx" ON "student_lifecycle_events"("student_id", "occurred_at");

-- CreateIndex
CREATE INDEX "student_lifecycle_events_tenant_id_to_stage_id_occurred_at_idx" ON "student_lifecycle_events"("tenant_id", "to_stage_id", "occurred_at");

-- CreateIndex
CREATE INDEX "student_lifecycle_events_tenant_occurred_idx" ON "student_lifecycle_events"("tenant_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_entity_type_entity_id_idx" ON "audit_logs"("tenant_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_created_at_idx" ON "audit_logs"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_created_at_id_idx" ON "audit_logs"("tenant_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "import_jobs_tenant_id_resource_created_at_idx" ON "import_jobs"("tenant_id", "resource", "created_at");

-- CreateIndex
CREATE INDEX "import_jobs_tenant_resource_created_desc_idx" ON "import_jobs"("tenant_id", "resource", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "import_mapping_templates_tenant_id_resource_name_key" ON "import_mapping_templates"("tenant_id", "resource", "name");

-- CreateIndex
CREATE INDEX "export_jobs_tenant_id_resource_created_at_idx" ON "export_jobs"("tenant_id", "resource", "created_at");

-- CreateIndex
CREATE INDEX "export_jobs_tenant_resource_created_desc_idx" ON "export_jobs"("tenant_id", "resource", "created_at" DESC);

-- CreateIndex
CREATE INDEX "external_ids_entity_type_entity_id_idx" ON "external_ids"("entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_ids_tenant_id_entity_type_external_id_key" ON "external_ids"("tenant_id", "entity_type", "external_id");

-- CreateIndex
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_tenant_id_user_id_scope_key_key" ON "idempotency_records"("tenant_id", "user_id", "scope", "key");

-- CreateIndex
CREATE INDEX "reminders_tenant_id_status_scheduled_for_idx" ON "reminders"("tenant_id", "status", "scheduled_for");

-- CreateIndex
CREATE INDEX "reminders_tenant_id_assigned_to_id_status_idx" ON "reminders"("tenant_id", "assigned_to_id", "status");

-- CreateIndex
CREATE INDEX "reminders_student_id_status_idx" ON "reminders"("student_id", "status");

-- CreateIndex
CREATE INDEX "reminders_enrollment_id_idx" ON "reminders"("enrollment_id");

-- CreateIndex
CREATE INDEX "reminders_source_entity_type_source_entity_id_idx" ON "reminders"("source_entity_type", "source_entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "reminders_tenant_id_source_entity_type_source_entity_id_sch_key" ON "reminders"("tenant_id", "source_entity_type", "source_entity_id", "scheduled_for");

-- CreateIndex
CREATE UNIQUE INDEX "commission_claims_enrollment_id_key" ON "commission_claims"("enrollment_id");

-- CreateIndex
CREATE INDEX "commission_claims_tenant_id_institution_id_status_idx" ON "commission_claims"("tenant_id", "institution_id", "status");

-- CreateIndex
CREATE INDEX "commission_claims_tenant_id_status_claimed_on_idx" ON "commission_claims"("tenant_id", "status", "claimed_on");

-- CreateIndex
CREATE INDEX "commission_claims_student_id_idx" ON "commission_claims"("student_id");

-- CreateIndex
CREATE INDEX "commission_claims_super_agent_id_idx" ON "commission_claims"("super_agent_id");

-- CreateIndex
CREATE INDEX "job_runs_job_name_started_at_idx" ON "job_runs"("job_name", "started_at" DESC);

-- CreateIndex
CREATE INDEX "fee_plans_tenant_id_status_idx" ON "fee_plans"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "fee_plans_tenant_id_enrollment_id_idx" ON "fee_plans"("tenant_id", "enrollment_id");

-- CreateIndex
CREATE INDEX "fee_installments_tenant_id_status_due_on_idx" ON "fee_installments"("tenant_id", "status", "due_on");

-- CreateIndex
CREATE INDEX "fee_installments_tenant_id_due_on_idx" ON "fee_installments"("tenant_id", "due_on");

-- CreateIndex
CREATE UNIQUE INDEX "fee_installments_fee_plan_id_sequence_no_key" ON "fee_installments"("fee_plan_id", "sequence_no");

-- CreateIndex
CREATE INDEX "payments_tenant_id_student_id_received_on_idx" ON "payments"("tenant_id", "student_id", "received_on" DESC);

-- CreateIndex
CREATE INDEX "payments_tenant_id_enrollment_id_status_idx" ON "payments"("tenant_id", "enrollment_id", "status");

-- CreateIndex
CREATE INDEX "payments_tenant_id_status_received_on_idx" ON "payments"("tenant_id", "status", "received_on");

-- CreateIndex
CREATE UNIQUE INDEX "payments_tenant_id_receipt_no_key" ON "payments"("tenant_id", "receipt_no");

-- CreateIndex
CREATE INDEX "payment_allocations_tenant_id_payment_id_idx" ON "payment_allocations"("tenant_id", "payment_id");

-- CreateIndex
CREATE INDEX "payment_allocations_tenant_id_fee_installment_id_idx" ON "payment_allocations"("tenant_id", "fee_installment_id");

-- CreateIndex
CREATE INDEX "fee_adjustments_tenant_id_fee_installment_id_idx" ON "fee_adjustments"("tenant_id", "fee_installment_id");

-- CreateIndex
CREATE INDEX "fee_adjustments_tenant_id_kind_applied_on_idx" ON "fee_adjustments"("tenant_id", "kind", "applied_on");

-- CreateIndex
CREATE INDEX "refunds_tenant_id_payment_id_idx" ON "refunds"("tenant_id", "payment_id");

-- CreateIndex
CREATE INDEX "refunds_tenant_id_status_idx" ON "refunds"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "refunds_tenant_id_status_refunded_on_idx" ON "refunds"("tenant_id", "status", "refunded_on");

-- CreateIndex
CREATE INDEX "student_credits_tenant_id_student_id_idx" ON "student_credits"("tenant_id", "student_id");

-- CreateIndex
CREATE INDEX "student_credits_tenant_id_enrollment_id_idx" ON "student_credits"("tenant_id", "enrollment_id");

-- CreateIndex
CREATE INDEX "crm_countries_tenant_id_name_idx" ON "crm_countries"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "crm_countries_deleted_at_idx" ON "crm_countries"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "crm_countries_tenant_id_v2_country_id_key" ON "crm_countries"("tenant_id", "v2_country_id");

-- CreateIndex
CREATE INDEX "crm_institutions_tenant_id_name_idx" ON "crm_institutions"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "crm_institutions_country_id_idx" ON "crm_institutions"("country_id");

-- CreateIndex
CREATE INDEX "crm_institutions_deleted_at_idx" ON "crm_institutions"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "crm_institutions_tenant_id_v2_institution_id_key" ON "crm_institutions"("tenant_id", "v2_institution_id");

-- CreateIndex
CREATE INDEX "crm_courses_tenant_id_name_idx" ON "crm_courses"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "crm_courses_institution_id_idx" ON "crm_courses"("institution_id");

-- CreateIndex
CREATE INDEX "crm_courses_deleted_at_idx" ON "crm_courses"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "crm_courses_tenant_id_v2_course_id_key" ON "crm_courses"("tenant_id", "v2_course_id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_leads_student_id_key" ON "crm_leads"("student_id");

-- CreateIndex
CREATE INDEX "crm_leads_tenant_id_is_archived_idx" ON "crm_leads"("tenant_id", "is_archived");

-- CreateIndex
CREATE INDEX "crm_leads_tenant_id_assigned_to_id_idx" ON "crm_leads"("tenant_id", "assigned_to_id");

-- CreateIndex
CREATE INDEX "crm_leads_tenant_id_last_name_first_name_idx" ON "crm_leads"("tenant_id", "last_name", "first_name");

-- CreateIndex
CREATE INDEX "crm_leads_phone_number_idx" ON "crm_leads"("phone_number");

-- CreateIndex
CREATE INDEX "crm_leads_email_idx" ON "crm_leads"("email");

-- CreateIndex
CREATE INDEX "crm_leads_deleted_at_idx" ON "crm_leads"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "crm_leads_tenant_id_v2_lead_id_key" ON "crm_leads"("tenant_id", "v2_lead_id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_leads_tenant_id_phone_number_key" ON "crm_leads"("tenant_id", "phone_number");

-- CreateIndex
CREATE INDEX "crm_applications_lead_id_idx" ON "crm_applications"("lead_id");

-- CreateIndex
CREATE INDEX "crm_applications_course_id_idx" ON "crm_applications"("course_id");

-- CreateIndex
CREATE INDEX "crm_applications_state_idx" ON "crm_applications"("state");

-- CreateIndex
CREATE INDEX "crm_applications_deleted_at_idx" ON "crm_applications"("deleted_at");

-- CreateIndex
CREATE INDEX "crm_applications_tenant_id_v2_lead_id_v2_course_id_idx" ON "crm_applications"("tenant_id", "v2_lead_id", "v2_course_id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_applications_tenant_id_v2_application_id_key" ON "crm_applications"("tenant_id", "v2_application_id");

-- CreateIndex
CREATE UNIQUE INDEX "crm_applications_tenant_id_lead_id_course_id_intake_key_key" ON "crm_applications"("tenant_id", "lead_id", "course_id", "intake_key");

-- CreateIndex
CREATE INDEX "crm_lead_courses_lead_id_idx" ON "crm_lead_courses"("lead_id");

-- CreateIndex
CREATE INDEX "crm_lead_courses_course_id_idx" ON "crm_lead_courses"("course_id");

-- CreateIndex
CREATE INDEX "crm_lead_courses_state_v2_idx" ON "crm_lead_courses"("state_v2");

-- CreateIndex
CREATE INDEX "crm_lead_courses_deleted_at_idx" ON "crm_lead_courses"("deleted_at");

-- CreateIndex
CREATE INDEX "crm_lead_courses_tenant_id_state_v2_deleted_at_idx" ON "crm_lead_courses"("tenant_id", "state_v2", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "crm_lead_courses_tenant_id_v2_lead_id_v2_course_id_key" ON "crm_lead_courses"("tenant_id", "v2_lead_id", "v2_course_id");

-- CreateIndex
CREATE INDEX "crm_lead_course_history_lead_id_course_id_idx" ON "crm_lead_course_history"("lead_id", "course_id");

-- CreateIndex
CREATE INDEX "crm_lead_course_history_to_state_changed_at_idx" ON "crm_lead_course_history"("to_state", "changed_at");

-- CreateIndex
CREATE UNIQUE INDEX "crm_lead_course_history_tenant_id_v2_history_id_key" ON "crm_lead_course_history"("tenant_id", "v2_history_id");

-- CreateIndex
CREATE INDEX "crm_payments_lead_id_idx" ON "crm_payments"("lead_id");

-- CreateIndex
CREATE INDEX "crm_payments_tenant_id_received_at_idx" ON "crm_payments"("tenant_id", "received_at");

-- CreateIndex
CREATE INDEX "crm_payments_deleted_at_idx" ON "crm_payments"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "crm_payments_tenant_id_v2_payment_id_key" ON "crm_payments"("tenant_id", "v2_payment_id");

-- CreateIndex
CREATE INDEX "crm_remarks_lead_id_v2_created_at_idx" ON "crm_remarks"("lead_id", "v2_created_at");

-- CreateIndex
CREATE INDEX "crm_remarks_deleted_at_idx" ON "crm_remarks"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "crm_remarks_tenant_id_v2_remark_id_key" ON "crm_remarks"("tenant_id", "v2_remark_id");

-- CreateIndex
CREATE INDEX "crm_follow_ups_lead_id_date_idx" ON "crm_follow_ups"("lead_id", "date");

-- CreateIndex
CREATE INDEX "crm_follow_ups_status_idx" ON "crm_follow_ups"("status");

-- CreateIndex
CREATE INDEX "crm_follow_ups_deleted_at_idx" ON "crm_follow_ups"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "crm_follow_ups_tenant_id_v2_follow_up_id_key" ON "crm_follow_ups"("tenant_id", "v2_follow_up_id");

-- CreateIndex
CREATE INDEX "crm_call_history_lead_id_v2_created_at_idx" ON "crm_call_history"("lead_id", "v2_created_at");

-- CreateIndex
CREATE INDEX "crm_call_history_status_idx" ON "crm_call_history"("status");

-- CreateIndex
CREATE INDEX "crm_call_history_deleted_at_idx" ON "crm_call_history"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "crm_call_history_tenant_id_v2_call_id_key" ON "crm_call_history"("tenant_id", "v2_call_id");

-- CreateIndex
CREATE INDEX "crm_visits_lead_id_v2_created_at_idx" ON "crm_visits"("lead_id", "v2_created_at");

-- CreateIndex
CREATE INDEX "crm_visits_outcome_idx" ON "crm_visits"("outcome");

-- CreateIndex
CREATE INDEX "crm_visits_deleted_at_idx" ON "crm_visits"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "crm_visits_tenant_id_v2_visit_id_key" ON "crm_visits"("tenant_id", "v2_visit_id");

-- CreateIndex
CREATE INDEX "crm_assignments_lead_id_kind_is_active_idx" ON "crm_assignments"("lead_id", "kind", "is_active");

-- CreateIndex
CREATE INDEX "crm_assignments_deleted_at_idx" ON "crm_assignments"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "crm_assignments_tenant_id_kind_v2_assignment_id_key" ON "crm_assignments"("tenant_id", "kind", "v2_assignment_id");

-- CreateIndex
CREATE INDEX "crm_qualifications_lead_id_level_idx" ON "crm_qualifications"("lead_id", "level");

-- CreateIndex
CREATE INDEX "crm_qualifications_deleted_at_idx" ON "crm_qualifications"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "crm_qualifications_tenant_id_v2_qualification_id_key" ON "crm_qualifications"("tenant_id", "v2_qualification_id");

-- CreateIndex
CREATE INDEX "crm_language_tests_lead_id_test_type_idx" ON "crm_language_tests"("lead_id", "test_type");

-- CreateIndex
CREATE INDEX "crm_language_tests_deleted_at_idx" ON "crm_language_tests"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "crm_language_tests_tenant_id_v2_language_test_id_key" ON "crm_language_tests"("tenant_id", "v2_language_test_id");

-- CreateIndex
CREATE INDEX "crm_guardians_lead_id_relationship_type_idx" ON "crm_guardians"("lead_id", "relationship_type");

-- CreateIndex
CREATE INDEX "crm_guardians_deleted_at_idx" ON "crm_guardians"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "crm_guardians_tenant_id_v2_guardian_id_key" ON "crm_guardians"("tenant_id", "v2_guardian_id");

-- CreateIndex
CREATE INDEX "crm_lead_fees_tenant_id_status_due_on_idx" ON "crm_lead_fees"("tenant_id", "status", "due_on");

-- CreateIndex
CREATE INDEX "crm_lead_fees_tenant_id_lead_id_idx" ON "crm_lead_fees"("tenant_id", "lead_id");

-- CreateIndex
CREATE INDEX "crm_lead_fees_deleted_at_idx" ON "crm_lead_fees"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "spv_lead_overlay_student_id_key" ON "spv_lead_overlay"("student_id");

-- CreateIndex
CREATE INDEX "spv_lead_overlay_tenant_id_assigned_to_id_idx" ON "spv_lead_overlay"("tenant_id", "assigned_to_id");

-- CreateIndex
CREATE INDEX "spv_lead_overlay_deleted_at_idx" ON "spv_lead_overlay"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "spv_lead_overlay_tenant_id_v2_lead_id_key" ON "spv_lead_overlay"("tenant_id", "v2_lead_id");

-- CreateIndex
CREATE INDEX "spv_lead_fees_tenant_id_status_due_on_idx" ON "spv_lead_fees"("tenant_id", "status", "due_on");

-- CreateIndex
CREATE INDEX "spv_lead_fees_tenant_id_v2_lead_id_idx" ON "spv_lead_fees"("tenant_id", "v2_lead_id");

-- CreateIndex
CREATE INDEX "spv_lead_fees_deleted_at_idx" ON "spv_lead_fees"("deleted_at");

-- CreateIndex
CREATE INDEX "interview_questions_tenant_id_country_code_is_active_idx" ON "interview_questions"("tenant_id", "country_code", "is_active");

-- CreateIndex
CREATE INDEX "interview_questions_tenant_id_institution_id_idx" ON "interview_questions"("tenant_id", "institution_id");

-- CreateIndex
CREATE INDEX "interview_questions_deleted_at_idx" ON "interview_questions"("deleted_at");

-- CreateIndex
CREATE INDEX "interview_attempts_tenant_id_status_idx" ON "interview_attempts"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "interview_attempts_tenant_id_candidate_email_idx" ON "interview_attempts"("tenant_id", "candidate_email");

-- CreateIndex
CREATE INDEX "interview_attempts_student_id_idx" ON "interview_attempts"("student_id");

-- CreateIndex
CREATE INDEX "interview_answers_attempt_id_idx" ON "interview_answers"("attempt_id");

-- CreateIndex
CREATE UNIQUE INDEX "interview_answers_attempt_id_question_id_key" ON "interview_answers"("attempt_id", "question_id");

-- AddForeignKey
ALTER TABLE "sub_processors" ADD CONSTRAINT "sub_processors_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_anchors" ADD CONSTRAINT "audit_anchors_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dsar_requests" ADD CONSTRAINT "dsar_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "airports_iata" ADD CONSTRAINT "airports_iata_country_code_fkey" FOREIGN KEY ("country_code") REFERENCES "countries"("code_alpha2") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visa_categories" ADD CONSTRAINT "visa_categories_country_code_fkey" FOREIGN KEY ("country_code") REFERENCES "countries"("code_alpha2") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lifecycle_stages" ADD CONSTRAINT "lifecycle_stages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lifecycle_stages" ADD CONSTRAINT "lifecycle_stages_visa_type_id_fkey" FOREIGN KEY ("visa_type_id") REFERENCES "visa_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lifecycle_stage_transitions" ADD CONSTRAINT "lifecycle_stage_transitions_from_stage_id_fkey" FOREIGN KEY ("from_stage_id") REFERENCES "lifecycle_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lifecycle_stage_transitions" ADD CONSTRAINT "lifecycle_stage_transitions_to_stage_id_fkey" FOREIGN KEY ("to_stage_id") REFERENCES "lifecycle_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lifecycle_stage_checklist_items" ADD CONSTRAINT "lifecycle_stage_checklist_items_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "lifecycle_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_stage_checklist_progress" ADD CONSTRAINT "student_stage_checklist_progress_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_stage_checklist_progress" ADD CONSTRAINT "student_stage_checklist_progress_checklist_item_id_fkey" FOREIGN KEY ("checklist_item_id") REFERENCES "lifecycle_stage_checklist_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_current_stage_id_fkey" FOREIGN KEY ("current_stage_id") REFERENCES "lifecycle_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_nationality_code_fkey" FOREIGN KEY ("nationality_code") REFERENCES "countries"("code_alpha2") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_country_code_fkey" FOREIGN KEY ("country_code") REFERENCES "countries"("code_alpha2") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_addresses" ADD CONSTRAINT "student_addresses_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_addresses" ADD CONSTRAINT "student_addresses_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "addresses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_identifications" ADD CONSTRAINT "student_identifications_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_visas" ADD CONSTRAINT "student_visas_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_visas" ADD CONSTRAINT "student_visas_visa_category_id_fkey" FOREIGN KEY ("visa_category_id") REFERENCES "visa_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_visas" ADD CONSTRAINT "student_visas_destination_country_fkey" FOREIGN KEY ("destination_country") REFERENCES "countries"("code_alpha2") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_regulator_identifiers" ADD CONSTRAINT "student_regulator_identifiers_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compliance_checks" ADD CONSTRAINT "compliance_checks_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "engagement_checks" ADD CONSTRAINT "engagement_checks_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_employment" ADD CONSTRAINT "student_employment_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_employment" ADD CONSTRAINT "student_employment_employer_address_id_fkey" FOREIGN KEY ("employer_address_id") REFERENCES "addresses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_dependents" ADD CONSTRAINT "student_dependents_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_dependents" ADD CONSTRAINT "student_dependents_relationship_id_fkey" FOREIGN KEY ("relationship_id") REFERENCES "relationship_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "academic_qualifications" ADD CONSTRAINT "academic_qualifications_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "language_test_results" ADD CONSTRAINT "language_test_results_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_contacts" ADD CONSTRAINT "student_contacts_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_contacts" ADD CONSTRAINT "student_contacts_relationship_id_fkey" FOREIGN KEY ("relationship_id") REFERENCES "relationship_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_contacts" ADD CONSTRAINT "student_contacts_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "addresses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sponsors" ADD CONSTRAINT "sponsors_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "addresses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_sponsorships" ADD CONSTRAINT "student_sponsorships_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_sponsorships" ADD CONSTRAINT "student_sponsorships_sponsor_id_fkey" FOREIGN KEY ("sponsor_id") REFERENCES "sponsors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institutions" ADD CONSTRAINT "institutions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institutions" ADD CONSTRAINT "institutions_country_code_fkey" FOREIGN KEY ("country_code") REFERENCES "countries"("code_alpha2") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institutions" ADD CONSTRAINT "institutions_primary_address_id_fkey" FOREIGN KEY ("primary_address_id") REFERENCES "addresses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institution_identifiers" ADD CONSTRAINT "institution_identifiers_institution_id_fkey" FOREIGN KEY ("institution_id") REFERENCES "institutions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institution_accreditations" ADD CONSTRAINT "institution_accreditations_institution_id_fkey" FOREIGN KEY ("institution_id") REFERENCES "institutions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institution_contacts" ADD CONSTRAINT "institution_contacts_institution_id_fkey" FOREIGN KEY ("institution_id") REFERENCES "institutions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campuses" ADD CONSTRAINT "campuses_institution_id_fkey" FOREIGN KEY ("institution_id") REFERENCES "institutions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campuses" ADD CONSTRAINT "campuses_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "addresses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schools" ADD CONSTRAINT "schools_institution_id_fkey" FOREIGN KEY ("institution_id") REFERENCES "institutions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "departments" ADD CONSTRAINT "departments_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "programs" ADD CONSTRAINT "programs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "programs" ADD CONSTRAINT "programs_institution_id_fkey" FOREIGN KEY ("institution_id") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "programs" ADD CONSTRAINT "programs_school_id_fkey" FOREIGN KEY ("school_id") REFERENCES "schools"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "programs" ADD CONSTRAINT "programs_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_intakes" ADD CONSTRAINT "program_intakes_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_intakes" ADD CONSTRAINT "program_intakes_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "campuses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_requirements" ADD CONSTRAINT "program_requirements_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_modules" ADD CONSTRAINT "program_modules_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_fees" ADD CONSTRAINT "program_fees_program_intake_id_fkey" FOREIGN KEY ("program_intake_id") REFERENCES "program_intakes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "program_fees" ADD CONSTRAINT "program_fees_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_institution_id_fkey" FOREIGN KEY ("institution_id") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_program_intake_id_fkey" FOREIGN KEY ("program_intake_id") REFERENCES "program_intakes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_campus_id_fkey" FOREIGN KEY ("campus_id") REFERENCES "campuses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_super_agent_id_fkey" FOREIGN KEY ("super_agent_id") REFERENCES "super_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "super_agent_types" ADD CONSTRAINT "super_agent_types_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "super_agents" ADD CONSTRAINT "super_agents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "super_agents" ADD CONSTRAINT "super_agents_type_id_fkey" FOREIGN KEY ("type_id") REFERENCES "super_agent_types"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "super_agents" ADD CONSTRAINT "super_agents_sub_processor_id_fkey" FOREIGN KEY ("sub_processor_id") REFERENCES "sub_processors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "super_agent_contacts" ADD CONSTRAINT "super_agent_contacts_super_agent_id_fkey" FOREIGN KEY ("super_agent_id") REFERENCES "super_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "super_agent_commission_rules" ADD CONSTRAINT "super_agent_commission_rules_super_agent_id_fkey" FOREIGN KEY ("super_agent_id") REFERENCES "super_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "super_agent_commission_rules" ADD CONSTRAINT "super_agent_commission_rules_institution_id_fkey" FOREIGN KEY ("institution_id") REFERENCES "institutions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institution_super_agents" ADD CONSTRAINT "institution_super_agents_institution_id_fkey" FOREIGN KEY ("institution_id") REFERENCES "institutions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "institution_super_agents" ADD CONSTRAINT "institution_super_agents_super_agent_id_fkey" FOREIGN KEY ("super_agent_id") REFERENCES "super_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "travel_records" ADD CONSTRAINT "travel_records_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accommodations" ADD CONSTRAINT "accommodations_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accommodations" ADD CONSTRAINT "accommodations_address_id_fkey" FOREIGN KEY ("address_id") REFERENCES "addresses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "insurance_records" ADD CONSTRAINT "insurance_records_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_items" ADD CONSTRAINT "finance_items_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_items" ADD CONSTRAINT "finance_items_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finance_items" ADD CONSTRAINT "finance_items_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_document_type_id_fkey" FOREIGN KEY ("document_type_id") REFERENCES "document_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "lifecycle_stages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comms_threads" ADD CONSTRAINT "comms_threads_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comms_messages" ADD CONSTRAINT "comms_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "comms_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comms_messages" ADD CONSTRAINT "comms_messages_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "message_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comms_messages" ADD CONSTRAINT "comms_messages_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_tags" ADD CONSTRAINT "entity_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_attributes" ADD CONSTRAINT "entity_attributes_definition_id_fkey" FOREIGN KEY ("definition_id") REFERENCES "attribute_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_lifecycle_events" ADD CONSTRAINT "student_lifecycle_events_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_lifecycle_events" ADD CONSTRAINT "student_lifecycle_events_to_stage_id_fkey" FOREIGN KEY ("to_stage_id") REFERENCES "lifecycle_stages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_lifecycle_events" ADD CONSTRAINT "student_lifecycle_events_from_stage_id_fkey" FOREIGN KEY ("from_stage_id") REFERENCES "lifecycle_stages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_claims" ADD CONSTRAINT "commission_claims_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_claims" ADD CONSTRAINT "commission_claims_institution_id_fkey" FOREIGN KEY ("institution_id") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_claims" ADD CONSTRAINT "commission_claims_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_claims" ADD CONSTRAINT "commission_claims_currency_fkey" FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_claims" ADD CONSTRAINT "commission_claims_super_agent_id_fkey" FOREIGN KEY ("super_agent_id") REFERENCES "super_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_plans" ADD CONSTRAINT "fee_plans_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_plans" ADD CONSTRAINT "fee_plans_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_plans" ADD CONSTRAINT "fee_plans_superseded_by_id_fkey" FOREIGN KEY ("superseded_by_id") REFERENCES "fee_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_installments" ADD CONSTRAINT "fee_installments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_installments" ADD CONSTRAINT "fee_installments_fee_plan_id_fkey" FOREIGN KEY ("fee_plan_id") REFERENCES "fee_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_fee_installment_id_fkey" FOREIGN KEY ("fee_installment_id") REFERENCES "fee_installments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fee_adjustments" ADD CONSTRAINT "fee_adjustments_fee_installment_id_fkey" FOREIGN KEY ("fee_installment_id") REFERENCES "fee_installments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_credits" ADD CONSTRAINT "student_credits_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_credits" ADD CONSTRAINT "student_credits_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_credits" ADD CONSTRAINT "student_credits_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "enrollments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_countries" ADD CONSTRAINT "crm_countries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_institutions" ADD CONSTRAINT "crm_institutions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_institutions" ADD CONSTRAINT "crm_institutions_country_id_fkey" FOREIGN KEY ("country_id") REFERENCES "crm_countries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_courses" ADD CONSTRAINT "crm_courses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_courses" ADD CONSTRAINT "crm_courses_institution_id_fkey" FOREIGN KEY ("institution_id") REFERENCES "crm_institutions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_applications" ADD CONSTRAINT "crm_applications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_applications" ADD CONSTRAINT "crm_applications_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "crm_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_applications" ADD CONSTRAINT "crm_applications_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "crm_courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_lead_courses" ADD CONSTRAINT "crm_lead_courses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_lead_courses" ADD CONSTRAINT "crm_lead_courses_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "crm_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_lead_courses" ADD CONSTRAINT "crm_lead_courses_course_id_fkey" FOREIGN KEY ("course_id") REFERENCES "crm_courses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_lead_course_history" ADD CONSTRAINT "crm_lead_course_history_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_lead_course_history" ADD CONSTRAINT "crm_lead_course_history_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "crm_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_payments" ADD CONSTRAINT "crm_payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_payments" ADD CONSTRAINT "crm_payments_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "crm_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_remarks" ADD CONSTRAINT "crm_remarks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_remarks" ADD CONSTRAINT "crm_remarks_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "crm_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_follow_ups" ADD CONSTRAINT "crm_follow_ups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_follow_ups" ADD CONSTRAINT "crm_follow_ups_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "crm_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_call_history" ADD CONSTRAINT "crm_call_history_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_call_history" ADD CONSTRAINT "crm_call_history_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "crm_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_visits" ADD CONSTRAINT "crm_visits_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_visits" ADD CONSTRAINT "crm_visits_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "crm_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_assignments" ADD CONSTRAINT "crm_assignments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_assignments" ADD CONSTRAINT "crm_assignments_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "crm_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_qualifications" ADD CONSTRAINT "crm_qualifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_qualifications" ADD CONSTRAINT "crm_qualifications_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "crm_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_language_tests" ADD CONSTRAINT "crm_language_tests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_language_tests" ADD CONSTRAINT "crm_language_tests_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "crm_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_guardians" ADD CONSTRAINT "crm_guardians_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_guardians" ADD CONSTRAINT "crm_guardians_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "crm_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_lead_fees" ADD CONSTRAINT "crm_lead_fees_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_lead_fees" ADD CONSTRAINT "crm_lead_fees_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "crm_leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crm_lead_fees" ADD CONSTRAINT "crm_lead_fees_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "crm_applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_questions" ADD CONSTRAINT "interview_questions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_questions" ADD CONSTRAINT "interview_questions_country_code_fkey" FOREIGN KEY ("country_code") REFERENCES "countries"("code_alpha2") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_questions" ADD CONSTRAINT "interview_questions_institution_id_fkey" FOREIGN KEY ("institution_id") REFERENCES "institutions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_attempts" ADD CONSTRAINT "interview_attempts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_attempts" ADD CONSTRAINT "interview_attempts_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_attempts" ADD CONSTRAINT "interview_attempts_institution_id_fkey" FOREIGN KEY ("institution_id") REFERENCES "institutions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_attempts" ADD CONSTRAINT "interview_attempts_country_code_fkey" FOREIGN KEY ("country_code") REFERENCES "countries"("code_alpha2") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_answers" ADD CONSTRAINT "interview_answers_attempt_id_fkey" FOREIGN KEY ("attempt_id") REFERENCES "interview_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_answers" ADD CONSTRAINT "interview_answers_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "interview_questions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

