# Enterprise Grade QA Review — Expert Panel Assessment

**Status:** `CONDITIONAL APPROVAL`
**Date:** 2026-08-02
**System:** Student Post-Visa Tracker (SPVT)
**Deployment Target:** Digital Ocean App Platform

---

## 1. Security & Compliance Review (Chief Information Security Officer)
*Assessment: "No compromises on data at rest and network boundaries."*

**Findings:**
- **[PASSED]** **Data-at-Rest Encryption:** Envelope encryption (AES-256-GCM) is implemented via KMS. Critical PII and documents are encrypted before hitting PostgreSQL or S3.
- **[PASSED]** **Network Isolation:** V2 MIS read-only ingestion utilizes the private VPC. TLS is strictly enforced with `rejectUnauthorized:true` (pinned CA).
- **[PASSED]** **Access Control:** Postgres RLS (Row Level Security) prevents cross-tenant data leakage. App refuses to boot if `DATABASE_URL` is a superuser. 
- **[PASSED]** **Malware Protection:** Hard requirement for ClamAV scanning on document upload is implemented. The system fails-closed (rejects uploads) if the scanner is unreachable.

**Enterprise Mandates (Pre-launch):**
- **Mandate 1:** `KMS_PROVIDER=local` is acceptable *only* if the host is strictly single-tenant and the DO App Platform environment variables are properly encrypted. For a true enterprise posture, migration to AWS KMS or HashiCorp Vault is required in Phase 2.
- **Mandate 2:** Ensure `spv_app` database role is strictly `NOSUPERUSER` and `NOBYPASSRLS`.

## 2. Infrastructure & Operations Review (Head of SRE)
*Assessment: "The system must survive instance restarts and network partitions without data loss."*

**Findings:**
- **[PASSED]** **Statelessness:** The document storage has been migrated from local ephemeral disk to S3 (Digital Ocean Spaces). Re-deploys will no longer result in document loss.
- **[PASSED]** **Multi-Replica Readiness:** Redis is configured for distributed rate-limiting and single-use download nonces. The backend can scale horizontally beyond `instance_count: 1`.
- **[PASSED]** **Migration Safety:** Schema migrations run as a `PRE_DEPLOY` job, guaranteeing DDL applies before the new application version boots.

**Enterprise Mandates (Pre-launch):**
- **Mandate 3:** ClamAV cannot reliably run as a sidecar in DO App Platform. It must be provisioned as an independent Droplet within the same VPC, and its private IP injected as `CLAMAV_HOST`.
- **Mandate 4:** Database backups (PITR) must be explicitly enabled on the Digital Ocean Managed Postgres cluster.

## 3. Architecture & Scalability Review (Principal Architect)
*Assessment: "The application must be observable and horizontally scalable."*

**Findings:**
- **[PASSED]** **Event Auditing:** Every sensitive action writes an append-only, cryptographically hashed audit log row.
- **[PASSED]** **Observability:** Prometheus metrics (`/metrics`) are exposed and gated by `METRICS_TOKEN`. Sentry integration is wired for exception tracking.

**Enterprise Mandates (Pre-launch):**
- **Mandate 5:** Ensure `SENTRY_DSN` and a valid `RESEND_API_KEY` are configured so operational alerts and user emails do not fail silently to the log stream.

---

## 4. Financial Operations (FinOps) Cost Analysis

The following is the estimated monthly run-rate for the baseline Enterprise-grade Digital Ocean deployment:

| Resource | Specification | Est. Monthly Cost |
| :--- | :--- | :--- |
| **App Platform (Backend)** | Basic Pro (1GB RAM) / 1 Instance | $ 12.00 |
| **App Platform (Frontend)** | Basic Pro (1GB RAM) / 1 Instance | $ 12.00 |
| **Managed PostgreSQL** | 1 Node / 1GB RAM / 10GB Storage | $ 15.00 |
| **Managed Redis** | 1 Node / 1GB RAM | $ 15.00 |
| **DO Spaces (S3)** | 250GB Storage / 1TB Outbound | $ 5.00 |
| **ClamAV Droplet** | Basic Droplet (2GB RAM) | $ 12.00 |
| **Email Delivery** | Resend (Basic Tier) | $ 0.00 (Free Tier) |
| **Observability** | Sentry (Developer Tier) | $ 0.00 (Free Tier) |
| **Total Estimated Cost** | **Production Baseline** | **$ 71.00 / mo** |

> **Lightweight Setup (For 2-5 users):** As per expert recommendations, you can safely drop the Redis instance and the ClamAV droplet for a highly-trusted small team by leaving their configuration variables empty. This drops the estimated cost to **$ 44.00 / mo**.

> **Scaling Costs:** As traffic increases, you can scale the Backend App Platform instances horizontally ($12/mo per additional instance, Redis required) and upgrade the PostgreSQL node ($30/mo for 2GB RAM).

---
**Panel Conclusion:** The system is cleared for deployment pending the execution of the Launch Checklist.
